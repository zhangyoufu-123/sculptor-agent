// v1.1 自主决策测试：LLM 决定下一步动作（mock LLM），失败时安全回退。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { decideNextAction } = await import(path.join(HERE, '..', 'src', 'director.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'director-decide-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

// mock LLM：返回"ask"动作
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const content = body.messages?.some((m) => /写作导演/.test(m.content || ''))
    ? '{"action":"ask","phase":"clarify","reason":"需要先了解主题"}'
    : '{"action":"outline"}';
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
};

// 1) 正常决策
{
  const r = await decideNextAction({ apiKey: 'mock', retries: 1 }, w, { lastInput: '写一篇散文' });
  assert(r.ok === true && r.action === 'ask' && r.source === 'llm', `决策应为 ask（${JSON.stringify(r)}）`);
  console.log('PASS 自主决策（LLM 决定下一步）');
}

// 2) LLM 失败 → 返回 source=error，由调用方回退状态机
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r = await decideNextAction({ apiKey: 'mock', retries: 1 }, w, { lastInput: '写一篇散文' });
  assert(r.ok === false && r.source === 'error', 'LLM 失败应回退');
  console.log('PASS 自主决策失败回退');
}

console.log('\n✓ director.test.mjs 全部通过');
