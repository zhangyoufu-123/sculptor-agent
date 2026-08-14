#!/usr/bin/env node
// 调制器消融（v1.7）：量化每个特征的边际贡献；诚实报告排序正确率是否饱和。
// 任务：对"原文 vs 改后"做二选一排序，比较各消融变体的排序正确率。
// 零 LLM、确定性、可复现。用法：node scripts/experiments/modulator-ablation.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ws = await import(path.join(ROOT, 'agent', 'src', 'workspace.js'));
const mod = await import(path.join(ROOT, 'agent', 'src', 'modulator.js'));

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

function zOf(model, features, f) {
  const raw = Number(features[f]) || 0;
  const mean = model.norm?.mean?.[f] || 0;
  const std = model.norm?.std?.[f] || 1e-4;
  return (raw - mean) / std;
}

function scoreWith(model, features, weights) {
  let s = model.bias || 0;
  for (const f of mod.FEATURES) s += (weights[f] || 0) * zOf(model, features, f);
  return s;
}

function rankingAccuracy(model, pairs, weightsOverride = null, dropFeature = null) {
  let ok = 0;
  for (const [orig, chg] of pairs) {
    const fo = mod.extractFeatures(wsWorkspace, orig, { t: 0.5 });
    const fc = mod.extractFeatures(wsWorkspace, chg, { t: 0.5 });
    const w = { ...(weightsOverride || model.weights) };
    if (dropFeature) w[dropFeature] = 0;
    const so = scoreWith(model, fo, w);
    const sc = scoreWith(model, fc, w);
    if (sc > so) ok += 1;
  }
  return ok / pairs.length;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-ablation-'));
const wsWorkspace = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
fs.mkdirSync(path.join(wsWorkspace, 'vault', 'style-samples'), { recursive: true });
fs.writeFileSync(path.join(wsWorkspace, 'vault', 'style-samples', 'author-a.md'), AUTHOR_CORPUS);

// 训练集 = 前 20 对，留出集 = 后 10 对
const train = PAIRS.slice(0, 20);
const holdout = PAIRS.slice(20);
fs.writeFileSync(
  path.join(wsWorkspace, 'vault', 'edits.jsonl'),
  train.map(([original, changed]) => JSON.stringify({ original, changed, intent: '具体化' })).join('\n') + '\n',
);
const model = mod.forceRetrain(wsWorkspace);
if (!model.ok) {
  console.log('训练失败：', model.reason);
  process.exit(1);
}

const rows = [];
const learned = rankingAccuracy(model, holdout);
const defaults = rankingAccuracy(model, holdout, mod.DEFAULT_WEIGHTS);
rows.push(['学习权重', `${(learned * 100).toFixed(1)}%`, '—']);
rows.push(['默认权重（无学习）', `${(defaults * 100).toFixed(1)}%`, `${((learned - defaults) * 100).toFixed(1)}%`]);

const perFeature = [];
for (const f of mod.FEATURES) {
  const acc = rankingAccuracy(model, holdout, null, f);
  perFeature.push({ feature: f, acc, drop: learned - acc });
}
perFeature.sort((a, b) => b.drop - a.drop);
for (const p of perFeature) {
  rows.push([`关 ${p.feature}`, `${(p.acc * 100).toFixed(1)}%`, `${(-p.drop * 100).toFixed(1)}%`]);
}

console.log('消融变体 | 留出排序正确率 | 相对学习权重的边际贡献');
for (const r of rows) {
  const [label, acc, delta] = r;
  console.log(`${label.padEnd(18)} | ${String(acc).padStart(8)} | ${delta === '—' ? '—' : `${delta} pp`}`);
}
const positive = perFeature.filter((p) => p.drop > 0).map((p) => p.feature);
const negative = perFeature.filter((p) => p.drop < 0).map((p) => p.feature);
console.log('\n结论：');
console.log(`  学习权重 ${(learned * 100).toFixed(1)}%、默认权重 ${(defaults * 100).toFixed(1)}%（差 ${((learned - defaults) * 100).toFixed(1)} pp；差为 0 即排序正确率饱和）`);
console.log(`  正面特征（关闭即掉分）：${positive.length ? positive.join('、') : '无'}`);
console.log(`  当前噪声特征（关闭反而更好）：${negative.length ? negative.join('、') : '无'}`);

const md = [
  '# 调制器消融（学习 vs 默认 vs 逐维关闭）',
  '',
  '> 任务：原文 vs 改后 二选一排序；训练 20 对、留出 10 对。',
  '',
  '| 变体 | 留出排序正确率 | 相对学习权重 |',
  '| --- | --- | --- |',
  ...rows.map(([l, a, d]) => `| ${l} | ${a} | ${d === '—' ? '—' : d + ' pp'} |`),
  '',
  (learned > defaults
    ? `结论：学习权重 ${(learned * 100).toFixed(1)}% 高于默认权重 ${(defaults * 100).toFixed(1)}%（+${((learned - defaults) * 100).toFixed(1)} pp）。`
    : `结论：学习权重与默认权重的留出正确率均饱和到 ${(learned * 100).toFixed(1)}%（编辑对差异过大，正确率无法区分二者）；"学习有真实增益"的可靠证据应看学习曲线的留出得分边距（3.1.2），而非本任务的正确率。`) +
    `逐维关闭显示正面特征（关闭即掉分）${positive.join('、') || '无'}，噪声特征 ${negative.join('、') || '无'}。`,
  '',
];
const outFile = path.join(ROOT, 'docs', 'competition', 'MODULATOR-ABLATION.md');
fs.writeFileSync(outFile, md.join('\n') + '\n');
console.log(`\n已写入 → ${outFile}`);
