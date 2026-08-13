// v1.7 词级文体计量测试：功能词 + 标点节奏是比字符 n-gram 更稳的作者风格信号。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stylo = await import(path.join(HERE, '..', 'src', 'stylometry.js'));

// 1) 向量提取：功能词 + 标点都被记录
{
  const v = stylo.stylometricVector('因为风很大，所以我站在旧的门口。历史不响，它只是等着。');
  assert(typeof v['w:的'] === 'number' && v['w:的'] > 0, '记录功能词「的」');
  assert(typeof v['p:。'] === 'number' && v['p:。'] > 0, '记录句号');
  assert(typeof v['w:因为'] === 'number' && v['w:因为'] > 0, '记录多字连接词「因为」');
  console.log('PASS 文体计量向量提取（功能词 + 标点）');
}

// 2) 相似度：同风格文本余弦高于异风格
{
  const a = stylo.stylometricVector('门开着。石阶旧。风从里面出来。历史不响，它只是等着。');
  const b = stylo.stylometricVector('木梯窄，每一步都响。窗台积灰。我没有擦，只是看。');
  const c = stylo.stylometricVector('在当今社会，随着科技的飞速发展，因此综上所述，我们应当充分发挥前所未有的积极作用。');
  const ab = stylo.stylometricCosine(a, b);
  const ac = stylo.stylometricCosine(a, c);
  assert(ab > ac, `同风格应更相似（${ab.toFixed(3)} > ${ac.toFixed(3)}）`);
  assert(stylo.stylometricCosine(a, a) === 1, '自身余弦为 1');
  console.log('PASS 文体计量余弦（同风格 > 异风格）');
}

// 3) 质心：多向量均值
{
  const c = stylo.stylometricCentroid([
    { 'w:的': 0.1, 'p:。': 0.2 },
    { 'w:的': 0.3, 'p:。': 0.4 },
  ]);
  assert(Math.abs(c['w:的'] - 0.2) < 1e-9 && Math.abs(c['p:。'] - 0.3) < 1e-9, '质心取均值');
  console.log('PASS 文体计量质心');
}

// 4) 表层节奏相对贴合：与作者质心更近的文本得分更高
{
  const profile = stylo.surfaceProfile([
    '门开着。石阶旧。风从里面出来。历史不响，它只是等着。',
    '木梯窄，每一步都响。窗台积灰。我没有擦，只是看。',
  ]);
  const like = stylo.surfaceMatch(profile, '回头，楼还在。暮色里，红砖暗下去。过去不说话。');
  const unlike = stylo.surfaceMatch(profile, '在当今社会，随着科技的飞速发展，因此综上所述我们应当充分发挥前所未有的积极作用。');
  assert(like > unlike, `相对作者节奏应更贴合（${like.toFixed(3)} > ${unlike.toFixed(3)}）`);
  assert(stylo.surfaceMatch(null, '任意文本') === 0.5, '无 profile → 中性 0.5');
  console.log('PASS 表层节奏相对贴合');
}

console.log('\n✓ stylometry.test.mjs 全部通过');
