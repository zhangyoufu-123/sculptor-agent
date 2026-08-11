// v0.43 单测：思想脉络——用户抛出理论/因果推理时，提炼并累积"主张/前提/推理/来源"，
// 追问设计师据此"向下挖一层"，与用户达成思想共识。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const content = respond(body.messages || []);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
};

const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { clarifyStep } = await import(path.join(HERE, '..', 'src', 'clarify.js'));
const {
  extractThinkingSignals,
  updateThinkingThread,
  thinkingBrief,
} = await import(path.join(HERE, '..', 'src', 'thinking.js'));

const cfg = { ...loadConfig(), apiKey: 'mock' };

// 1) 确定性信号识别
{
  const theory = extractThinkingSignals(
    '我记得同学们总爱说各种烂梗，阻碍了交流。我看过《乡土中国》的文字下乡，里面讲语言文字的简化是文化发展的结果，可以顺着这个思路推理。',
  );
  assert(theory.hasThinking, '理论发言应识别为有思想');
  assert(theory.signals.some((s) => s.kind === 'source' && s.snippet.includes('乡土中国')), '识别书籍来源');
  assert(theory.signals.some((s) => s.kind === 'inference'), '识别因果推理');
  const plain = extractThinkingSignals('我想写一篇关于北大红楼的散文，八百字左右');
  assert(!plain.hasThinking, '普通素材发言不误判为思想');
  console.log('PASS 确定性思想信号识别（理论/书籍/推理 vs 普通发言）');
}

// 2) 思想脉络累积与按来源合并
{
  const state = { thinking: [] };
  updateThinkingThread(
    state,
    '我看过《乡土中国》的文字下乡，语言简化是文化发展的结果，可以顺着推理。',
  );
  assert(state.thinking.length === 1, '第一条思想入列');
  assert(state.thinking[0].source.includes('乡土中国'), '来源被记录');
  const before = state.thinking.length;
  updateThinkingThread(
    state,
    '所以《乡土中国》里说的简化，放到烂梗上就是简化过头切断了共同意义。',
  );
  assert(state.thinking.length === before, '同来源思想合并不重复入列');
  assert(state.thinking[0].inference || state.thinking[0].claim, '合并时补全字段');
  const brief = thinkingBrief(state);
  assert(brief.includes('乡土中国'), '摘要包含来源');
  console.log('PASS 思想脉络累积/合并/摘要');
}

// 3) 澄清全链路：用户抛理论 → 下一问"向下挖一层"（思想层追问），思想入 state
{
  const w = ws.ensureWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-thinking-')), {
    create: true,
  });
  const r = await clarifyStep(cfg, w, {
    lastInput:
      '我记得学校中同学们总是非常爱说各种烂梗，阻碍了交流。我看过《乡土中国》的文字下乡，里面讲语言文字的简化是文化发展的结果，可以顺着这个思路推理。',
  });
  assert(r.question && r.question.includes('我理解你的主张'), `思想层追问出现（${String(r.question).slice(0, 40)}）`);
  const st = ws.readState(w);
  assert(Array.isArray(st.thinking) && st.thinking.length >= 1, '思想已写入 state');
  assert(st.thinking[0].source && st.thinking[0].source.includes('乡土中国'), '理论来源入库');
  console.log('PASS 澄清全链路：理论发言 → 思想层追问 + 思想入库');
}

console.log('\n✓ thinking.test.mjs 全部通过');
