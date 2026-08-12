#!/usr/bin/env node
// 升级信号流水聚合（v0.59）：扫描所有会话的 vault/overflow-log.jsonl，
// 汇总"用户主动给出、系统没准备问"的外溢种子，生成 docs/questioning-upgrades.md，
// 反哺问询系统（问询系统升级-v1.md 第五节 5.5）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA = process.env.SCULPTOR_WEB_DATA || path.join(REPO, 'web-data');
const OUT = path.join(REPO, 'docs', 'questioning-upgrades.md');

const rows = [];
const sessionsDir = path.join(DATA, 'sessions');
if (fs.existsSync(sessionsDir)) {
  for (const id of fs.readdirSync(sessionsDir)) {
    const f = path.join(sessionsDir, id, 'vault', 'overflow-log.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
  }
}
rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

const byType = {};
for (const r of rows) byType[r.overflowType || '?'] = (byType[r.overflowType || '?'] || 0) + 1;

const md = [
  '# 问询系统升级信号（overflow-log 汇总）',
  '',
  `> 生成：${new Date().toISOString().slice(0, 10)}｜来源：全部会话 vault/overflow-log.jsonl｜共 ${rows.length} 条`,
  '',
  '## 类型分布',
  '',
  '| 类型 | 数量 |',
  '| --- | --- |',
  ...Object.entries(byType).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## 明细',
  '',
  ...rows.map(
    (r, i) =>
      `${i + 1}. **[${r.overflowType || '?'}]** 任务：${r.task || '—'}\n` +
      `   - 系统当时问：${r.asked || '—'}\n` +
      `   - 用户主动说：${r.userSaid || '—'}\n` +
      `   - 种子：${r.seed || r.constraint || '—'}\n` +
      (r.coreThesis ? `   - 立意：${r.coreThesis}\n` : '') +
      (r.lesson ? `   - 教训：${r.lesson}\n` : ''),
  ),
  '',
  '## 使用方式',
  '',
  '1. 每 5 个任务或每周跑一次：`node scripts/overflow-summary.mjs`；',
  '2. 把高频模式补进 references/questioning.md 与 QUESTIONER_PROMPT（以规律归纳为准，不写死个案）；',
  '3. 若某类外溢反复出现而系统仍未准备问 → 升级问题模板（"留出入口"式问法）。',
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`overflow-summary: ${rows.length} 条 → ${OUT}`);
console.log('byType:', JSON.stringify(byType));
