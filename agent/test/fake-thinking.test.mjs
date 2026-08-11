// v0.52 单测：假思考检测——统计层抓不到的姿态层 AI 味
// （金句排比收束 / 路标式转折 / 点题式顿悟）；用《语言匮乏》与《差生》真实句子做回归样例。
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { audit } = await import(path.join(HERE, '..', 'src', 'redteam.js'));
const { WRITE_PROMPT, EXPAND_PROMPT, REDTEAM_FIX_PROMPT } = await import(
  path.join(HERE, '..', 'src', 'prompts.js'),
);

// 1) 金句排比收束：命中"话到嘴边，是话还在，是嘴还在，是我们还在"式同义反复
{
  const bad =
    '我站起来，想把这些话说出来。话到嘴边，是话还在，是嘴还在，是我们还在。\n' +
    '后来我想，这也许就是答案。原来语言不是消失了，是简化了。';
  const r = audit(bad);
  assert(
    (r.fakeThinking || []).some((s) => s.includes('金句排比收束')),
    '命中金句排比收束',
    JSON.stringify(r.fakeThinking),
  );
  assert((r.fakeThinking || []).some((s) => s.includes('路标式转折')) === false, '单次"后来我想"不误报路标');
  console.log('PASS 金句排比收束检测（《语言匮乏》式结尾）');
}

// 2) 路标式转折：连续 3 次"后来我想/但这里头有个悖论"式 → 命中
{
  const bad =
    '后来我想，这是为什么。\n但这里头有个悖论，我绕了很久才绕出来。\n然后我就想，也许答案很简单。';
  const r = audit(bad);
  assert((r.fakeThinking || []).some((s) => s.includes('路标式转折')), '命中路标式转折');
  console.log('PASS 路标式转折检测（走流程的转折）');
}

// 3) 不误伤：《差生》的克制结尾——"他叫我同学。我没有纠正他。"不应命中假思考
{
  const good =
    '我走出去，帮他把纸箱推过坡。他回头看我，眼睛弯着。他说："谢谢你啊，同学。"\n' +
    '他叫我同学。我没有纠正他。\n我把钥匙塞进兜里，走了。';
  const r = audit(good);
  assert((r.fakeThinking || []).length === 0, '克制结尾不误伤', JSON.stringify(r.fakeThinking));
  console.log('PASS 《差生》式克制结尾不误伤');
}

// 4) 提示词前置禁令：写作/扩写/红队修复都带"反假思考"
{
  const wctx = { title: 't', section: { heading: 'h', function: 'f' }, words: 800 };
  const ectx = { heading: 'h', function: 'f', target: 800, actual: 400, text: 'x' };
  assert(WRITE_PROMPT(wctx).includes('反金句收束'), 'WRITE_PROMPT 前置反金句收束');
  assert(WRITE_PROMPT(wctx).includes('反表演思考'), 'WRITE_PROMPT 前置反表演思考');
  assert(EXPAND_PROMPT(ectx).includes('反假思考'), 'EXPAND_PROMPT 前置反假思考');
  assert(REDTEAM_FIX_PROMPT({}).includes('假思考痕迹'), 'REDTEAM_FIX_PROMPT 修复假思考');
  console.log('PASS 提示词前置禁令（写作/扩写/修复三层）');
}

console.log('\n✓ fake-thinking.test.mjs 全部通过');
