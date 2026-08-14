// v0.64 外层调制器测试：纯净数据收集、小数据权重学习（偏好对 → 八维权重）、
// 推理时调制评分、数据不足降级、数据变化在线重训。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const {
  collectModulatorData,
  getModulator,
  modulate,
  forceRetrain,
  weightsFile,
  FEATURES,
  surfaceFeature,
  discourseFeature,
  postureFeature,
  avoidanceFeature,
  humanRationale,
  contributionBreakdown,
} = await import(path.join(HERE, '..', 'src', 'modulator.js'));
const avoidanceMod = await import(path.join(HERE, '..', 'src', 'avoidance.js'));
const { contrastiveScore } = await import(path.join(HERE, '..', 'src', 'token-decode.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-mod-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

const authorA = [
  '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，带着木头的气味。',
  '我想，一百年前有人也这样站过。历史不响，它只是等着。木梯窄，每一步都响。',
  '窗台积灰，灰上有细痕。我没有擦，只是看。过去不说话，可它留了痕迹。',
  '回头，楼还在。暮色里，红砖暗下去。纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去。',
  '我在门口站了很久，久到门卫多看了我两眼。风从门里出来，带着旧木头的味道，我忽然明白，有些东西不必说出来。',
  '再后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，在每一个路过的人停下来的那一眼里。',
].join('\n');
const sampleDir = path.join(w, 'vault', 'style-samples');
fs.mkdirSync(sampleDir, { recursive: true });
fs.writeFileSync(path.join(sampleDir, 'sample-a.md'), authorA);

const aiOriginal =
  '在当今社会，随着科技的飞速发展，因此综上所述，我们应当充分发挥前所未有的积极作用，开启更加美好的新篇章。';

function writeEdits(pairs) {
  const f = path.join(w, 'vault', 'edits.jsonl');
  fs.writeFileSync(
    f,
    pairs
      .map((p) => JSON.stringify({ original: p.original, changed: p.changed, intent: p.intent }))
      .join('\n') + '\n',
  );
}

const edits = [
  { original: aiOriginal, changed: '门开着。石阶旧。风从里面出来，带着木头的气味。', intent: '去套话' },
  { original: '总而言之，历史具有深远意义，我们应当深刻铭记。', changed: '纪念牌上的字，我念了一遍。', intent: '留白' },
  { original: '首先，这个场景令人印象深刻。其次，我们应当思考其内涵。', changed: '木梯窄，每一步都响。', intent: '具体物象' },
];

// 1) 纯净数据收集：编辑对 + 正例进入调制器数据
{
  writeEdits(edits);
  const d = collectModulatorData(w);
  assert(d.pairs.length === 3, `编辑对应被收集（${d.pairs.length}）`);
  assert(d.positives.some((p) => p.text.includes('石阶旧')), '编辑后文本进入正例');
  assert(d.positives.some((p) => p.text.includes('纪念牌')), '风格样本进入正例');
  assert(/^[0-9a-f]{16}$/.test(d.signature), '数据签名存在');
  console.log('PASS 纯净数据收集（编辑对 + 正例 + 签名）');
}

// 2) 小数据权重学习：偏好对 → 学习权重，改后文本应得分更高
{
  const r = forceRetrain(w);
  assert(r.ok === true, `应能训练（${r.reason || ''}）`);
  assert(r.meta.pairs === 3, '训练元数据记录偏好对数');
  assert(fs.existsSync(weightsFile(w)), '权重文件落盘');
  for (const p of edits) {
    const mPos = modulate(w, p.changed, { t: 0.5 });
    const mNeg = modulate(w, p.original, { t: 0.5 });
    assert(mPos.trained === true, '调制器为学习模式');
    assert(mPos.score > mNeg.score, `改后应高于原文（${mPos.score} > ${mNeg.score}）`);
  }
  console.log('PASS 小数据权重学习（编辑对 → 八维权重，改后得分更高）');
}

// 3) 推理调制：八维特征齐全、可追溯、与旧五路字段兼容
{
  const m = modulate(w, '门开着。石阶旧。风从里面出来。', { t: 0.9 });
  assert(FEATURES.every((f) => typeof m.features[f] === 'number'), '八维特征齐全');
  assert(m.mode === 'learned', `学习模式（${m.mode}）`);
  const cs = contrastiveScore(null, w, '门开着。石阶旧。', { t: 0.9 });
  for (const f of ['personal', 'defect', 'knowledge', 'impedance', 'surface', 'discourse', 'stance', 'vector']) {
    assert(typeof cs[f] === 'number', `得分分解含 ${f}`);
  }
  assert(typeof cs.weights === 'object' && typeof cs.trained === 'boolean', '权重与训练标记可追溯');
  console.log('PASS 推理调制（八维特征 + 得分分解 + 权重追溯）');
}

// 4) 特征可解释性：表层/话语特征对"人话"与"AI 腔"有区分
{
  const human = '门开着。石阶旧。风从里面出来，带着木头的气味。';
  const ai = '在当今社会，随着科技的飞速发展，因此综上所述我们应当充分发挥作用。';
  assert(surfaceFeature(human) > surfaceFeature(ai), '表层特征区分人话/AI 腔');
  assert(discourseFeature(human) >= 0 && discourseFeature(human) <= 1, '话语特征取值域');
  console.log('PASS 特征可解释性（表层/话语有区分度）');
}

// 5) 数据不足降级 + 数据变化在线重训
{
  const empty = path.join(tmp, 'empty');
  ws.ensureWorkspace(empty, { create: true });
  const m0 = modulate(empty, '随便一段文本。', { t: 0.5 });
  assert(m0.mode === 'default', '无编辑对 → 经验默认权重');
  assert(typeof m0.score === 'number', '默认模式仍可评分');

  const sig1 = collectModulatorData(w).signature;
  writeEdits([...edits, { original: '综上所述，我们应当共同努力。', changed: '风停。门合。他转身走了。', intent: '收束' }]);
  const sig2 = collectModulatorData(w).signature;
  assert(sig1 !== sig2, '新编辑 → 数据签名变化');
  const m1 = modulate(w, '风停。门合。他转身走了。', { t: 0.5 });
  assert(m1.trained === true, '签名变化后自动重训');
  const saved = JSON.parse(fs.readFileSync(weightsFile(w), 'utf8'));
  assert(saved.meta.signature === sig2, '权重文件签名与最新数据一致');
  console.log('PASS 数据不足降级 + 数据变化在线重训');
}

// 6) 姿态层细读特征（v0.67）：表演式文本健康度低、克制文本健康度高、软性加权无硬约束
{
  const performative =
    '我绕了很久才绕出来，但这里头有个悖论。后来我想，我终于明白，原来生活的本质就是如此。' +
    '话到嘴边，是话还在，是嘴还在，是我们还在。';
  const restrained = '他最后笑了笑，没说话。我把那杯茶喝完，起身，门在身后轻轻合上。';
  const low = postureFeature(performative);
  const high = postureFeature(restrained);
  assert(low < high, `表演式文本 posture 应更低（${low} < ${high}）`);
  assert(high > 0.7, `克制文本 posture 应健康（${high}）`);
  const m = modulate(w, restrained, {});
  assert(typeof m.features.posture === 'number', 'modulate 特征含 posture');
  const cs = contrastiveScore(null, w, restrained, {});
  assert(typeof cs.posture === 'number', '得分分解含 posture');
  // 软性：posture 只参与加权评分，不产生拒绝/硬失败
  const bad = modulate(w, performative, {});
  assert(typeof bad.score === 'number' && bad.score !== -Infinity, 'posture 软性加权，不拒绝生成');
  console.log('PASS 姿态层细读特征（posture 健康度/软性加权/得分分解）');
}

// 7) 个人回避库（v0.68，B1）：作者亲手删掉的词聚合为回避特征，命中即压低
{
  fs.appendFileSync(
    path.join(w, 'vault', 'edits.jsonl'),
    JSON.stringify({ original: '综上所述，我们应该充分发挥作用。', changed: '风停。门合。', intent: '去套话' }) + '\n',
  );
  const av = avoidanceMod.collectAvoidance(w);
  assert(av.ok === true, '回避库可聚合');
  assert(Object.keys(av.terms).some((t) => t.includes('综上')), '被删的「综上所述」进入回避库');
  const hit = avoidanceFeature(w, '综上所述，我们应该充分发挥作用。');
  const clean = avoidanceFeature(w, '门开着。石阶旧。风从里面出来。');
  assert(hit < clean, `命中回避词应压低（${hit} < ${clean}）`);
  const m = modulate(w, '综上所述，我们应该充分发挥作用。', {});
  assert(typeof m.features.avoidance === 'number', 'modulate 特征含 avoidance');
  console.log('PASS 个人回避库（聚合/命中压低/特征入评分）');
}

// 8) 上下文窗口化编辑对（v0.68，B2）：带原文上下文的偏好对训练仍成立
{
  const ctxEdits = [
    {
      original: '因此我们要重视这个问题',
      changed: '这个问题搁在桌上，没人动',
      intent: '去连接词',
      ctxBefore: '老师在黑板上写了一个字。',
      ctxAfter: '下课铃响了。',
    },
    {
      original: '总而言之，历史值得铭记',
      changed: '纪念牌上的字，我念了一遍',
      intent: '留白',
      ctxBefore: '我站在楼前。',
      ctxAfter: '风从门里出来。',
    },
  ];
  fs.writeFileSync(
    path.join(w, 'vault', 'edits.jsonl'),
    ctxEdits.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const r = forceRetrain(w);
  assert(r.ok === true, '上下文编辑对训练成功');
  assert(r.meta.pairs === 2, '上下文对计入训练');
  const mPos = modulate(w, '这个问题搁在桌上，没人动。下课铃响了。', {});
  const mNeg = modulate(w, '因此我们要重视这个问题。下课铃响了。', {});
  assert(mPos.score > mNeg.score, '上下文对训练后"改后 > 原文"');
  console.log('PASS 上下文窗口化编辑对（ctxJoin 训练/排序正确）');
}

// 9) 可解释层（v0.68，B7）：贡献分解 + 人话理由
{
  const m = modulate(w, '纪念牌上的字，我念了一遍。风从门里出来。', {});
  assert(Array.isArray(m.contributions) && m.contributions.length === FEATURES.length, '贡献分解覆盖全部特征');
  assert(typeof m.rationale === 'string' && m.rationale.length > 0, '人话理由非空');
  const human = humanRationale(m.contributions);
  assert(human.includes('笔迹') || human.includes('回避') || human.includes('均衡'), `理由可读（${human}）`);
  const sorted = contributionBreakdown(m.weights, m.features, null);
  for (let i = 1; i < sorted.length; i++) {
    assert(Math.abs(sorted[i - 1].contrib) >= Math.abs(sorted[i].contrib), '贡献按绝对值降序');
  }
  console.log('PASS 可解释层（贡献分解/人话理由/排序）');
}

// 预测-误差闭环：模型预测作者选择，越惊讶增量学习步长越大
{
  const { predictEdit } = await import(path.join(HERE, '..', 'src', 'modulator.js'));
  const p = predictEdit(w, { original: '门开着，石阶旧，被磨得发亮。', changed: '我们要充分发挥这件事的积极作用。' });
  assert(p.ok === true && typeof p.margin === 'number' && typeof p.surprise === 'number', '预测返回边距与惊讶度');
  assert(p.predicted === 'original', `模型应预测"原文"（因为这条违反已学的具体化风格）：${p.predicted}`);
  assert(p.surprise > 0, `预测错误 → 惊讶度应 > 0：${p.surprise}`);
  console.log('PASS 预测-误差闭环（predictEdit 惊讶度）');
}

console.log('\n✓ modulator.test.mjs 全部通过');
