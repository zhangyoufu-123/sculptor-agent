#!/usr/bin/env node
// Stylotrace 翻译官 · 回译校验（独立脚本，零依赖，Node >=18）
// 翻译的本质：同一件事用两种语言说清楚。用回译核对信息是否丢失，用指标对比风格是否漂移。
//
// 用法:
//   node roundtrip.mjs "待校验的文本"
//   node roundtrip.mjs --file 文章.md
//   node roundtrip.mjs --json "文本"         输出 JSON
//   node roundtrip.mjs --metrics-only "文本"  只算风格指标（离线，不调 LLM）
//
// 环境变量（OpenAI 兼容）:
//   STYLOTRACE_LLM_API_KEY / STYLOTRACE_LLM_BASE_URL / STYLOTRACE_LLM_MODEL
//   缺省回退 OPENAI_API_KEY / https://api.openai.com/v1 / gpt-4o-mini
import fs from 'node:fs';

const MARK = { key: '【内容要点提取】', fwd: '【中译英】', back: '【英译中】', judge: '【信息点核对】' };
const BLACKLIST = [
  '在当今社会', '随着', '近年来', '众所周知', '毋庸置疑', '不可否认',
  '值得注意的是', '不难发现', '事实上', '总而言之', '底层逻辑', '赋能',
];

function args() {
  const a = process.argv.slice(2);
  const out = { json: false, metricsOnly: false, file: null, text: '' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') out.json = true;
    else if (a[i] === '--metrics-only') out.metricsOnly = true;
    else if (a[i] === '--file') out.file = a[++i];
    else out.text = (out.text ? out.text + ' ' : '') + a[i];
  }
  return out;
}

function llmConfig() {
  return {
    apiKey: process.env.STYLOTRACE_LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.STYLOTRACE_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.STYLOTRACE_LLM_MODEL || 'gpt-4o-mini',
  };
}

async function chat(cfg, messages, { json = false, temperature = 0.3, maxTokens = 2000 } = {}) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (json) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM 未返回 JSON');
    return JSON.parse(m[0]);
  }
  return content.trim();
}

// ── 确定性工具 ─────────────────────────────────────────
function sentences(text) {
  return text
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function simpleMetrics(text) {
  const ss = sentences(text);
  const lens = ss.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
  const starts = ss.map((s) => s.slice(0, 2)).filter(Boolean);
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
  }
  return {
    chars: text.replace(/\s/g, '').length,
    sentenceLengthStddev: Number(Math.sqrt(variance).toFixed(2)),
    sentenceStartDedup: Math.round((new Set(starts).size / Math.max(1, starts.length)) * 100),
    bigramTtr: Number((grams.size / Math.max(1, text.length - 1)).toFixed(2)),
    blacklistHits: BLACKLIST.reduce((n, p) => n + (text.includes(p) ? 1 : 0), 0),
  };
}

function fallbackKeyPoints(text) {
  return sentences(text)
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
    .map((s) => s.slice(0, 60));
}

function deterministicFidelity(keyPoints, back) {
  const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?；;：:""''「」『』（）()]/g, '');
  const bn = norm(back);
  const kept = [];
  const lost = [];
  for (const kp of keyPoints) {
    const anchor = norm(kp).slice(0, 6);
    if (anchor && bn.includes(anchor)) kept.push(kp);
    else lost.push(kp);
  }
  return { kept, lost, drifted: [], hint: '确定性核对' };
}

