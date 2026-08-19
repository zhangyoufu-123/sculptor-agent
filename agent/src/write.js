// Phase 3 双风格写作：逐节生成，注入 write/read 档案，遵守反 AI 硬规则。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chatWithRetry } from './llm.js';
import { WRITE_PROMPT, EXPAND_PROMPT } from './prompts.js';
import { decodeSection } from './token-decode.js';
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
import {
  buildSearchQueries,
  requestHostSearch,
  parseDataNeed,
  unifiedBrief,
  queueAssetSearch,
} from './rag.js';
import { simulateCharacter } from './character.js';
import { academicNarrative, academicStyleNote } from './academic.js';
import { personaBrief } from './persona.js';
import { registerClues } from './consistency.js';
import { readAvoidance } from './avoidance.js';
import { readEditTransform } from './edit-transform.js';
import { governanceBrief } from './governance.js';

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** 风格约束（v1.1）：把从修改中学到的"作者删什么/加什么"作为生成时的硬约束注入，让算法真实影响输出。 */
function steeringBrief(workspace) {
  const av = readAvoidance(workspace);
  const et = readEditTransform(workspace);
  const avoid = Object.keys(av?.terms || {}).slice(0, 12);
  const add = Object.keys(et?.added || {}).slice(0, 8);
  const del = Object.keys(et?.deleted || {}).slice(0, 8);
  const lines = [];
  if (avoid.length) lines.push(`不要用这些词/句式（你过去亲手删过）：${avoid.join('、')}`);
  if (add.length) lines.push(`多用这些词/意象（你过去亲手改成过）：${add.join('、')}`);
  if (del.length) lines.push(`少用这些词（你删掉的连接词/套话）：${del.join('、')}`);
  return lines.length ? lines.join('\n') : '';
}

/** 分节写回安全网（v0.42 修复）：split(/\n(?=## )/) 会吃掉 ## 前的换行，
 *  逐节写回（导演每步写一节）时若直接 join，后一节标题会粘在上一节正文末尾，
 *  破坏分节结构（节奏曲线/伏笔校验/编辑全部受影响）。这里给每段补齐结尾换行。 */
function joinParts(parts) {
  return parts.map((p) => (p.endsWith('\n') ? p : `${p}\n`)).join('');
}

/** 动态提示词预算：注入块超预算时优先保风格适配卡，裁剪侧写与统一素材（防提示膨胀）。 */
function clipInjects(ctx, budget = 1500) {
  const len = (s) => (s || '').length;
  const total = len(ctx.styleAdapter) + len(ctx.persona) + len(ctx.unifiedBrief);
  if (total <= budget) return ctx;
  const over = total - budget;
  ctx.persona = ctx.persona ? ctx.persona.slice(0, Math.max(0, 420 - over)) : '';
  ctx.unifiedBrief = ctx.unifiedBrief ? ctx.unifiedBrief.slice(0, Math.max(0, 640 - over)) : '';
  return ctx;
}

/**
 * 检测成稿中仍带【素材不足】标注的节（回灌后自动重写的依据）。
 * 返回 [{heading, index}]，index 为 outline.sections 中的位置；定位不到时 index=null。
 */
