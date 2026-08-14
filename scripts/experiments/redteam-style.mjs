#!/usr/bin/env node
// 名家风格红队测试（v1.0）：Stylotrace 引擎只按"风格描述"（不看原文）模仿名家，
// 再由 LLM 作为"完全盲人"评委独立打分——判断输出是否真的具有该名家鲜明风格。
// 用法：node scripts/experiments/redteam-style.mjs [--out result.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// 加载 .env.local（DeepSeek 密钥）
function loadEnvLocal() {
  const f = path.join(ROOT, '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const { loadConfig } = await import(path.join(ROOT, 'agent', 'src', 'config.js'));
const { chat } = await import(path.join(ROOT, 'agent', 'src', 'llm.js'));
const cfg = loadConfig();

const AUTHORS = [
  {
    name: '鲁迅',
    style: '冷峻、白描、讽刺、凝练，多用短句与反语，笔下是旧中国的麻木与清醒',
    topic: '写一段关于"故乡"的文字，约 200 字',
  },
  {
    name: '沈从文',
    style: '湘西乡土、诗意、质朴、温润，文字像水一样流动，白描山水人情',
    topic: '写一段关于"边城山水"的文字，约 200 字',
  },
  {
    name: '张爱玲',
    style: '华丽、苍凉、都市、细腻奇特的比喻，冷眼看人间的悲欢离合',
    topic: '写一段关于"城市与月亮"的文字，约 200 字',
  },
  {
    name: '海明威',
    style: '电报式、极简、克制、硬汉，少形容词，多用短句与留白',
    topic: '写一段关于"老人与海"的文字，约 200 字',
  },
];

async function generate(author) {
  const msgs = [
    {
      role: 'system',
      content:
        '你是一位深谙各类文学风格的中文写作者。请严格模仿给定作家的笔法，只输出正文，不解释、不署名。',
    },
    {
      role: 'user',
      content: `模仿作家「${author.name}」，其风格是：${author.style}。\n题目：${author.topic}。`,
    },
  ];
  const text = await chat(cfg, msgs, { temperature: 0.9, maxTokens: 3000 });
  return String(text || '').trim();
}

async function judge(author, text) {
  // 盲人评委：只看文本 + 作家名，不接触生成提示词、不给原文
  const msgs = [
    {
      role: 'system',
      content:
        '你是一位文学鉴赏评委。请只依据文本本身，判断它在多大程度上具有该作家鲜明的个人风格。先打 1–5 分，再给一句理由。输出 JSON：{"score":数字,"reason":"理由"}。',
    },
    {
      role: 'user',
      content: `作家：${author.name}\n文本：\n${text}`,
    },
  ];
  const out = await chat(cfg, msgs, { temperature: 0, maxTokens: 1500 });
  try {
    const m = out.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : out);
  } catch {
    return { score: null, reason: String(out).slice(0, 80) };
  }
}

const results = [];
for (const a of AUTHORS) {
  const text = await generate(a);
  const j = await judge(a, text);
  results.push({ author: a.name, style: a.style, text, judge: j });
  console.log(`\n===== ${a.name} =====`);
  console.log(`生成：${text.slice(0, 160)}…`);
  console.log(`盲评：${j.score ?? '?'} 分 · ${j.reason}`);
}

const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'docs', 'competition', 'redteam-style.json');
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');

const avg = results.reduce((s, r) => s + (Number(r.judge?.score) || 0), 0) / Math.max(1, results.length);
console.log(`\n平均盲评分：${avg.toFixed(2)} / 5（≥4 视为风格鲜明）`);
console.log(`结果已写入 → ${outFile}`);