// ── 主流程 ─────────────────────────────────────────────
async function runRoundtrip({ text, metricsOnly }) {
  const src = String(text || '').trim();
  if (!src) throw new Error('没有文本：直接传文本，或用 --file 指定文件');
  const original = simpleMetrics(src);
  if (metricsOnly) {
    return {
      source: 'metrics-only',
      chars: original.chars,
      keyPoints: fallbackKeyPoints(src),
      forward: '',
      back: '',
      content: { kept: [], lost: [], drifted: [], hint: '离线模式，未做翻译' },
      style: { original, back: null, notes: [] },
      verdict: 'metrics-only',
    };
  }
  const cfg = llmConfig();
  if (!cfg.apiKey) {
    const offline = await runRoundtrip({ text: src, metricsOnly: true });
    return { ...offline, content: { ...offline.content, hint: '未配置 API Key，仅输出风格指标' } };
  }

  // 1) 内容分析
  let keyPoints = [];
  try {
    const kp = await chat(
      cfg,
      [
        { role: 'system', content: '你是翻译校对的内容分析师。只输出严格 JSON。' },
        { role: 'user', content: `${MARK.key}\n提取必须保留的信息点（专名/数字/论断/关键意象），每点一句话：\n\n${src.slice(0, 3000)}` },
      ],
      { json: true, temperature: 0.2, maxTokens: 800 },
    );
    keyPoints = Array.isArray(kp.keyPoints) ? kp.keyPoints.map((k) => (typeof k === 'string' ? k : k?.point || '')).filter(Boolean).slice(0, 12) : [];
  } catch {}
  if (!keyPoints.length) keyPoints = fallbackKeyPoints(src);

  // 2) 直译 → 3) 回译
  let forward = '';
  let back = '';
  try {
    forward = await chat(cfg, [
      { role: 'system', content: '你是忠实直译官。只做直译，不润色、不增删信息。只输出译文。' },
      { role: 'user', content: `${MARK.fwd}\n${src.slice(0, 3000)}` },
    ], { temperature: 0.3, maxTokens: 2500 });
  } catch {}
  if (forward) {
    try {
      back = await chat(cfg, [
        { role: 'system', content: '你是忠实回译官。把英文忠实译回中文，不增删信息。只输出译文。' },
        { role: 'user', content: `${MARK.back}\n${forward.slice(0, 3000)}` },
      ], { temperature: 0.3, maxTokens: 2500 });
    } catch {}
  }

  // 4) 信息点核对
  let content = { kept: [], lost: [], drifted: [], hint: '' };
  if (forward && back) {
    try {
      const j = await chat(cfg, [
        { role: 'system', content: '你是翻译校对员。只输出严格 JSON。' },
        { role: 'user', content: `${MARK.judge}\n对照信息点核对回译是否保留：\n信息点：${JSON.stringify(keyPoints)}\n\n原文：${src.slice(0, 2000)}\n\n回译：${back.slice(0, 2000)}\n\n输出 {"kept":["..."],"lost":["..."],"drifted":["..."]}` },
      ], { json: true, temperature: 0.2, maxTokens: 800 });
      content = {
        kept: Array.isArray(j.kept) ? j.kept : [],
        lost: Array.isArray(j.lost) ? j.lost : [],
        drifted: Array.isArray(j.drifted) ? j.drifted : [],
        hint: '',
      };
    } catch {
      content = deterministicFidelity(keyPoints, back);
    }
  } else {
    content.hint = '翻译未完成，跳过信息点核对';
  }

  // 5) 风格对比
  const backMetrics = back ? simpleMetrics(back) : null;
  const notes = [];
  if (backMetrics) {
    if (Math.abs(original.sentenceLengthStddev - backMetrics.sentenceLengthStddev) > 5) {
      notes.push(`句长节奏改变明显（σ ${original.sentenceLengthStddev} → ${backMetrics.sentenceLengthStddev}）`);
    }
    if (original.blacklistHits !== backMetrics.blacklistHits) notes.push('AI 套话数量变化');
  }
  return {
    source: 'text',
    chars: original.chars,
    keyPoints,
    forward,
    back,
    content,
    style: { original, back: backMetrics, notes },
    verdict: content.lost.length + content.drifted.length === 0 ? 'pass' : 'attention',
  };
}

function render(r) {
  const L = [];
  L.push(`翻译/回译校验（${r.chars} 字）`);
  L.push(`信息点 ${r.keyPoints.length} 条：${r.keyPoints.slice(0, 6).join('；')}`);
  if (r.forward) L.push(`\n【英译】${r.forward.slice(0, 200)}${r.forward.length > 200 ? '…' : ''}`);
  if (r.back) L.push(`\n【回译】${r.back.slice(0, 200)}${r.back.length > 200 ? '…' : ''}`);
  const c = r.content;
  L.push(`\n内容保真：保留 ${c.kept.length} · 丢失 ${c.lost.length} · 漂移 ${c.drifted.length}${c.hint ? `（${c.hint}）` : ''}`);
  if (c.lost.length) L.push(`丢失：${c.lost.join('；')}`);
  if (c.drifted.length) L.push(`漂移：${c.drifted.join('；')}`);
  const a = r.style.original;
  const b = r.style.back;
  L.push(`\n风格对比：句长σ ${a.sentenceLengthStddev}→${b?.sentenceLengthStddev ?? '—'} · 句首去重 ${a.sentenceStartDedup}%→${b?.sentenceStartDedup ?? '—'}% · TTR ${a.bigramTtr}→${b?.bigramTtr ?? '—'} · 套话 ${a.blacklistHits}→${b?.blacklistHits ?? '—'}`);
  if (r.style.notes.length) L.push(`注意：${r.style.notes.join('；')}`);
  L.push(r.verdict === 'pass' ? '\n结论：信息完整、风格稳定' : r.verdict === 'attention' ? '\n结论：需要修订（信息有丢失或漂移）' : '\n结论：离线模式，仅风格指标');
  return L.join('\n');
}

const opt = args();
const text = opt.file ? fs.readFileSync(opt.file, 'utf8') : opt.text;
const r = await runRoundtrip({ text, metricsOnly: opt.metricsOnly });
process.stdout.write(opt.json ? JSON.stringify(r, null, 2) : render(r));
process.stdout.write('\n');
