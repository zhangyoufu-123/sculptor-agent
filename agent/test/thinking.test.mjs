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
const { missingNeed } = await import(path.join(HERE, '..', 'src', 'clarify.js'));
const { genreBlueprint } = await import(path.join(HERE, '..', 'src', 'genre.js'));
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

// 4) 提问主次（v0.43）：表达层先、内容层次之、规划参数（字数）最后
{
  const keys = genreBlueprint('散文').map((f) => f.key);
  assert(keys[keys.length - 1] === 'targetWords', `字数最后问（实际最后: ${keys[keys.length - 1]}）`);
  const stanceIdx = keys.indexOf('stance');
  const themeIdx = keys.indexOf('theme');
  const matIdx = keys.indexOf('materials');
  const twIdx = keys.indexOf('targetWords');
  assert(stanceIdx < matIdx && themeIdx < matIdx && matIdx < twIdx, '表达层→内容层→规划层顺序正确');
  console.log('PASS 蓝图字段主次：主题/立意 → 素材/论点 → 字数最后');
}

// 5) need 顺序：topic 已确认 → 先问表达层（stance），而不是字数
{
  const state = { confirmed: { topic: '北大红楼' }, materials: [] };
  assert(missingNeed(state) === 'stance', `表达层先于规划层（实际: ${missingNeed(state)}）`);
  console.log('PASS 首问表达层而非字数');
}

// 6) 预算联动：字数确认后按新预算回补素材；字数本身在内容齐后才问
{
  const base = {
    confirmed: {
      topic: '教育变革',
      stance: '想表达能力培养比知识灌输重要',
      theme: '教育要转向能力',
      styleSample: true,
    },
    materials: [],
  };
  const needBeforeWords = missingNeed(base);
  assert(needBeforeWords === 'materials', `字数未确认时先补素材（实际: ${needBeforeWords}）`);
  const withWords = {
    ...base,
    confirmed: { ...base.confirmed, targetWords: 3000 },
    materials: ['芬兰教育', '可汗学院'],
  };
  assert(missingNeed(withWords) === 'materials', '字数 3000 后按新预算回补素材');
  const full = {
    ...base,
    confirmed: { ...base.confirmed, audience: '家长', emotionalCurve: '先疑再信', endingTaste: '心安' },
    materials: Array.from({ length: 10 }, (_, i) => `素材${i}`),
    arguments: ['论点一', '论点二'],
  };
  assert(missingNeed(full) === 'targetWords', `内容齐了才问字数（实际: ${missingNeed(full) || '（无缺口）'}）`);
  console.log('PASS 预算联动：字数最后问，确认后自动回补素材');
}

console.log('\n✓ thinking.test.mjs 全部通过');
