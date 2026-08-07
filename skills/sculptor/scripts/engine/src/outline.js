// Phase 2 大纲：素材门槛未过不准生成；产出结构化大纲 + 玻璃面板。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { OUTLINE_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import { buildStyleShot } from './style-memory.js';
import { latestStyleDirection } from './style.js';
import { genreBrief, genreToCategory, isOfficialGenre } from './genre.js';
import { contentBudget } from './budget.js';
import { loadPersonalSkill } from './library.js';
import { loadStyleAdapter } from './style-adapter.js';
import { reviewOutline } from './outline-review.js';
import { pulseAfterOutline, pushPulseToState } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';

export function styleSummary(file) {
  try {
    const obj = ws.readJson(file);
    const dims = obj.dimensions || obj.structure || {};
    return (
      Object.entries(dims)
        .filter(([, d]) => d && (d.confidence || 0) >= 0.3)
        .map(([k, d]) => `${k}: ${d.value}（${(d.confidence * 100).toFixed(0)}%）`)
        .join('\n') || '（未采集）'
    );
  } catch {
    return '（未采集）';
  }
}

export function gate(workspace) {
  const state = ws.readState(workspace);
  const missing = [];
  if (!state.confirmed?.topic) missing.push('主题');
  const g = state.confirmed?.genre || '';
  if (!state.confirmed?.targetWords) missing.push('目标字数');
  const b = contentBudget({
    genre: g,
    targetWords: Number(state.confirmed?.targetWords) || 0,
  });
  const official = isOfficialGenre(g);
  const argumentative = ['议论文', '学术论文', '报告'].includes(g);
  if (official) {
    // 公文系：问"事项/主送/依据"，不问立意/论点/情感。
    const hasItems =
      (state.confirmed?.items || []).length > 0 || (state.materials || []).length > 0;
    if (!hasItems) missing.push('事项/素材');
    if (!state.confirmed?.basis && !state.confirmed?.stance) missing.push('依据/缘由');
  } else {
    if (!state.confirmed?.stance) missing.push('立场/目的');
    if ((state.materials || []).length < b.materialsMin)
      missing.push(`具体素材（≥${b.materialsMin}条）`);
    if (!state.confirmed?.theme) missing.push('核心立意');
    // 散文/小说/演讲稿不强制"支撑论点"——只有议论文/学术/报告要。
    if (argumentative && (state.confirmed?.arguments || []).length < b.argumentsMin)
      missing.push(`支撑论点（≥${b.argumentsMin}个）`);
  }
  return { ok: missing.length === 0, missing, state };
}

export async function generateOutline(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const { ok, missing, state } = gate(workspace);
  if (!ok) {
    throw new Error(`素材门槛未过，缺少: ${missing.join('、')}。请先运行 sculptor clarify。`);
  }
  const ctx = {
    genre: state.confirmed.genre || '',
    topic: state.confirmed.topic,
    theme: state.confirmed.theme,
    stance: state.confirmed.stance,
    arguments: state.confirmed.arguments || [],
    audience: state.confirmed.audience,
    targetWords: Number(state.confirmed?.targetWords) || cfg.targetWords,
    budget: contentBudget({
      genre: state.confirmed?.genre || '',
      targetWords: Number(state.confirmed?.targetWords) || cfg.targetWords,
    }),
    materials: state.materials,
    writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
    readStyle: styleSummary(path.join(workspace, 'vault', 'read-style.json')),
    styleShot: buildStyleShot(workspace, {
      topic: state.confirmed.topic,
      genre: state.confirmed.genre || '',
    }),
    corrections: state.blueprint?.corrections || [],
    styleDirection: latestStyleDirection(workspace)?.phrase || '',
    genreBrief: genreBrief(state.confirmed?.genre || ''),
    personalSkill: loadPersonalSkill(workspace, {
      category: state.confirmed?.libraryCategory || genreToCategory(state.confirmed?.genre || ''),
    }),
    styleAdapter: loadStyleAdapter(workspace, 600),
  };
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是提纲设计师。输出严格 JSON。' },
      { role: 'user', content: OUTLINE_PROMPT(ctx) },
    ],
    { json: true, temperature: 0.7, maxTokens: 3000 },
  );
  const outline = parseJsonContent(content, '大纲');
  if (!outline.sections?.length) throw new Error('大纲缺少 sections');
  const total = outline.sections.reduce((s, x) => s + Number(x.words || 0), 0);
  const targetWords = total > 0 ? total : cfg.targetWords;
  const perSection = Math.round(targetWords / outline.sections.length);
  for (const s of outline.sections) {
    s.words = Number(s.words) > 0 ? Number(s.words) : perSection;
    if (!s.thesis) {
      const args = state.confirmed?.arguments || [];
      s.thesis = args.length ? args[outline.sections.indexOf(s) % args.length] : s.function;
    }
  }

  // 大纲评审-修订回路：低分且有 LLM 修订版时自动替换（用户仍需最终确认）。
  // 确定性兜底时 revised=false，大纲保持原样，流程永不因评审而中断。
  const review = await reviewOutline(cfg, workspace, { outline });
  if (review.revised) {
    outline.sections = review.outline.sections;
    outline.title = review.outline.title || outline.title;
    outline.reviewed = true;
  }
  state.outlineReviews = state.outlineReviews || [];
  state.outlineReviews.push({
    ts: ws.nowIso(),
    score: review.report.score,
    mode: review.report.mode,
    issues: (review.report.issues || []).map((i) => i.issue).slice(0, 4),
    revised: review.revised,
  });
  if (state.outlineReviews.length > 5) state.outlineReviews = state.outlineReviews.slice(-5);

  state.phase = 'plan';
  state.summary = `大纲已生成：${outline.sections.length} 节（立意+论点已挂载），目标 ${targetWords} 字`;
  if (review.revised) state.summary += '（已按内部评审自动微调）';
  const pulse = pulseAfterOutline(workspace, outline);
  pushPulseToState(state, pulse);
  await refreshStyleVector(cfg, workspace, {
    text: outline.sections
      .map((s) => `${s.heading || ''} ${s.thesis || ''} ${(s.keyPoints || []).join(' ')}`)
      .join(' '),
    kind: 'outline',
    evidence: '大纲生成',
  });
  if (pulse.suggestion) state.summary += `（大纲脉搏建议：${pulse.suggestion}）`;
  state.targetWords = targetWords;
  state.nextStep = '确认大纲后运行 sculptor write';
  state.outline = outline;
  // 修正已吸收进大纲，清空避免后续重写重复应用
  if (state.blueprint) state.blueprint.corrections = [];
  ws.writeState(workspace, state);
  const memoryFile = path.join(workspace, 'vault', 'project-memory', `outline-${Date.now()}.json`);
  fs.writeFileSync(
    memoryFile,
    JSON.stringify({ ...outline, generatedAt: ws.nowIso() }, null, 2) + '\n',
  );
  return { outline, state, memoryFile };
}
