// 输入治理控制面测试：持久化、可编辑、保守抽取、回灌简述、澄清种子化。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const gov = await import(path.join(HERE, '..', 'src', 'governance.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-gov-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

// 1. 默认空档案 + 简述为空
assert.equal(gov.readGovernance(w).authorIntent, '');
assert.equal(gov.governanceBrief(w), '');

// 2. 手工编辑长期意图与当前聚焦
gov.updateGovernance(w, { authorIntent: '想成为克制、留白的写作者', currentFocus: '这一篇聚焦母亲的手' });
const g1 = gov.readGovernance(w);
assert.equal(g1.authorIntent, '想成为克制、留白的写作者');
assert.equal(g1.currentFocus, '这一篇聚焦母亲的手');
assert.match(gov.governanceBrief(w), /长期意图：想成为克制、留白的写作者/);
assert.match(gov.governanceBrief(w), /当前聚焦：这一篇聚焦母亲的手/);

// 3. 只更新 focus，不冲掉长期意图
gov.updateGovernance(w, { currentFocus: '改成聚焦那扇旧窗' });
assert.equal(gov.readGovernance(w).authorIntent, '想成为克制、留白的写作者');
assert.equal(gov.readGovernance(w).currentFocus, '改成聚焦那扇旧窗');

// 4. 保守抽取：明确标记才认，臆测不认
const s1 = gov.extractGovernanceSignals('我的风格就是尽量克制、少抒情，多用细节说话');
assert.equal(s1.authorIntent, '尽量克制、少抒情，多用细节说话');
const s2 = gov.extractGovernanceSignals('这次重点写父亲沉默的那一下');
assert.equal(s2.currentFocus, '这次重点写父亲沉默的那一下');
assert.equal(gov.extractGovernanceSignals('嗯，继续吧'), null);

// 5. 从输入温和更新：currentFocus 覆盖，authorIntent 只在为空时补
const w2 = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
gov.updateGovernance(w2, { authorIntent: '长期想成为冷静的观察者' });
gov.maybeUpdateGovernanceFromInput(w2, '注意先抓住门与风的关系');
assert.equal(gov.readGovernance(w2).currentFocus, '注意先抓住门与风的关系');
assert.equal(gov.readGovernance(w2).authorIntent, '长期想成为冷静的观察者');

// 6. 澄清种子化：当前聚焦来自 intent.coreNeed；长期意图不被单篇任务污染
const w3 = ws.ensureWorkspace(path.join(tmp, 'w3'), { create: true });
gov.seedGovernanceFromClarify(w3, { intent: { coreNeed: '写一篇给母亲看的散文', summary: '' } });
assert.equal(gov.readGovernance(w3).currentFocus, '写一篇给母亲看的散文');
assert.equal(gov.readGovernance(w3).authorIntent, '');

console.log('PASS 输入治理控制面（持久化/编辑/保守抽取/回灌/澄清种子化）');
