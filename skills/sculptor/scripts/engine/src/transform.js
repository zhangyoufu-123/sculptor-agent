// 一键改写矩阵：扩写 / 缩写 / 续写 / 仿写 / 润色 / 改语气。
// 复用 restyle 的"分节改写 + 退让协议"引擎模式（独立实现，避免耦合改动），
// 每个预设只换提示词与字数目标；改写前后各记录一次快照，永不覆盖外部修改。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chatWithRetry } from './llm.js';
import * as ws from './workspace.js';
import { styleSummary } from './outline.js';
import { buildStyleShot } from './style-memory.js';
import { latestStyleDirection } from './style.js';
import { genreBrief, genreToCategory } from './genre.js';
import { loadPersonalSkill } from './library.js';
import { loadStyleAdapter } from './style-adapter.js';
import { pulseAfterWrite, pushPulseToState } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';
import { snapshot } from './history.js';

export const PRESETS = {
  expand: {
    label: '扩写',
    hint: '补充具体细节、场景、数据、引文与论证推进，篇幅增加约 50%，保持立意、风格与结构功能不变',
    ratio: 1.5,
    mode: 'rewrite',
  },
  condense: {
    label: '缩写',
    hint: '保留核心论点与关键素材，删冗余铺垫与重复表达，篇幅压缩（默认 50%，可用 --target 指定目标字数）',
    ratio: 0.5,
    mode: 'rewrite',
  },
  continue: {
    label: '续写',
    hint: '在现有内容之后自然续写，不重复已有内容，延续立意与风格，与上一节自然衔接',
    ratio: 1,
    mode: 'append',
  },
  polish: {
    label: '润色',
    hint: '通篇润色：改掉拗口、重复、冗余与错漏，保持作者风格、内容与结构不变',
    ratio: 1,
    mode: 'rewrite',
  },
  imitate: {
    label: '仿写',
    hint: '按风格档案与旧稿彻底重写表达，只保留论点与素材，让文字更像作者本人',
    ratio: 1,
    mode: 'rewrite',
  },
  tone: {
    label: '改语气',
    hint: '按目标语气重写：formal 书面正式 / casual 口语自然 / warm 温暖亲切 / authoritative 笃定有力',
    ratio: 1,
    mode: 'rewrite',
  },
  classical: {
    label: '古文风',
    hint: '把现代文改写为文言/半文白风格：典雅凝练，保留原意与细节，不生造晦涩字词',
    ratio: 1,
    mode: 'rewrite',
  },
  desensitize: {
    label: '脱敏改写',
    hint: '把真实经历/真实人名地名机构改写为虚构，保留情感内核与细节质感，适合公开发布',
    ratio: 1,
    mode: 'rewrite',
  },
};

export const TONES = ['formal', 'casual', 'warm', 'authoritative'];

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function presetCtx(cfg) {
  return {
    preset: cfg.preset,
    tone: cfg.tone || '',
    targetWords: cfg.targetWords || 0,
  };
}

const TRANSFORM_PROMPT = (ctx) => `你是 Stylotrace 的预设改写者。把下面的文稿按【预设】改写。

【预设】${ctx.preset.hint}
${ctx.tone ? `【目标语气】${ctx.tone}` : ''}
${ctx.targetWords ? `【本节目标字数】约 ${ctx.targetWords} 字（中文字符）` : ''}
【本节】${ctx.heading}（功能：${ctx.function || ''}${ctx.thesis ? `；论点：${ctx.thesis}` : ''}）
${ctx.writeStyle ? `【写作风格档案】${ctx.writeStyle}` : ''}
${ctx.styleShot ? ctx.styleShotText : ''}
${ctx.genreBrief ? `【文体范式（公式化内容按此产出）】\n${ctx.genreBrief}` : ''}
${ctx.personalSkill ? `【这类文体你个人的写法（蒸馏自你的旧作）】\n${ctx.personalSkill}` : ''}
${ctx.styleAdapter ? `【风格适配卡（最高优先级）】\n${ctx.styleAdapter}` : ''}
【原文】
${ctx.text}

要求：
1. 保留立意、论点与素材；不删掉关键事实与引文。
2. 黑名单禁用：在当今社会/随着/近年来/众所周知/值得注意的是/总而言之/赋能 等一律不用。
3. 同一个比喻只允许出现一次；"虽然…但是""不是…而是"不重复使用。
4. 只输出改写后的正文（不要标题、不要解释）。`;

/**
 * 一键改写：按预设重写整篇（或指定节）。与 restyle 相同退让协议：draft 被外部修改则不覆盖。
 * @param preset 见 PRESETS（如 'polish'、'tone:formal'）。
 */
