// v0.62 统一 Token 对比解码 · V1 测试：个人模型（p_personal）可预测、
// 五路评分可追溯、候选对比解码选出更"像作者"的候选。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const {
  getPersonalModel,
  personalLogProb,
  personalCorpusSize,
} = await import(path.join(HERE, '..', 'src', 'personal-model.js'));
const {
  defectScore,
  impedanceScore,
  contrastiveScore,
  decodeSection,
} = await import(path.join(HERE, '..', 'src', 'token-decode.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-decode-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

// 风格样本：短句、口语、具体物象（"作者 A"语料）
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

// 1) 个人模型：能预测"作者更可能怎么写"（同语料风格文本得分高于异风格）
{
  const model = getPersonalModel(w);
  assert(model.ok === true, '个人模型训练成功');
  assert(personalCorpusSize(w) >= 80, '语料达到最小规模');
  const likeA = '门开着。石阶旧。历史不响，它只是等着。风从门里出来，带着木头的气味。';
  const unlike = '在当今社会，随着科技的飞速发展，因此综上所述，我们应当充分发挥前所未有的积极作用。';
  const pA = personalLogProb(model, likeA);
  const pB = personalLogProb(model, unlike);
  assert(pA > pB, `个人模型应偏好作者语料风格（${pA.toFixed(3)} > ${pB.toFixed(3)}）`);
  console.log('PASS 个人模型可预测（p_personal）');
}

// 2) 缺陷信号：AI 腔文本负偏置
{
  const ai = '在当今社会，随着科技的飞速发展，因此综上所述我们应当充分发挥前所未有的作用。';
  const plain = '门开着。石阶旧。风从里面出来。';
  assert(defectScore(ai) < defectScore(plain), 'AI 腔文本缺陷分更低');
  assert(impedanceScore('风起。门开。他站着。', 0.9) > impedanceScore('在当今社会，随着科技的发展，因此我们应当充分重视这个问题的重要性。', 0.9), '后期阻抗奖励短句');
  console.log('PASS 缺陷/阻抗信号');
}

// 3) 候选对比解码：五路评分选优 + 得分分解可追溯
{
  const gen = (msgs, opts) =>
    Promise.resolve(
      opts.temperature > 0.9
        ? '门开着。石阶旧，被磨得发亮。我在门口站了一会儿。历史不响，它只是等着。'
        : '在当今社会，随着科技的飞速发展，因此综上所述，我们应当充分发挥前所未有的积极作用。',
    );
  const r = await decodeSection({ apiKey: 'mock' }, w, {
    messages: [{ role: 'user', content: 'x' }],
    t: 0.9,
    generate: gen,
  });
  assert(r.mode === 'contrastive', `应为对比解码（${r.mode}）`);
  assert(Array.isArray(r.breakdown) && r.breakdown.length === 2, '得分分解含 2 个候选');
  assert(r.text.includes('门开着'), '选优结果应为更像作者的候选');
  for (const b of r.breakdown) {
    assert(typeof b.personal === 'number' && typeof b.defect === 'number', '每路得分可追溯');
  }
  console.log('PASS 候选对比解码选优 + 得分分解');
}

// 4) 无个人语料时降级为直接生成（不产生额外延迟）
{
  const w2 = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  const gen = (msgs, opts) => Promise.resolve('只有一句话。');
  const r = await decodeSection({ apiKey: 'mock' }, w2, { messages: [{ role: 'user', content: 'x' }], generate: gen });
  assert(r.mode === 'direct', `无语料应降级直接生成（${r.mode}）`);
  console.log('PASS 无语料降级直接生成');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ token-decode 全部通过');
