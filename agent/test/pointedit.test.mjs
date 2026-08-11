// v0.46 单测：候选改写（3 候选不落盘）+ 直接应用候选（定位校验/写回/风格吸收）。
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
const { pointEdit, rewriteVariants } = await import(path.join(HERE, '..', 'src', 'point-edit.js'));

const cfg = { ...loadConfig(), apiKey: 'mock' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-pointedit-'));
const wsDir = ws.ensureWorkspace(tmp, { create: true });
const draftFile = path.join(tmp, 'draft.md');
const ORIG = '## 一、门口\n\n石阶被磨亮了一百年，门是深红色的。\n';
fs.writeFileSync(draftFile, ORIG);

// 1) 候选改写：3 个方向不同的候选，且不落盘
{
  const before = fs.readFileSync(draftFile, 'utf8');
  const r = await rewriteVariants(cfg, tmp, {
    quote: '石阶被磨亮了一百年，门是深红色的。',
    instruction: '更口语化一点',
    dir: tmp,
    file: draftFile,
  });
  assert(r.candidates.length === 3, `返回 3 个候选（实际 ${r.candidates.length}）`);
  assert(new Set(r.candidates).size === 3, '候选互不相同');
  assert(fs.readFileSync(draftFile, 'utf8') === before, '候选生成不落盘');
  console.log('PASS 候选改写：3 个不同候选、不落盘');
}

// 2) 直接应用候选：写回 + 吸收进风格档案（edits.jsonl）
{
  const r = await rewriteVariants(cfg, tmp, {
    quote: '石阶被磨亮了一百年，门是深红色的。',
    instruction: '更口语化一点',
    dir: tmp,
    file: draftFile,
  });
  const out = await pointEdit(cfg, tmp, {
    quote: '石阶被磨亮了一百年，门是深红色的。',
    instruction: '更口语化一点',
    dir: tmp,
    file: draftFile,
    replacement: r.candidates[0],
  });
  const text = fs.readFileSync(draftFile, 'utf8');
  assert(text.includes(out.replacement), '候选已写回草稿');
  assert(!text.includes('石阶被磨亮了一百年，门是深红色的。'), '原句已被替换');
  const edits = fs.readFileSync(path.join(tmp, 'vault', 'edits.jsonl'), 'utf8');
  assert(edits.includes('更口语化一点'), '修改意图进入风格档案（edits.jsonl）');
  console.log('PASS 应用候选：写回 + 风格吸收');
}

// 3) 常规 point-edit（无 replacement）仍走 LLM 路径
{
  const before = fs.readFileSync(draftFile, 'utf8');
  const quote = before.includes('那扇窗') ? '那扇窗' : '窗还是那扇窗';
  const target = before.includes('那扇窗没有开口') ? '那扇窗没有开口，却什么都知道。' : quote;
  const out = await pointEdit(cfg, tmp, {
    quote: target,
    instruction: '再克制一点',
    dir: tmp,
    file: draftFile,
  });
  assert(out.replacement && out.replacement.length > 0, 'LLM 改写路径可用');
  console.log('PASS 常规 point-edit（无候选）路径可用');
}

console.log('\n✓ pointedit.test.mjs 全部通过');