export async function transform(
  cfg,
  wsDir,
  { preset = 'polish', tone = '', target = 0, section = null, force = false } = {},
) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) throw new Error('没有 draft.md，先运行 sculptor write');
  const state = ws.readState(workspace);
  const outline = state.outline;
  if (!outline?.sections?.length) {
    throw new Error('没有大纲，无法分节改写（先运行 sculptor outline）');
  }
  const existing = fs.readFileSync(draftFile, 'utf8');
  if (state.lastDraftHash && fileHash(existing) !== state.lastDraftHash && !force) {
    throw new Error(
      'draft.md 在最后一次写作后被外部修改过，Stylotrace 已退让、不覆盖。确认要改写请运行: sculptor transform --force',
    );
  }
  const [presetName, tonePart] = String(preset).split(':');
  const p = PRESETS[presetName];
  if (!p) throw new Error(`未知预设「${presetName}」。可用: ${Object.keys(PRESETS).join(' / ')}`);
  const toneTarget = tone || (tonePart && TONES.includes(tonePart) ? tonePart : '');
  snapshot(workspace, `transform-${presetName}`);

  const totalCurrent = (existing.match(/[\u4e00-\u9fff]/g) || []).length;
  const ratio =
    target > 0 ? Math.max(0.4, Math.min(2.5, target / Math.max(1, totalCurrent))) : p.ratio;

  let parts = existing.split(/\n(?=## )/);
  let sections = outline.sections;
  if (parts.length !== sections.length) {
    parts = [existing];
    sections = [{ heading: '全文', function: '整体改写', thesis: '', words: totalCurrent }];
  }
  const fallbackWhole = sections.length === 1 && parts[0] === existing;
  const start = fallbackWhole || section === null ? 0 : section;
  const end = fallbackWhole || section === null ? sections.length - 1 : section;
  const report = [];
  const pulses = [];

  state.phase = 'write';
  state.summary = `正在${p.label}全文（${presetName}）`;
  ws.writeState(workspace, state);

  for (let i = start; i <= end; i++) {
    const s = sections[i];
    const heading = s.heading;
    const body = parts[i]?.replace(/^## .*\n\n/, '')?.trim() || '';
    if (!body && p.mode !== 'append') {
      report.push({ index: i + 1, heading, skipped: true });
      continue;
    }
    const wordsTarget = Math.max(
      60,
      Math.round((Number(s.words) || totalCurrent / Math.max(1, sections.length)) * ratio),
    );
    const shot = buildStyleShot(workspace, {
      topic: outline.title || state.confirmed?.topic || '',
      genre: state.confirmed?.genre || '',
      section: s,
    });
    const prompt = TRANSFORM_PROMPT({
      ...presetCtx({ preset: p, tone: toneTarget, targetWords: wordsTarget }),
      heading,
      function: s.function,
      thesis: s.thesis,
      writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
      styleShotText: shot ? JSON.stringify(shot).slice(0, 1200) : '',
      genreBrief: genreBrief(state.confirmed?.genre || ''),
      personalSkill: loadPersonalSkill(workspace, {
        category: state.confirmed?.libraryCategory || genreToCategory(state.confirmed?.genre || ''),
      }),
      styleAdapter: loadStyleAdapter(workspace, 600),
      text: body,
    });
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是预设改写者，只输出正文。' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.8, maxTokens: 4000 },
    );
    const rewritten = content.trim();
    if (p.mode === 'append') {
      const newHeading = `## 续写（${p.label}）`;
      parts[parts.length - 1] = `${parts[parts.length - 1].trimEnd()}\n\n${newHeading}\n\n${rewritten}\n`;
    } else {
      parts[i] = `## ${heading}\n\n${rewritten}\n`;
    }
    const oldLen = (body.match(/[\u4e00-\u9fff]/g) || []).length;
    const newLen = (rewritten.match(/[\u4e00-\u9fff]/g) || []).length;
    const pulse = pulseAfterWrite(workspace, rewritten, { section: s, index: i + 1 });
    await refreshStyleVector(cfg, workspace, { text: rewritten, kind: 'transform', evidence: `${p.label}改写` });
    pushPulseToState(state, pulse);
    pulses.push(pulse);
    report.push({ index: i + 1, heading, oldLen, newLen, target: wordsTarget });
    state.summary = `已${p.label}第 ${i + 1}/${sections.length} 节：${heading}`;
    ws.writeState(workspace, state);
  }

  fs.writeFileSync(draftFile, parts.join(''));
  state.lastDraftHash = fileHash(parts.join(''));
  state.lastTransformAt = ws.nowIso();
  state.summary = `全文已${p.label}（${presetName}）`;
  state.nextStep = '运行 sculptor redteam 复查，或继续修改';
  ws.writeState(workspace, state);
  ws.logContext(workspace, 'transform', `${p.label}（${presetName}${toneTarget ? ':' + toneTarget : ''}）${end - start + 1} 节 → ${draftFile}`);
  return { draftFile, preset: presetName, tone: toneTarget, sections: end - start + 1, report };
}
