// v0.26 对话引导参考落地验证：L0–L5 回答分级 + 澄清确认清单。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { classifyAnswerLevel, checklistOf } = await import(path.join(HERE, '..', 'src', 'clarify.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));

const CASES = [
  ['', 0],
  ['随便', 0],
  ['你决定吧', 0],
  ['b', 1],
  ['私人纪念', 1],
  ['那几棵银杏，一架葡萄藤，三年重复', 2],
  ['毕业就是那个戈多', 3],
  ['不不不，这些作案背后有的只是悲凉和反抗', 4],
  ['"好"改为"挺好"', 5],
  ['说话要有双引号，留白不能一直留', 5],
];

for (const [input, expect] of CASES) {
  const got = classifyAnswerLevel(input);
  assert.strictEqual(got, expect, `L 级判定: ${JSON.stringify(input)} → ${got}，期望 L${expect}`);
}
console.log(`PASS L0–L5 回答分级（${CASES.length} 例）`);

// 确认清单：部分确认时 done 状态正确
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-guide-test-'));
  const w = ws.ensureWorkspace(tmp, { create: true });
  const state = ws.readState(w);
  state.confirmed = { topic: '北大红楼', genre: '散文', targetWords: 800 };
  state.materials = [];
  const cl = checklistOf(state);
  assert(cl.length >= 4, '清单至少包含核心字段');
  const topic = cl.find((c) => c.label.includes('主题'));
  const stance = cl.find((c) => c.label.includes('立场'));
  assert(topic && topic.done, '主题已确认 → ✓');
  assert(stance && !stance.done, '立场未确认 → …');
  console.log(`PASS 澄清确认清单（${cl.length} 项，done 状态正确）`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n✓ guide 全部通过');
