// v1.7 改迹变换测试：从编辑对学"作者新增/删除什么"，候选贴合度据此打分。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { collectEditTransform, editFitScore, applyAuthorEdits } = await import(
  path.join(HERE, '..', 'src', 'edit-transform.js')
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-edit-transform-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
const vault = path.join(w, 'vault');
fs.mkdirSync(vault, { recursive: true });
// 作者把"抽象陈述"改成"具体意象"：删除"重视/问题"，新增"搁在桌上/没人动"
fs.writeFileSync(
  path.join(vault, 'edits.jsonl'),
  [
    JSON.stringify({ original: '我们要重视这个问题。', changed: '这个问题搁在桌上，没人动。', intent: '具体化' }),
    JSON.stringify({ original: '他感到很难过。', changed: '他低着头，没有说话。', intent: '具体化' }),
  ].join('\n') + '\n',
);

// 1) 聚合：能学到正方向（新增词）与负方向（删除词）
{
  const p = collectEditTransform(w);
  assert(p.ok === true, '有编辑对 → ok');
  assert(Object.keys(p.added).length > 0, '学到新增词');
  assert(Object.keys(p.deleted).length > 0, '学到删除词');
  console.log('PASS 改迹变换聚合（新增词 + 删除词）');
}

// 2) 贴合度：命中新增词的文本更高，命中删除词的文本更低
{
  const p = collectEditTransform(w);
  const good = '这个问题搁在桌上，没人动。他低着头，没有说话。';
  const bad = '我们要重视这个问题，他真的很难过。';
  const sGood = editFitScore(p, good);
  const sBad = editFitScore(p, bad);
  assert(sGood > sBad, `贴合度：改后风格 > 原文风格（${sGood.toFixed(3)} > ${sBad.toFixed(3)}）`);
  assert(editFitScore(p, '无关文本xyz。') === 0.5, '无命中 → 中性 0.5');
  console.log('PASS 改迹贴合度（正方向 > 负方向）');
}

// 3) 拟改层：只删"作者删过且安全可删"的连接词，不删内容词，并记录应用清单
{
  const profile = { ok: true, deleted: { 因此: 2, 所以: 1, 重要: 1 }, added: {} };
  const r = applyAuthorEdits('在当今社会，因此我们要重视这个问题。所以我们应该行动。', profile);
  assert(!r.text.includes('因此') && !r.text.includes('所以'), '删除连接词');
  assert(r.text.includes('这个问题'), '不删内容词');
  assert(r.applied.length === 2, `记录应用 2 条删除（${r.applied.length}）`);
  assert(!r.text.includes('。。') && !r.text.includes('，。'), '断句/标点已规范化');
  console.log('PASS 拟改层（删除连接词 + 断句 + 可追溯）');
}

console.log('\n✓ edit-transform.test.mjs 全部通过');
