#!/usr/bin/env node
// 学习曲线实验（v0.68，A3）：验证"从修改中学习"的样本复杂度——
// 编辑对数量 n=5/10/20/40/80 时，调制器的留出排序正确率与权重稳定性。
// 用法：node scripts/experiments/rsa-learning-curve.mjs [--out results.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ws = await import(path.join(ROOT, 'agent', 'src', 'workspace.js'));
const mod = await import(path.join(ROOT, 'agent', 'src', 'modulator.js'));

// 编辑对设计：original 与 changed 都是"正常中文"，差异是细微的风格选择
// （抽象 → 具体、陈述 → 动作/感官、连接词 → 句号断裂），避免靠 AI 腔词表
// 一眼分开——这样才能真实显示"几十次修改学出方向"的学习曲线。
const PAIRS = [
  ['我们要重视这个问题。', '这个问题搁在桌上，没人动。'],
  ['他感到很难过。', '他低着头，没有说话。'],
  ['风很大。', '风把门吹得砰砰响。'],
  ['她回忆起了过去。', '她想起门前的石阶。'],
  ['历史具有深远的意义。', '历史不响，它只是等着。'],
  ['这里的环境很安静。', '只有木头的气味在动。'],
  ['我最终明白了这个道理。', '我在门口站了一会儿，没有进去。'],
  ['这个细节非常重要。', '窗台积灰，灰上有细痕。'],
  ['他决定离开这个地方。', '他转身，楼还在。'],
  ['我们应当记住这段往事。', '纪念牌上的字，我念了一遍。'],
  ['时间过得很慢。', '木梯窄，每一步都响。'],
  ['这件事让他心情复杂。', '话到嘴边，又咽了回去。'],
  ['那里曾经发生过很多事。', '红砖在暮色里暗下去。'],
  ['她心里有很多想法。', '有些东西不必说出来。'],
  ['这个瞬间值得纪念。', '门槛被一百年的脚步磨低了。'],
  ['人们从这里走过。', '路过的人停下来的那一眼里。'],
  ['他在思考未来的方向。', '他在门口站了很久，久到门卫多看了他两眼。'],
  ['这个地方有特殊的意义。', '风从门里出来，带着旧木头的味道。'],
  ['她终于做出了决定。', '她没有擦灰，只是看。'],
  ['往事涌上心头。', '过去不说话，可它留了痕迹。'],
  ['他感到一种莫名的情绪。', '他忽然明白，有些东西不必说出来。'],
  ['我们很难改变什么。', '历史从不等谁，它只等人走进去。'],
  ['这个画面让人难忘。', '暮色里，红砖暗下去。'],
  ['她想起了小时候。', '她想起那扇窗，窗台上积着灰。'],
  ['事情的发展出乎意料。', '门开着。石阶旧，被磨得发亮。'],
  ['他决定不再犹豫。', '他念了一遍纪念牌上的字。'],
  ['这个道理很简单。', '道理就藏在门槛磨低的弧度里。'],
  ['人们渐渐忘记了。', '人们忘了，可灰还在。'],
  ['他对这里充满感情。', '他在门口站了一会儿。'],
  ['时间让人忘记一切。', '时间不响，木梯响。'],
];

const AUTHOR_CORPUS = PAIRS.map(([, changed]) => changed).join('\n');

function buildPool() {
  return PAIRS.map(([original, changed]) => ({ original, changed, intent: '具体化，克制留白' }));
}

function writeEdits(workspace, pairs) {
  const f = path.join(workspace, 'vault', 'edits.jsonl');
  fs.writeFileSync(f, pairs.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function accuracy(workspace, holdout) {
  let ok = 0;
  for (const p of holdout) {
    const pos = mod.modulate(workspace, p.changed, {}).score;
    const neg = mod.modulate(workspace, p.original, {}).score;
    if (pos > neg) ok += 1;
  }
  return holdout.length ? ok / holdout.length : 0;
}

function margin(workspace, holdout) {
  let sum = 0;
  for (const p of holdout) {
    sum += mod.modulate(workspace, p.changed, {}).score - mod.modulate(workspace, p.original, {}).score;
  }
  return holdout.length ? sum / holdout.length : 0;
}

function weightCos(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of mod.FEATURES) {
    dot += (a[k] || 0) * (b[k] || 0);
    na += (a[k] || 0) ** 2;
    nb += (b[k] || 0) ** 2;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsa-curve-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
fs.mkdirSync(path.join(w, 'vault', 'style-samples'), { recursive: true });
fs.writeFileSync(path.join(w, 'vault', 'style-samples', 'author-a.md'), AUTHOR_CORPUS);

const pool = buildPool();
const holdout = pool.slice(20);
const trainSets = [5, 10, 15, 20, 25, 30];
const results = [];

for (const n of trainSets) {
  writeEdits(w, pool.slice(0, n));
  const trained = mod.forceRetrain(w);
  if (!trained.ok) {
    results.push({ n, trained: false, note: trained.reason });
    continue;
  }
  results.push({
    n,
    trained: true,
    trainAcc: accuracy(w, pool.slice(0, n)),
    holdoutAcc: accuracy(w, holdout),
    holdoutMargin: Number(margin(w, holdout).toFixed(4)),
    weights: { ...trained.weights },
  });
}

// 权重稳定性：与最大样本（n=30）的权重余弦
const ref = results.find((r) => r.n === 30);
if (ref) {
  for (const r of results) {
    if (r.trained) r.weightCos = Number(weightCos(r.weights, ref.weights).toFixed(4));
  }
}

const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'docs', 'competition', 'learning-curve.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');

console.log('编辑对数量 | 训练集正确率 | 留出集正确率 | 留出边距 | 权重稳定(cos)');
for (const r of results) {
  if (!r.trained) {
    console.log(`${String(r.n).padEnd(10)} | 未训练（${r.note || ''}）`);
    continue;
  }
  console.log(
    `${String(r.n).padEnd(10)} | ${(r.trainAcc * 100).toFixed(1).padStart(5)}% | ${(r.holdoutAcc * 100).toFixed(1).padStart(5)}% | ${(r.holdoutMargin ?? 0).toFixed(3).padStart(7)} | ${r.weightCos ?? '-'}`,
  );
}
console.log(`\n结果已写入 → ${outFile}`);
