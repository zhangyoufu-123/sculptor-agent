// 翻译/回译校验（v0.32）：翻译的本质是"同一件事用两种语言说清楚"。
// 利用翻译前后"内容对齐、风格不同"的性质：
//   1) 内容分析：提取必须保留的信息点（专名/数字/论断/意象）
//   2) 中译英（直译，不润色）
//   3) 英译中（忠实回译）
//   4) 信息点核对：回译丢了/漂移了什么 → 内容保真审计
//   5) 风格对比：原文 vs 回译文（同为中文）用人类化指标对比 → 风格层信号
// 整条链路 LLM 不可用时全部确定性兜底，绝不中断写作流程。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { humanMetrics } from './experiment.js';
import { readVector, vectorSummary } from './style-vector.js';

export const RT_MARKERS = {
  key: '【内容要点提取】',
  fwd: '【中译英】',
  back: '【英译中】',
  judge: '【信息点核对】',
};

const BLACKLIST = [
  '在当今社会', '随着', '近年来', '众所周知', '毋庸置疑', '不可否认',
  '值得注意的是', '不难发现', '事实上', '总而言之', '底层逻辑', '赋能',
];

function fallbackKeyPoints(text) {
  const sentences = text
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  return sentences
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
    .map((s) => s.slice(0, 60));
}

/** 确定性信息点核对：每个信息点取前 6 个非空白字符作锚，回译文里查得到即保留。 */
function deterministicFidelity(keyPoints, src, back) {
  const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?；;：:""''「」『』（）()]/g, '');
  const backNorm = norm(back);
  const kept = [];
  const lost = [];
  for (const kp of keyPoints) {
    const anchor = norm(kp).slice(0, 6);
    if (anchor && backNorm.includes(anchor)) kept.push(kp);
    else lost.push(kp);
  }
  return { kept, lost, drifted: [], hint: '确定性核对（LLM 判定不可用）' };
}

function simpleMetrics(text) {
  const m = humanMetrics(text);
  return {
    sentenceLengthStddev: m.sentenceLengthStddev,
    paragraphCv: m.paragraphCv,
    sentenceStartDedup: m.sentenceStartDedup,
    bigramTtr: m.bigramTtr,
    blacklistHits: m.blacklistHits,
    repeatedMetaphors: m.repeatedMetaphors,
    repeatedPatterns: m.repeatedPatterns,
  };
}

function styleNotes(a, b) {
  const notes = [];
  if (!b) return notes;
  const delta = (x, y) => Math.abs(Number(x || 0) - Number(y || 0));
  if (delta(a.sentenceLengthStddev, b.sentenceLengthStddev) > 5) {
    notes.push(`句长节奏改变明显（σ ${a.sentenceLengthStddev} → ${b.sentenceLengthStddev}）`);
  }
  if (delta(a.bigramTtr, b.bigramTtr) > 0.15) {
    notes.push(`词汇密度改变明显（TTR ${a.bigramTtr} → ${b.bigramTtr}）`);
  }
  if (a.blacklistHits !== b.blacklistHits) {
    notes.push(`AI 套话数量变化（${a.blacklistHits} → ${b.blacklistHits}）`);
  }
  return notes;
}

/**
 * 翻译/回译校验主流程。
 * @param text 待校验文本；缺省读工作区 draft.md
 * @param file 显式文件路径（优先）
 */
