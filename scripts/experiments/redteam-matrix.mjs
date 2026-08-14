#!/usr/bin/env node
// 真正的红队测试（v1.0）：10 种风格 × 10 种文体，完全由 Stylotrace 引擎完成写作
// （decodeSection：候选生成 + 13 维调制评分 + 拟改），再由 LLM 以"人类审阅者"身份
// 完全盲人状态下独立打分（风格 + 文体双维度）。
// 用法：node scripts/experiments/redteam-matrix.mjs [--out result.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function loadEnvLocal() {
  const f = path.join(ROOT, '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();
process.env.STYLOTRACE_DECODE_N = '2'; // 启用候选对比解码（13 维评分）
process.env.STYLOTRACE_CONCRETIZE = '0'; // 无编辑对，关拟改以省调用

const { loadConfig } = await import(path.join(ROOT, 'agent', 'src', 'config.js'));
const { chatWithRetry } = await import(path.join(ROOT, 'agent', 'src', 'llm.js'));
const { decodeSection } = await import(path.join(ROOT, 'agent', 'src', 'token-decode.js'));
const ws = await import(path.join(ROOT, 'agent', 'src', 'workspace.js'));
const cfg = loadConfig();

// 10 种风格 × 10 种文体（一一配对，风格与文体均不重复）
const MATRIX = [
  { style: '克制留白', genre: '散文', topic: '写故乡' },
  { style: '口语亲切', genre: '书信', topic: '给多年未见的老友写一封信' },
  { style: '豪迈大气', genre: '演讲稿', topic: '关于奋斗与担当的演讲' },
  { style: '冷峻白描', genre: '悼词', topic: '悼念一位故人' },
  { style: '诗意乡土', genre: '游记', topic: '记一次山水之行' },
  { style: '华丽苍凉', genre: '短篇小说', topic: '城市里的一次告别' },
  { style: '电报极简', genre: '新闻稿', topic: '一则突发事件报道' },
  { style: '京味儿', genre: '议论文', topic: '论市井人情' },
  { style: '疏离意象', genre: '诗歌', topic: '夜晚' },
  { style: '学术严谨', genre: '序言', topic: '为一本文集作序' },
];

async function writeByStylotrace(item) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-matrix-'));
  const workspace = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
  const messages = [
    { role: 'system', content: '你是人类风格的写作者，请严格遵守给定风格与文体，只输出正文，不署名、不解释。' },
    {
      role: 'user',
      content: `写作风格：${item.style}。\n文体：${item.genre}。\n内容：${item.topic}。\n写约 200–300 字。`,
    },
  ];
  const dec = await decodeSection(cfg, workspace, {
    messages,
    temperature: 0.85,
    maxTokens: 3000,
    generate: (msgs, opts) => chatWithRetry(cfg, msgs, opts),
  });
  return { text: String(dec.text || '').trim(), mode: dec.mode, edits: dec.edits || [], n: dec.n };
}

async function judge(item, text) {
  const msgs = [
    {
      role: 'system',
      content:
        '你是一位资深文学编辑（人类审阅者）。你会收到一段声称以某种风格、某种文体写成的文字。请完全以人类审阅者的眼光、只看这段文字本身（不要因为是 AI 生成就减分），判断：①风格上是否真正做到了该风格？②文体上是否规范符合该文体？分别打 1–5 分，并各给一句理由。只输出 JSON：{"style_score":数字,"genre_score":数字,"style_reason":"...","genre_reason":"..."}',
    },
    { role: 'user', content: `风格：${item.style}\n文体：${item.genre}\n文字：\n${text}` },
  ];
  const out = await chatWithRetry(cfg, msgs, { temperature: 0, maxTokens: 3000 });
  try {
    const m = out.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : out);
  } catch {
    return { style_score: null, genre_score: null, style_reason: '', genre_reason: String(out).slice(0, 80) };
  }
}

const results = [];
for (const item of MATRIX) {
  try {
    const w = await writeByStylotrace(item);
    const j = await judge(item, w.text);
    results.push({ ...item, ...w, judge: j });
    console.log(`\n[${item.style} · ${item.genre}] mode=${w.mode} n=${w.n}`);
    console.log(`  文：${w.text.slice(0, 90)}…`);
    console.log(`  盲评：风格 ${j.style_score ?? '?'}/5 · 文体 ${j.genre_score ?? '?'}/5`);
  } catch (e) {
    results.push({ ...item, error: String(e?.message || e).slice(0, 80) });
    console.log(`\n[${item.style} · ${item.genre}] 失败：${String(e?.message || e).slice(0, 80)}`);
  }
}

const avg = (key) =>
  (results.reduce((s, r) => s + (Number(r.judge?.[key]) || 0), 0) / Math.max(1, results.length)).toFixed(2);
console.log(`\n平均：风格 ${avg('style_score')}/5 · 文体 ${avg('genre_score')}/5`);

const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'docs', 'competition', 'redteam-matrix.json');
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
console.log(`结果已写入 → ${outFile}`);