export function detectDraftGaps(workspace) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  } catch {
    return [];
  }
  const state = ws.readState(workspace);
  const sections = state.outline?.sections || [];
  const gaps = [];
  for (const block of text.split(/\n(?=## )/)) {
    if (!/【素材不足/.test(block)) continue;
    const heading = (block.match(/^##\s+(.+)$/m) || [])[1]?.trim();
    if (!heading) continue;
    const index = sections.findIndex((s) => s.heading === heading);
    gaps.push({ heading, index: index >= 0 ? index : null });
  }
  return gaps;
}

export async function writeSection(cfg, wsDir, { index = null, force = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const state = ws.readState(workspace);
  const outline = state.outline;
  if (!outline?.sections?.length) throw new Error('还没有大纲，先运行 stylotrace outline');
  const targetWords = state.targetWords || cfg.targetWords;

  const sections = outline.sections;
  const start = index === null ? 0 : index;
  const end = index === null ? sections.length - 1 : index;
  const draftFile = path.join(workspace, 'draft.md');
  const existing = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') : '';
  // 退让协议：draft.md 若被用户/其他 agent 外部修改过，不静默覆盖；除非显式 --force。
  if (existing && state.lastDraftHash && fileHash(existing) !== state.lastDraftHash && !force) {
    throw new Error(
      'draft.md 在最后一次写作后被外部修改过，Stylotrace 已退让、不覆盖。确认要重写请运行: stylotrace write --force',
    );
  }
  snapshot(workspace, 'write');
  const parts = existing ? existing.split(/\n(?=## )/) : [];
  const report = [];
  let prevPulse = null;

  state.phase = 'write';
  // 联网资产补一次（once/会话、非阻塞）
  if (!state.assetSearchAsked && (state.confirmed?.topic || outline.title)) {
    state.assetSearchAsked = true;
    queueAssetSearch(
      workspace,
      `${outline.title || state.confirmed.topic} ${state.confirmed.genre || ''}`,
      { purpose: 'asset-search' },
    );
  }
  for (let i = start; i <= end; i++) {
    const section = sections[i];
    const words = section.words || Math.round(targetWords / sections.length);
    const previousEnd = i > 0 ? sections[i - 1].heading : '';
    // 小说/故事：先做角色预演（让角色自己反应），再把预测注入本节写作。
    let characterShot = '';
    if (/小说/.test(state.confirmed?.genre || '')) {
      const chars = state.confirmed?.characters || [];
      if (chars.length) {
        const pick =
          chars.find((c) =>
            `${section.heading || ''} ${(section.keyPoints || []).join(' ')} ${
              section.materials || []
            }`.includes(c.replace(/《|》/g, '')),
          ) || chars[i % chars.length];
        const sim = await simulateCharacter(cfg, workspace, {
          name: pick,
          scene: `${section.heading || ''}：${section.function || ''}（${
            (section.keyPoints || []).join('、') || '场景推进'
          }）`,
          obstacle: section.thesis || section.function || '出现了新的阻碍',
          clues: state.mystery?.clues || [],
        });
        if (sim.ok) {
          const p = sim.prediction;
          characterShot = `【角色预演：${sim.name}】\n心里想：${p.thoughts || '（沉默）'}\n会说出口：${p.speech || '（沉默）'}\n会做的动作：${p.action || '（不动）'}\n情绪：${p.mood || '复杂'}\n被场景推向：${p.nextPull || '下一步'}`;
        }
      }
    }
    const ctx = {
      title: outline.title || state.confirmed.topic,
      theme: state.confirmed?.theme || '',
      section,
      defaultWords: words,
      previousEnd,
      writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
      readStyle: styleSummary(path.join(workspace, 'vault', 'read-style.json')),
      styleShot: buildStyleShot(workspace, {
        topic: outline.title || state.confirmed.topic,
        genre: state.confirmed.genre || '',
        section,
      }),
      styleDirection: latestStyleDirection(workspace)?.phrase || '',
      genreBrief: genreBrief(state.confirmed?.genre || ''),
      personalSkill: loadPersonalSkill(workspace, {
        category: state.confirmed?.libraryCategory || genreToCategory(state.confirmed?.genre || ''),
      }),
      styleAdapter: loadStyleAdapter(workspace, 600),
      unifiedBrief: unifiedBrief(
        workspace,
        `${outline.title || ''} ${section.heading || ''} ${section.thesis || ''} ${section.function || ''}`,
      ),
      steering: steeringBrief(workspace),
      academicArc: /学术论文/.test(state.confirmed?.genre || '')
        ? academicNarrative(state)
        : '',
      academicStyleNote: /学术论文/.test(state.confirmed?.genre || '')
        ? academicStyleNote()
        : '',
      persona: personaBrief(workspace),
      governance: governanceBrief(workspace),
      characterShot,
      recentPulse: prevPulse
        ? `上一节「${prevPulse.section}」的风格脉搏建议：${prevPulse.suggestion || '（无）'}`
        : '',
    };
    const dec = await decodeSection(cfg, workspace, {
      messages: [
        { role: 'system', content: '你是人类风格的写作者，输出正文。' },
        { role: 'user', content: WRITE_PROMPT(clipInjects(ctx)) },
      ],
      temperature: 0.85,
      maxTokens: 3000,
      t: (i + 1) / Math.max(1, sections.length),
    });
    let text = dec.text;
    state.lastDecode = {
      section: section.heading,
      mode: dec.mode,
      reason: dec.reason || '',
      n: dec.n,
      breakdown: dec.breakdown || null,
      edits: dec.edits || [],
      before: dec.before || '',
      after: dec.text || '',
    };
    let actual = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    let expanded = false;
    let expandTries = 0;
    // 字数达标保障（v0.38）：低于目标 85% 必须扩写（提示词要求 ±15%）；最多扩两轮。
    while (actual < words * 0.85 && expandTries < 2) {
      const fixed = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是写作者，扩写本节。' },
          {
            role: 'user',
            content: EXPAND_PROMPT({
              heading: section.heading,
              function: section.function,
              target: words,
              actual,
              text,
              materials: section.materials || [],
              styleShot: ctx.styleShot, // 扩写同样注入少样本，防止风格漂移
              styleDirection: ctx.styleDirection, // 扩写延续方向，不回落到默认腔调
              writeStyle: ctx.writeStyle,
            }),
          },
        ],
        { temperature: 0.85, maxTokens: 4000 },
      );
      text = fixed.trim();
      actual = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      expanded = true;
      expandTries += 1;
    }
    // 实时取数：本节写后仍标注"素材不足" → 解析缺口、排队检索（每节最多一次）。
    let dataRequested = [];
    if (expanded) {
      const gaps = parseDataNeed(text);
      state.dataRequested = state.dataRequested || {};
      if (gaps.length && !state.dataRequested[i]) {
        const queries = buildSearchQueries(
          `${outline.title || ''} ${section.heading || ''} ${gaps.join(' ')}`,
          { topic: state.confirmed?.topic || '', limit: 4 },
        );
        if (queries.length) {
          const req = requestHostSearch(workspace, queries, { purpose: 'write-gap' });
          state.dataRequested[i] = { queries, queued: req.queued };
          dataRequested = queries;
        }
      }
    }
    parts[i] = `## ${section.heading}\n\n${text}\n`;
    const pulse = pulseAfterWrite(workspace, text, { section, index: i + 1, previous: prevPulse });
    // 伏笔记账（v0.41）：小说/推理每节自动记账，供交付前跨章回收校验（静默，不打扰用户）。
    let clueNote = '';
    if (/小说|推理|故事/.test(state.confirmed?.genre || '')) {
      try {
        const rc = await registerClues(cfg, workspace, {
          text,
          heading: section.heading,
          sectionIndex: i,
        });
        if (rc.added > 0) {
          state.mystery = state.mystery || {};
          state.mystery.clues = rc.clues;
          clueNote = `（伏笔 ${rc.added} 条已记账）`;
        }
      } catch {
        clueNote = '';
      }
    }
    await refreshStyleVector(cfg, workspace, { text, kind: 'write', evidence: `第 ${i + 1} 节` });
    prevPulse = pulse;
    pushPulseToState(state, pulse);
    report.push({
      index: i + 1,
      heading: section.heading,
      target: words,
      actual,
      expanded,
      decodeMode: dec.mode,
      decodeReason: dec.reason || '',
      dataRequested,
      pulse: pulse.score,
      pulseNote: pulse.suggestion || '',
      clueNote,
    });
    state.summary = `正在写第 ${i + 1}/${sections.length} 节：${section.heading}`;
    state.nextStep = i < end ? `继续写第 ${i + 2} 节` : '写完后运行 stylotrace redteam';
    ws.writeState(workspace, state);
  }
  const joined = joinParts(parts);
  fs.writeFileSync(draftFile, joined);
  // 字数按全文统计（导演逐节调用时，report 只覆盖本次写的节）。
  const total =
    (fs.readFileSync(draftFile, 'utf8').match(/[\u4e00-\u9fff]/g) || []).length;
  const wordsOk = total >= targetWords * 0.85;
  state.lastDraftHash = fileHash(joined);
  state.lastWriteAt = ws.nowIso(); // 供"回灌后自动重写缺口节"判断时序
  state.quality = state.quality || {};
  state.quality.words = { actual: total, target: targetWords, ok: wordsOk };
  state.summary = `全文完成：${sections.length} 节，实际 ${total} 字（目标 ${targetWords} 字）${
    wordsOk ? '' : '（字数未达标，可运行 stylotrace write 或说"再详细点"补齐）'
  }`;
  state.nextStep = '运行 stylotrace redteam 做反 AI 审计';
  ws.writeState(workspace, state);
  ws.logContext(workspace, 'write', `完成 ${end - start + 1} 节，存至 ${draftFile}`);
  return {
    draftFile,
    sections: end - start + 1,
    report,
    total,
    dataRequested: report.flatMap((r) => r.dataRequested || []),
    hint: state.needsRestyle
      ? '检测到新的风格方向：可运行 stylotrace restyle 让整篇按新方向重写'
      : '',
  };
}
