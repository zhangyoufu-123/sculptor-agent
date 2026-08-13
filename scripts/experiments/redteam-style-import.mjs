#!/usr/bin/env node
// 真实文风导入红队测试（v1.0）：把名家真实摘录作为 style-samples 给 Sculptor，
// 由 Sculptor 的 buildStyleShot（风格少样本提取）解析学习，再写一个"不同内容"的新题，
// 由 LLM 以人类审阅者身份完全盲评——检验"从真实文章解析风格并迁移到新题材"的能力。
// 用法：node scripts/experiments/redteam-style-import.mjs [--out result.json]
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
process.env.SCULPTOR_DECODE_N = '2';
process.env.SCULPTOR_CONCRETIZE = '0';

const { loadConfig } = await import(path.join(ROOT, 'agent', 'src', 'config.js'));
const { chatWithRetry } = await import(path.join(ROOT, 'agent', 'src', 'llm.js'));
const { decodeSection } = await import(path.join(ROOT, 'agent', 'src', 'token-decode.js'));
const ws = await import(path.join(ROOT, 'agent', 'src', 'workspace.js'));
const { buildStyleShot } = await import(path.join(ROOT, 'agent', 'src', 'style-memory.js'));
const { STYLE_SHOT } = await import(path.join(ROOT, 'agent', 'src', 'prompts.js'));
const cfg = loadConfig();

// 名家真实摘录（只做风格学习样本；新题内容与摘录内容不重复）
const AUTHORS = [
  {
    name: '鲁迅',
    excerpt:
      '我家门前有两棵树，一棵是枣树，另一棵也是枣树。这上面的夜的天空，奇怪而高，我生平没有见过这样奇怪而高的天空。他仿佛要离开人间而去，使人们仰面不再看见。',
    newTopic: '写一段关于"冬天"的文字，约 200 字',
  },
  {
    name: '沈从文',
    excerpt:
      '由四川过湖南去，靠东有一条官路。这官路将近湘西边境到了一个地方名为茶峒的小山城时，有一小溪，溪边有座白色小塔，塔下住了一户单独的人家。',
    newTopic: '写一段关于"集市"的文字，约 200 字',
  },
  {
    name: '张爱玲',
    excerpt:
      '生命是一袭华美的袍，爬满了蚤子。回忆这东西若是有气味的话，那就是樟脑的香，甜而稳妥，像记得分明的快乐，甜而怅惘，像忘却了的忧愁。',
    newTopic: '写一段关于"雨"的文字，约 200 字',
  },
  {
    name: '老舍',
    excerpt:
      '这茶馆里里外外的人，都是些小人物，可也都有各人的想头。常四爷，松二爷，王掌柜，都在这茶馆里坐下，喝两碗茶，说几句闲话，日头就一天一天地过去了。',
    newTopic: '写一段关于"胡同口早点摊"的文字，约 200 字',
  },
];

async function writeByStyleImport(author) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'style-import-'));
  const workspace = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
  const sampleDir = path.join(workspace, 'vault', 'style-samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(path.join(sampleDir, `${author.name}.md`), author.excerpt);
  const shot = buildStyleShot(workspace, { topic: author.name, genre: '散文', section: { heading: '' } });
  const messages = [
    { role: 'system', content: '你是人类风格的写作者。请模仿下面给出的作者风格少样本写作，只输出正文。' },
    {
      role: 'user',
      content: `${shot ? STYLE_SHOT(shot) : '（无可用风格样本）'}\n\n题目：${author.newTopic}`,
    },
  ];
  const dec = await decodeSection(cfg, workspace, {
    messages,
    temperature: 0.85,
    maxTokens: 3000,
    generate: (msgs, opts) => chatWithRetry(cfg, msgs, opts),
  });
  return { text: String(dec.text || '').trim(), shotUsed: Boolean(shot), mode: dec.mode };
}

async function judge(author, text) {
  const out = await chatWithRetry(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是资深文学编辑（人类审阅者）。只看这段文字本身，判断它在多大程度上具有该作家的鲜明个人风格（笔法/意象/节奏/语气）。打 1–5 分并给一句理由，只输出 JSON：{"score":数字,"reason":"..."}',
      },
      { role: 'user', content: `作家：${author.name}\n文字：\n${text}` },
    ],
    { temperature: 0, maxTokens: 1500 },
  );
  try {
    const m = String(out).match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : out);
  } catch {
    return { score: null, reason: String(out).slice(0, 80) };
  }
}

const results = [];
for (const a of AUTHORS) {
  const w = await writeByStyleImport(a);
  const j = await judge(a, w.text);
  results.push({ author: a.name, newTopic: a.newTopic, shotUsed: w.shotUsed, mode: w.mode, text: w.text, judge: j });
  console.log(`\n[${a.name}] shot=${w.shotUsed} mode=${w.mode}`);
  console.log(`  文：${w.text.slice(0, 90)}…`);
  console.log(`  盲评：${j.score ?? '?'}/5 · ${j.reason}`);
}

const avg = (results.reduce((s, r) => s + (Number(r.judge?.score) || 0), 0) / Math.max(1, results.length)).toFixed(2);
console.log(`\n平均盲评：${avg}/5`);
const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'docs', 'competition', 'redteam-style-import.json');
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
console.log(`结果已写入 → ${outFile}`);
