// v1.7 具体化拟改测试：检测方向 + few-shot 提示词 + 软性降级。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { detectConcretizationPairs, buildConcretizationPrompt, concretize } = await import(
  path.join(HERE, '..', 'src', 'concretize.js')
);

const PAIRS = [
  { original: '我们要重视这个问题。', changed: '这个问题搁在桌上，没人动。' },
  { original: '他感到很难过。', changed: '他低着头，没有说话。' },
  { original: '历史具有深远的意义。', changed: '历史不响，它只是等着。' },
  { original: '这个字写错了。', changed: '这个字写对了。' }, // 非具体化（事实修正）
];

// 1) 检测：挑出具体化方向的对，排除事实修正
{
  const c = detectConcretizationPairs(PAIRS);
  assert(c.length === 3, `应识别 3 条具体化（实际 ${c.length}）`);
  assert(c.every((p) => p.original && p.changed), '保留原文/改后');
  console.log('PASS 具体化方向检测');
}

// 2) 提示词：含 few-shot 示例与目标文本
{
  const msgs = buildConcretizationPrompt(PAIRS.slice(0, 3), '这段需要改得更具体。');
  assert(msgs.length === 2 && msgs[0].role === 'system', 'system + user 两段');
  assert(msgs[1].content.includes('原文：我们要重视这个问题'), '含作者示例');
  assert(msgs[1].content.includes('这段需要改得更具体'), '含目标文本');
  console.log('PASS few-shot 提示词组装');
}

// 3) 拟改：mock LLM 返回改后文本；失败降级为原样退回
{
  const gen = async () => '这个问题搁在桌上，没人动。历史不响，它只是等着。';
  const r = await concretize({}, PAIRS.slice(0, 2), '我们要重视这个问题。', gen);
  assert(r.ok === true && r.text.includes('搁在桌上'), '返回拟改文本');
  const bad = await concretize({}, PAIRS.slice(0, 2), '目标文本', async () => {
    throw new Error('network');
  });
  assert(bad.ok === false && bad.text === '目标文本', '失败降级原样退回');
  console.log('PASS 具体化拟改 + 软性降级');
}

console.log('\n✓ concretize.test.mjs 全部通过');