export async function roundtripCheck(cfg, wsDir, { text, file } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  let src = text;
  if (!src && file) src = fs.readFileSync(path.resolve(file), 'utf8');
  if (!src && fs.existsSync(path.join(workspace, 'draft.md'))) {
    src = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  }
  src = String(src || '').trim();
  if (!src) throw new Error('没有可校验的文本：传 text/file，或工作区里已有 draft.md');

  // 1) 内容分析
  let keyPoints = [];
  try {
    const kp = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是翻译校对的内容分析师。只输出严格 JSON。' },
        {
          role: 'user',
          content: `${RT_MARKERS.key}\n从下面的原文里提取必须保留的信息点（专名/数字/论断/关键意象），每点一句话：\n\n${src.slice(0, 3000)}`,
        },
      ],
      { json: true, temperature: 0.2, maxTokens: 800 },
    );
    const parsed = parseJsonContent(kp, '信息点');
    keyPoints = Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map((k) => (typeof k === 'string' ? k : k?.point || '')).filter(Boolean).slice(0, 12)
      : [];
  } catch {
    keyPoints = fallbackKeyPoints(src);
  }
  if (!keyPoints.length) keyPoints = fallbackKeyPoints(src);

  // 2) 中译英（直译）
  let forward = '';
  try {
    forward = (
      await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是忠实直译官。只做直译，不润色、不增删信息。只输出译文。' },
          { role: 'user', content: `${RT_MARKERS.fwd}\n${src.slice(0, 3000)}` },
        ],
        { temperature: 0.3, maxTokens: 2500 },
      )
    ).trim();
  } catch {
    forward = '';
  }

  // 3) 英译中（忠实回译）
  let back = '';
  if (forward) {
    try {
      back = (
        await chatWithRetry(
          cfg,
          [
            { role: 'system', content: '你是忠实回译官。把英文忠实译回中文，不增删信息。只输出译文。' },
            { role: 'user', content: `${RT_MARKERS.back}\n${forward.slice(0, 3000)}` },
          ],
          { temperature: 0.3, maxTokens: 2500 },
        )
      ).trim();
    } catch {
      back = '';
    }
  }

  // 4) 内容保真核对
  let content = { kept: [], lost: [], drifted: [], hint: '' };
  if (forward && back) {
    try {
      const j = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是翻译校对员。只输出严格 JSON。' },
          {
            role: 'user',
            content: `${RT_MARKERS.judge}\n对照信息点，逐点核对回译是否保留：\n信息点：${JSON.stringify(keyPoints)}\n\n原文：${src.slice(0, 2000)}\n\n回译：${back.slice(0, 2000)}\n\n输出 {"kept":["..."],"lost":["..."],"drifted":["..."]}`,
          },
        ],
        { json: true, temperature: 0.2, maxTokens: 800 },
      );
      const p = parseJsonContent(j, '核对');
      content = {
        kept: Array.isArray(p.kept) ? p.kept : [],
        lost: Array.isArray(p.lost) ? p.lost : [],
        drifted: Array.isArray(p.drifted) ? p.drifted : [],
        hint: '',
      };
    } catch {
      content = deterministicFidelity(keyPoints, src, back);
    }
  } else {
    content.hint = '翻译未完成（LLM 不可用），跳过信息点核对';
  }

  // 5) 风格对比：原文 vs 回译文（同为中文）
  const style = { original: null, back: null, notes: [] };
  try {
    style.original = simpleMetrics(src);
    if (back) style.back = simpleMetrics(back);
    style.notes = styleNotes(style.original, style.back);
  } catch {
    style.notes = ['风格指标计算失败'];
  }

  let styleVector = null;
  try {
    if (readVector(workspace)) styleVector = vectorSummary(workspace) || null;
  } catch {}

  const lostN = content.lost.length + content.drifted.length;
  return {
    source: file ? path.basename(file) : 'draft.md',
    chars: src.length,
    keyPoints,
    forward,
    back,
    content,
    style,
    styleVector,
    verdict: lostN === 0 ? 'pass' : 'attention',
  };
}

export function renderRoundtrip(r) {
  const lines = [];
  lines.push(`《${r.source}》翻译/回译校验（${r.chars} 字）`);
  lines.push(`信息点 ${r.keyPoints.length} 条：${r.keyPoints.slice(0, 6).join('；')}`);
  if (r.forward) lines.push(`\n【英译】${r.forward.slice(0, 220)}${r.forward.length > 220 ? '…' : ''}`);
  if (r.back) lines.push(`\n【回译】${r.back.slice(0, 220)}${r.back.length > 220 ? '…' : ''}`);
  const c = r.content;
  lines.push(
    `\n内容保真：保留 ${c.kept.length} · 丢失 ${c.lost.length} · 漂移 ${c.drifted.length}${c.hint ? `（${c.hint}）` : ''}`,
  );
  if (c.lost.length) lines.push(`丢失：${c.lost.join('；')}`);
  if (c.drifted.length) lines.push(`漂移：${c.drifted.join('；')}`);
  if (r.style.original) {
    const a = r.style.original;
    const b = r.style.back;
    lines.push(
      `\n风格对比：句长σ ${a.sentenceLengthStddev}→${b?.sentenceLengthStddev ?? '—'} · 句首去重 ${a.sentenceStartDedup}%→${b?.sentenceStartDedup ?? '—'}% · TTR ${a.bigramTtr}→${b?.bigramTtr ?? '—'} · 套话 ${a.blacklistHits}→${b?.blacklistHits ?? '—'}`,
    );
    if (r.style.notes.length) lines.push(`注意：${r.style.notes.join('；')}`);
  }
  if (r.styleVector) {
    const v = r.styleVector;
    const dims = (v.topDims || [])
      .map((d) => d.label || d.key || '')
      .filter(Boolean)
      .slice(0, 4)
      .join('/');
    lines.push(
      `\n用户风格向量：信号 ${v.signals || 0} · 偏好对 ${v.preferencePairs || 0}${dims ? ` · 维度 ${dims}` : ''}`,
    );
  }
  lines.push(r.verdict === 'pass' ? '\n结论：信息完整、风格稳定' : '\n结论：需要修订（信息有丢失或漂移）');
  return lines.join('\n');
}
