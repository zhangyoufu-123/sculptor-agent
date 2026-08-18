// polish 质量自动循环 + 多角度查询单测。
// 运行: node test/polish.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { polishLoop, POLISH_RENDER } from '../src/polish.js';
import { buildSearchQueries } from '../src/rag.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// 1. 无 LLM 时:只报告不空转、不崩溃
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-polish-'));
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, 'protocol'), { recursive: true });
fs.mkdirSync(path.join(wsDir, 'vault'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'protocol', 'state.json'), JSON.stringify({}));
fs.writeFileSync(path.join(wsDir, 'vault', 'write-style.json'), JSON.stringify({ dimensions: {} }));
const AI_DRAFT = '在当今社会，随着科技的快速发展，我们必须要认识到，总而言之，首先我们要重视这个问题，其次我们要解决这个问题，最后我们要反思这个问题。众所周知，创新是发展的动力，创新是进步的源泉，创新是未来的希望。';
fs.writeFileSync(path.join(wsDir, 'draft.md'), AI_DRAFT);

const cfg = { apiKey: '', baseUrl: '', model: '', timeoutMs: 1000, retries: 0 };
const r = await polishLoop(cfg, wsDir, {});
assert.equal(r.llmUsed, false, '无 LLM 不应重写');
assert.ok(r.rounds === 0, '无 LLM 不进入重写循环');
assert.ok(typeof r.final.score === 'number', '有最终分数');
assert.ok(r.final.score < 60, 'AI 味草稿分数应 <60');
assert.ok(POLISH_RENDER(r).includes('人类化指数'), '渲染包含分数');
// 不覆盖用户草稿(无 LLM 不写回)
assert.equal(fs.readFileSync(path.join(wsDir, 'draft.md'), 'utf8'), AI_DRAFT, '无 LLM 不改写草稿');
ok('polish 无 LLM:只报告不空转、不崩溃、不覆盖');

// 2. 退让协议:draft 被外部修改 → 报错让路(需先有 state.lastDraftHash,由 write 写入)
import { createHash } from 'node:crypto';
const hash = (t) => createHash('sha1').update(t).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(wsDir, 'draft.md'), AI_DRAFT);
fs.writeFileSync(path.join(wsDir, 'protocol', 'state.json'), JSON.stringify({ lastDraftHash: hash(AI_DRAFT) }));
fs.writeFileSync(path.join(wsDir, 'draft.md'), '外部修改后的内容。');
try {
  await polishLoop(cfg, wsDir, {});
  assert.fail('应触发退让协议');
} catch (e) {
  assert.ok(/外部修改/.test(e.message), '退让协议提示');
}
ok('polish 退让协议:外部修改不覆盖');

// 3. 多角度查询:topic 生成 6 角度
const queries = buildSearchQueries('关于 AI 写作', { topic: 'AI 写作' });
assert.ok(queries.some((q) => q.includes('背景')), '含背景角度');
assert.ok(queries.some((q) => q.includes('案例')), '含案例角度');
assert.ok(queries.some((q) => q.includes('数据')), '含数据角度');
assert.ok(queries.some((q) => q.includes('对比')), '含对比角度');
assert.ok(queries.some((q) => q.includes('争议')), '含争议角度');
assert.ok(queries.some((q) => q.includes('最新')), '含最新进展角度');
assert.ok(queries.length <= 6, '不超 limit');
ok('多角度查询:6 角度生成');

// 4. 事实片段优先:verify 项与具体事实在角度之前
const queries2 = buildSearchQueries('2024 年发表', { topic: 'AI', factReport: { items: [{ text: '某具体事实 42 项', supported: 'verify' }] }, limit: 8 });
assert.ok(queries2[0].includes('某具体事实'), 'verify 项优先');
assert.ok(queries2.some((q) => q.includes('2024')), '年份片段保留');
ok('事实片段优先于角度查询');

// 5. 去重:同一 topic 不重复
const queries3 = buildSearchQueries('', { topic: '同一个主题' });
assert.equal(new Set(queries3).size, queries3.length, '查询无重复');
ok('查询去重');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\npolish.test.mjs 全部通过 (${passed} 项)`);
