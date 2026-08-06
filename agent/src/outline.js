// Phase 2 大纲：素材门槛未过不准生成；产出结构化大纲 + 玻璃面板。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { OUTLINE_PROMPT } from './prompts.js';
import * as ws from './workspace.js';

export function styleSummary(file) {
  try {
    const obj = ws.readJson(file);
    const dims = obj.dimensions || obj.structure || {};
    return Object.entries(dims)
      .filter(([, d]) => d && (d.confidence || 0) >= 0.3)
      .map(([k, d]) => `${k}: ${d.value}（${(d.confidence * 100).toFixed(0)}%）`)
      .join('\n') || '（未采集）';
  } catch {
    return '（未采集）';
  }
}

export function gate(workspace) {
  const state = ws.readState(workspace);
  const missing = [];
  if (!state.confirmed?.topic) missing.push('主题');
  if (!state.confirmed?.stance) missing.push('立场/目的');
  if ((state.materials || []).length < 2) missing.push('具体素材（≥2条）');
  if (!state.confirmed?.theme) missing.push('核心立意');
  if ((state.confirmed?.arguments || []).length < 2) missing.push('支撑论点（≥2个）');
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
    targetWords: cfg.targetWords,
    materials: state.materials,
    writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
    readStyle: styleSummary(path.join(workspace, 'vault', 'read-style.json')),
  };
  const content = await chatWithRetry(cfg, [
    { role: 'system', content: '你是提纲设计师。输出严格 JSON。' },
    { role: 'user', content: OUTLINE_PROMPT(ctx) },
  ], { json: true, temperature: 0.7, maxTokens: 3000 });
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

  state.phase = 'plan';
  state.summary = `大纲已生成：${outline.sections.length} 节（立意+论点已挂载），目标 ${targetWords} 字`;
  state.targetWords = targetWords;
  state.nextStep = '确认大纲后运行 sculptor write';
  state.outline = outline;
  ws.writeState(workspace, state);
  const memoryFile = path.join(workspace, 'vault', 'project-memory', `outline-${Date.now()}.json`);
  fs.writeFileSync(memoryFile, JSON.stringify({ ...outline, generatedAt: ws.nowIso() }, null, 2) + '\n');
  return { outline, state, memoryFile };
}
