#!/usr/bin/env node
// 从"手动修改"提取风格的红队测试：只给 Stylotrace 一组"原文→改后"的修改对（都体现
// "抽象改具体、删连接词、长句改短句"），让它从修改中学习，再写一个全新主题，盲评是否带出该风格。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '/Users/wallace/Documents/Codex/2026-08-04/bang/stylotrace';
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.STYLOTRACE_DECODE_N = '2';
process.env.STYLOTRACE_CONCRETIZE = '0';

const { loadConfig } = await import(path.join(ROOT, 'agent/src/config.js'));
const { chatWithRetry } = await import(path.join(ROOT, 'agent/src/llm.js'));
const { decodeSection } = await import(path.join(ROOT, 'agent/src/token-decode.js'));
const ws = await import(path.join(ROOT, 'agent/src/workspace.js'));
const mod = await import(path.join(ROOT, 'agent/src/modulator.js'));
const cfg = loadConfig();

const EDITS = [
  ['我们要重视这个问题。', '这个问题搁在桌上，没人动。'],
  ['他感到很难过。', '他低着头，没有说话。'],
  ['历史具有深远的意义。', '历史不响，它只是等着。'],
  ['这里的环境很安静。', '只有木头的气味在动。'],
  ['我最终明白了这个道理。', '我在门口站了一会儿，没有进去。'],
  ['时间过得很慢。', '木梯窄，每一步都响。'],
  ['她心里有很多想法。', '有些东西不必说出来。'],
  ['我们很难改变什么。', '历史从不等谁，它只等人走进去。'],
  ['时间让人忘记一切。', '时间不响，木梯响。'],
  ['这个瞬间值得纪念。', '门槛被一百年的脚步磨低了。'],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-style-'));
const workspace = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
fs.writeFileSync(
  path.join(workspace, 'vault', 'edits.jsonl'),
  EDITS.map(([original, changed]) => JSON.stringify({ original, changed, intent: '具体化，克制留白' })).join('\n') + '\n',
);
const trained = mod.forceRetrain(workspace);

const messages = [
  { role: 'system', content: '你是人类风格的写作者，请按你已经学到的风格习惯写作，只输出正文。' },
  { role: 'user', content: '写一段关于"老屋"的文字，约 200 字。' },
];
const dec = await decodeSection(cfg, workspace, {
  messages,
  temperature: 0.85,
  maxTokens: 3000,
  generate: (m, o) => chatWithRetry(cfg, m, o),
});

const judge = await chatWithRetry(
  cfg,
  [
    {
      role: 'system',
      content:
        '你是资深文学编辑（人类审阅者）。这段文字是某个写作系统"只通过一组作者亲手修改（把抽象改成具体、删连接词、长句改短句）后学到的风格"写出来的。请只凭文字判断：它是否真的带出了这种"具体、克制、短句留白"的风格？打 1–5 分并给一句理由，只输出 JSON：{"score":数字,"reason":"..."}',
    },
    { role: 'user', content: `文字：\n${dec.text}` },
  ],
  { temperature: 0, maxTokens: 1500 },
);
let jj = {};
try {
  const m = String(judge).match(/\{[\s\S]*\}/);
  jj = JSON.parse(m ? m[0] : judge);
} catch {}

console.log(`modulator trained: ${trained.ok}（${trained.meta?.pairs || 0} 对）· mode=${dec.mode}`);
console.log(`文：${dec.text.slice(0, 120)}…`);
console.log(`盲评：${jj.score ?? '?'}/5 · ${jj.reason}`);
fs.writeFileSync(
  path.join(ROOT, 'docs', 'competition', 'redteam-edit-style.json'),
  JSON.stringify({ trained: trained.ok, mode: dec.mode, edits: dec.edits, text: dec.text, judge: jj }, null, 2) + '\n',
);
