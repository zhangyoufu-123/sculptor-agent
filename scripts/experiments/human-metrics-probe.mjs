#!/usr/bin/env node
// 人类化指标与同题三风格对照的复测（v1.2）：重新生成真实文本并测量，
// 用当前可追溯的真实值替换论文里旧的、无法追溯来源的"真实成稿"数字。
// 依赖 DeepSeek（真实 LLM）。输出 docs/competition/human-metrics-probe.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { loadConfig } = await import(path.join(ROOT, 'agent/src/config.js'));
const { chatWithRetry } = await import(path.join(ROOT, 'agent/src/llm.js'));
const { humanMetrics } = await import(path.join(ROOT, 'agent/src/experiment.js'));
const cfg = loadConfig();

async function gen(messages, temperature = 0.85, maxTokens = 3000) {
  const out = await chatWithRetry(cfg, messages, { temperature, maxTokens });
  return String(out || '').trim();
}

// 1) 一篇"有个人风格"的完整散文（用于人类化指标四量纲）
const essay = await gen([
  { role: 'system', content: '你是一名中文写作者，请写一篇有个人风格、克制留白的散文，多用具体意象与短句，避免套话和总结句。只输出正文。' },
  { role: 'user', content: '写一篇约 800 字的散文《旧屋》，写老房子的门槛、窗台、木梯、天井和一段记忆。' },
]);
const essayM = humanMetrics(essay);

// 2) 同题三风格对照（同一主题"北大红楼"，三种风格方向）
const styleDirs = [
  { key: '样本1', dir: '极简克制留白：短句、省略主语、意象留白' },
  { key: '样本2', dir: '口语亲切：口语词、儿化、生活化比喻、闲聊语气' },
  { key: '样本3', dir: '庄重抒情：长句、排比、比喻、书面语' },
];
const variants = [];
for (const s of styleDirs) {
  const t = await gen([
    { role: 'system', content: '你是一名中文写作者。请严格按给定风格写一段文字，只输出正文。' },
    { role: 'user', content: `风格：${s.dir}。\n题目：写一段约 200 字的"北大红楼"。` },
  ]);
  const sentLen = t.split(/[。！？.!?]+/).filter((x) => x.trim()).map((x) => x.length);
  const std = sentLen.length ? Math.round(Math.sqrt(sentLen.reduce((a, b) => a + b * b, 0) / sentLen.length - Math.pow(sentLen.reduce((a, b) => a + b, 0) / sentLen.length, 2)) * 10) / 10 : 0;
  const grams = [...t.matchAll(/[\u4e00-\u9fff]{2}/g)].map((m) => m[0]);
  const ttr = grams.length ? +(new Set(grams).size / grams.length).toFixed(2) : 0;
  variants.push({ style: s.key, direction: s.dir, chars: t.length, sentenceLengthStddev: std, bigramTtr: ttr, text: t });
}

const result = {
  note: '本次复测（DeepSeek，真实生成）的可追溯值；与旧"真实成稿"数字口径一致（同一 humanMetrics 函数）。',
  essay: { chars: essay.length, metrics: essayM, text: essay },
  variants,
};

const outFile = path.join(ROOT, 'docs', 'competition', 'human-metrics-probe.json');
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');

console.log('人类化指标：', JSON.stringify(essayM));
for (const v of variants) {
  console.log(`[${v.style}] 字数 ${v.chars} · σ ${v.sentenceLengthStddev} · TTR ${v.bigramTtr}`);
}
console.log(`\n已写入 → ${outFile}`);
