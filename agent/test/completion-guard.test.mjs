// v0.49 单测：确定性收尾护栏（导演侧）——蓝图字段全部确认后，LLM 仍反复追问时，
// 连续 2 轮无缺口即强制放行进大纲（interview 等独立流程不受影响）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { agentStep } = await import(path.join(HERE, '..', 'src', 'director.js'));

const cfg = { ...loadConfig(), apiKey: 'mock' };

// 模拟"永远不停问"的 LLM：蓝图再完整也返回新问题；只有大纲生成（提纲设计师）给合法 JSON。
const NEVER_STOP = JSON.stringify({
  question: '你还有别的想法想补充吗？',
  recommendation: '没有的话我们就继续',
  options: [],
  blueprintUpdate: {},
  outlineUpdate: { title: '', sections: [] },
  outlineComplete: false,
  stop: false,
});
const OUTLINE_MOCK = JSON.stringify({
  title: '测试论文',
  sections: [
    { heading: '一、引言', function: '铺垫', thesis: '主题', words: 800, keyPoints: ['点'], materials: ['素材一'] },
    { heading: '二、方法', function: '展开', thesis: '方法', words: 800, keyPoints: ['点'], materials: ['素材二'] },
  ],
});
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts?.body || '{}');
  const msgs = JSON.stringify(body.messages || []);
  const content = msgs.includes('提纲设计师') ? OUTLINE_MOCK : NEVER_STOP;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
  };
};

const w = ws.ensureWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-guard-')), {
  create: true,
});
const st = ws.readState(w);
st.confirmed = {
  topic: '测试主题',
  stance: '立场',
  audience: '读者',
  theme: '立意',
  targetWords: 800,
  emotionalCurve: '先平后起',
  endingTaste: '留白',
  styleSample: true,
};
st.materials = ['素材一', '素材二', '素材三', '素材四'];
ws.writeState(w, st);

// 第一轮：字段全齐但 LLM 仍在问 → 正常返回问题（extraRounds=1）
const r1 = await agentStep(cfg, w, { lastInput: '补充一点细节' });
assert(r1.kind === 'ask' && r1.question.includes('还有别的想法'), '第一轮仍返回问题（护栏未误伤正常追问）');

// 第二轮：仍无缺口仍被问 → 确定性放行 → 直接进入大纲确认
const r2 = await agentStep(cfg, w, { lastInput: '再补充一点' });
assert(r2.kind === 'confirm_outline', `第二轮强制放行进大纲（实际 kind=${r2.kind}）`);
assert((r2.outline?.sections || []).length >= 2, '大纲已由 LLM 生成');

// extraRounds 已复位，下一轮重新计数
const st2 = ws.readState(w);
assert(st2.extraRounds === 0, 'extraRounds 复位');

console.log('\n✓ completion-guard.test.mjs 全部通过');
