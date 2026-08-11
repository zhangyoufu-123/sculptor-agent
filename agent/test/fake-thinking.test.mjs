// v0.52 单测：假思考检测——统计层抓不到的姿态层 AI 味
// （金句排比收束 / 路标式转折 / 点题式顿悟）；用《语言匮乏》与《差生》真实句子做回归样例。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { audit } = await import(path.join(HERE, '..', 'src', 'redteam.js'));
const {
  diagnoseFakeThinking,
  renderFakeThinking,
  DIAGNOSE_PROMPT,
} = await import(path.join(HERE, '..', 'src', 'fake-thinking.js'));
const { WRITE_PROMPT, EXPAND_PROMPT, REDTEAM_FIX_PROMPT } = await import(
  path.join(HERE, '..', 'src', 'prompts.js'),
);
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));

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

// 5) LLM 六层细读（v0.53 主路径）：mock LLM 返回 voice/ending 病灶
{
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const cfg = { ...loadConfig(), apiKey: 'mock' };
  const w = ws.ensureWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-fake-llm-')), {
    create: true,
  });
  const r = await diagnoseFakeThinking(cfg, w, {
    text: '我只是一台搬运的机器，搬运得还挺熟练。话到嘴边，是话还在，是嘴还在，是我们还在。',
    genre: '散文',
    topic: '语言匮乏',
  });
  assert(r.mode === 'llm', `LLM 主路径（实际 ${r.mode}）`);
  assert(Number(r.score) === 72, '返回细读得分');
  assert(r.layers.includes('voice') && r.layers.includes('ending'), '六层细读层标记完整');
  assert(r.issues.some((i) => i.layer === 'voice' && i.fix), '病灶带修法');
  assert(renderFakeThinking(r).includes('LLM 六层细读'), '报告标注 LLM 模式');
  console.log('PASS LLM 六层细读（声音/收尾病灶）');
}

// 6) 无 key → 确定性兜底（主路径不可用也不中断）
{
  const w = ws.ensureWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-fake-det-')), {
    create: true,
  });
  const r = await diagnoseFakeThinking({ apiKey: '' }, w, {
    text: '话到嘴边，是话还在，是嘴还在，是我们还在。后来我想了很久。',
  });
  assert(r.mode === 'deterministic', `无 key 走确定性兜底（实际 ${r.mode}）`);
  assert(r.issues.length >= 1, '兜底仍能发现问题');
  console.log('PASS 无密钥确定性兜底');
}

// 7) 细读提示词带 RAG 作者对照（persona/个人 skill/检索来源）
{
  const p = DIAGNOSE_PROMPT({ authorContext: '【作者设定】', refs: '【同类文本】', text: '正文' });
  assert(p.includes('作者设定'), '细读注入作者设定');
  assert(p.includes('同类真实文本参考'), '细读注入 RAG 参考');
  assert(
    p.includes('voice（声音）') && p.includes('translate（翻译体）') && p.includes('ending（收尾）'),
    '六层维度齐全',
  );
  console.log('PASS 细读提示词 RAG 作者对照注入');
}

console.log('\n✓ fake-thinking.test.mjs 全部通过');
