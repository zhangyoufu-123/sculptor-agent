// Phase 3 双风格写作：逐节生成，注入 write/read 档案，遵守反 AI 硬规则。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chatWithRetry } from './llm.js';
import { WRITE_PROMPT, EXPAND_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import { styleSummary } from './outline.js';
import { buildStyleShot } from './style-memory.js';
import { latestStyleDirection } from './style.js';
import { genreBrief, genreToCategory } from './genre.js';
import { loadPersonalSkill } from './library.js';
import { loadStyleAdapter } from './style-adapter.js';
import { pulseAfterWrite, pushPulseToState } from './style-pulse.js';
import { snapshot } from './history.js';

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export async function writeSection(cfg, wsDir, { index = null, force = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const state = ws.readState(workspace);
  const outline = state.outline;
  if (!outline?.sections?.length) throw new Error('还没有大纲，先运行 sculptor outline');
  const targetWords = state.targetWords || cfg.targetWords;

  const sections = outline.sections;
  const start = index === null ? 0 : index;
  const end = index === null ? sections.length - 1 : index;
  const draftFile = path.join(workspace, 'draft.md');
  const existing = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') : '';
  // 退让协议：draft.md 若被用户/其他 agent 外部修改过，不静默覆盖；除非显式 --force。
  if (existing && state.lastDraftHash && fileHash(existing) !== state.lastDraftHash && !force) {
    throw new Error(
      'draft.md 在最后一次写作后被外部修改过，Sculptor 已退让、不覆盖。确认要重写请运行: sculptor write --force',
    );
  }
  snapshot(workspace, 'write');
  const parts = existing ? existing.split(/\n(?=## )/) : [];
  const report = [];
  let prevPulse = null;

  state.phase = 'write';
  for (let i = start; i <= end; i++) {
    const section = sections[i];
    const words = section.words || Math.round(targetWords / sections.length);
    const previousEnd = i > 0 ? sections[i - 1].heading : '';
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
      recentPulse: prevPulse
        ? `上一节「${prevPulse.section}」的风格脉搏建议：${prevPulse.suggestion || '（无）'}`
        : '',
    };
    const body = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是人类风格的写作者，输出正文。' },
        { role: 'user', content: WRITE_PROMPT(ctx) },
      ],
      { temperature: 0.85, maxTokens: 3000 },
    );
    let text = body.trim();
    let actual = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    let expanded = false;
    if (actual < words * 0.6) {
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
              styleShot: ctx.styleShot, // 扩写同样注入少样本，防止风格漂移
            }),
          },
        ],
        { temperature: 0.85, maxTokens: 4000 },
      );
      text = fixed.trim();
      actual = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      expanded = true;
    }
    parts[i] = `## ${section.heading}\n\n${text}\n`;
    const pulse = pulseAfterWrite(workspace, text, { section, index: i + 1, previous: prevPulse });
    prevPulse = pulse;
    pushPulseToState(state, pulse);
    report.push({
      index: i + 1,
      heading: section.heading,
      target: words,
      actual,
      expanded,
      pulse: pulse.score,
      pulseNote: pulse.suggestion || '',
    });
    state.summary = `正在写第 ${i + 1}/${sections.length} 节：${section.heading}`;
    state.nextStep = i < end ? `继续写第 ${i + 2} 节` : '写完后运行 sculptor redteam';
    ws.writeState(workspace, state);
  }
  fs.writeFileSync(draftFile, parts.join(''));
  const total = report.reduce((s, r) => s + r.actual, 0);
  state.lastDraftHash = fileHash(parts.join(''));
  state.summary = `全文完成：${sections.length} 节，实际 ${total} 字（目标 ${targetWords} 字）`;
  state.nextStep = '运行 sculptor redteam 做反 AI 审计';
  ws.writeState(workspace, state);
  ws.logContext(workspace, 'write', `完成 ${end - start + 1} 节，存至 ${draftFile}`);
  return {
    draftFile,
    sections: end - start + 1,
    report,
    total,
    hint: state.needsRestyle
      ? '检测到新的风格方向：可运行 sculptor restyle 让整篇按新方向重写'
      : '',
  };
}
