// 风格重写：用户给出新的风格方向后，把整篇草稿（或指定节）按新方向重写。
// 保留大纲结构、论点与素材，只换表达；重写前后都走退让协议，绝不覆盖外部修改。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chatWithRetry } from './llm.js';
import { RESTYLE_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import { styleSummary } from './outline.js';
import { buildStyleShot } from './style-memory.js';
import { latestStyleDirection, applyStyleDirection } from './style.js';
import { genreBrief, genreToCategory } from './genre.js';
import { loadPersonalSkill } from './library.js';
import { loadStyleAdapter } from './style-adapter.js';

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * 按风格方向重写草稿。
 * @param direction 新方向一句话（如"更克制一点"）；缺省取档案里最近一条 styleDirections。
 * @param section 只重写第 N 节（0-based）；null 表示全文。
 */
export async function restyle(cfg, wsDir, { direction = '', section = null, force = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) throw new Error('没有 draft.md，先运行 sculptor write');
  const state = ws.readState(workspace);
  const outline = state.outline;
  if (!outline?.sections?.length)
    throw new Error('没有大纲，无法分节重写（先运行 sculptor outline）');
  const existing = fs.readFileSync(draftFile, 'utf8');
  // 退让协议：draft 被用户/其他 agent 外部修改过 → 不覆盖，除非显式 --force。
  if (state.lastDraftHash && fileHash(existing) !== state.lastDraftHash && !force) {
    throw new Error(
      'draft.md 在最后一次写作后被外部修改过，Sculptor 已退让、不覆盖。确认要重写请运行: sculptor restyle --force',
    );
  }
  const stored = latestStyleDirection(workspace);
  const dirText = String(direction || '').trim() || stored?.phrase || '';
  if (!dirText) {
    throw new Error(
      '没有可用的风格方向：请用 --direction 给出一句话（如"更克制一点"），或先在对话里告诉 AI 你想怎么改',
    );
  }
  // 命令行给的方向也记入风格档案（与对话里说"更克制"等价）。
  if (direction.trim() && stored?.phrase !== dirText) applyStyleDirection(workspace, dirText);

  let parts = existing.split(/\n(?=## )/);
  let sections = outline.sections;
  if (parts.length !== sections.length) {
    // 结构不匹配（例如被红队整体修订后丢了 ## 分节）→ 降级为整篇一次重写，不阻塞流程。
    parts = [existing];
    sections = [
      { heading: '全文', function: '整体重写', thesis: '', words: state.targetWords || 1000 },
    ];
  }
  const fallbackWhole = sections.length === 1 && parts[0] === existing;
  const start = fallbackWhole || section === null ? 0 : section;
  const end = fallbackWhole || section === null ? sections.length - 1 : section;
  const report = [];
  state.phase = 'write';
  state.summary = `正在按新风格重写：${dirText}`;
  state.nextStep = end > start ? `继续重写第 ${start + 2} 节` : '重写完成后运行 sculptor redteam';
  ws.writeState(workspace, state);

  for (let i = start; i <= end; i++) {
    const s = sections[i];
    const heading = s.heading;
    const body = parts[i]?.replace(/^## .*\n\n/, '')?.trim() || '';
    if (!body) {
      report.push({ index: i + 1, heading, skipped: true });
      continue;
    }
    const ctx = {
      heading,
      function: s.function,
      thesis: s.thesis,
      words: s.words,
      direction: dirText,
      writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
      styleShot: buildStyleShot(workspace, {
        topic: outline.title || state.confirmed?.topic || '',
        genre: state.confirmed?.genre || '',
        section: s,
      }),
      genreBrief: genreBrief(state.confirmed?.genre || ''),
      personalSkill: loadPersonalSkill(workspace, {
        category: state.confirmed?.libraryCategory || genreToCategory(state.confirmed?.genre || ''),
      }),
      styleAdapter: loadStyleAdapter(workspace, 600),
      text: body,
    };
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是按用户风格方向重写正文的改写者，只输出正文。' },
        { role: 'user', content: RESTYLE_PROMPT(ctx) },
      ],
      { temperature: 0.8, maxTokens: 3500 },
    );
    const rewritten = content.trim();
    const oldLen = (body.match(/[\u4e00-\u9fff]/g) || []).length;
    const newLen = (rewritten.match(/[\u4e00-\u9fff]/g) || []).length;
    parts[i] = `## ${heading}\n\n${rewritten}\n`;
    report.push({ index: i + 1, heading, oldLen, newLen });
    state.summary = `已按新风格重写第 ${i + 1}/${sections.length} 节：${heading}`;
    state.nextStep = i < end ? `继续重写第 ${i + 2} 节` : '重写完成，运行 sculptor redteam 复查';
    ws.writeState(workspace, state);
  }

  fs.writeFileSync(draftFile, parts.join(''));
  state.lastDraftHash = fileHash(parts.join(''));
  state.needsRestyle = false;
  state.lastRestyleAt = ws.nowIso();
  state.summary = `全文已按新风格重写：${dirText}`;
  state.nextStep = '运行 sculptor redteam 做反 AI 审计';
  ws.writeState(workspace, state);
  ws.logContext(workspace, 'restyle', `按「${dirText}」重写 ${end - start + 1} 节 → ${draftFile}`);
  return { draftFile, direction: dirText, sections: end - start + 1, report };
}
