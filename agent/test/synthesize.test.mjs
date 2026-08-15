// synthesize 单测：项目素材收集去重 + 确定性兜底成稿 + LLM 空输出降级。
// 运行: node test/synthesize.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectProjectMaterial,
  synthesizeDeterministic,
  synthesize,
  SYNTHESIZE_TARGETS,
} from '../src/synthesize.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// 临时项目：README + docs + 嵌套 md + 应跳过的目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-syn-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n本地优先的 AI 笔记工具。\n');
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', description: '描述', dependencies: { sqlite3: '^5' } }));
fs.writeFileSync(path.join(proj, 'docs', 'design.md'), '## 设计\nSQLite + FTS5。\n');
fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'README.md'), '依赖的 README，不应被收集\n');
fs.writeFileSync(path.join(proj, 'notes.txt'), '随手记录\n');

// 1. 收集去重 + 跳过 node_modules
const material = collectProjectMaterial(proj);
const names = material.map((m) => m.file);
assert.ok(names.filter((n) => n === 'README.md').length === 1, 'README.md 只收集一次(大小写去重)');
assert.ok(names.filter((n) => n === 'docs/design.md').length === 1, 'docs/design.md 只收集一次(双路去重)');
assert.ok(names.some((n) => n.includes('node_modules')) === false, '跳过 node_modules');
assert.ok(names.includes('notes.txt'), '收集顶层 txt');
ok('collectProjectMaterial 去重 + 跳过目录');

// 2. 确定性成稿骨架完整
const det = synthesizeDeterministic({ target: 'product', projectRoot: proj, material, log: '', topic: 'Demo 介绍' });
assert.ok(det.includes('# Demo 介绍'), '标题用 topic');
assert.ok(det.includes('产品介绍'), '文体标注');
assert.ok(det.includes('本地优先的 AI 笔记工具'), 'README 概览被提炼');
assert.ok(det.includes('sqlite3'), '依赖被提取');
assert.ok(det.includes('确定性模式'), '模式标注');
ok('synthesizeDeterministic 骨架完整');

// 3. 统一入口：无 LLM(空 cfg 直接抛) → 确定性降级
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, 'protocol'), { recursive: true });
fs.mkdirSync(path.join(wsDir, 'vault'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'protocol', 'state.json'), JSON.stringify({}));
fs.writeFileSync(path.join(wsDir, 'vault', 'write-style.json'), JSON.stringify({ dimensions: {} }));
const cfg = { apiKey: '', baseUrl: '', model: '', timeoutMs: 1000, retries: 0 };
const r = await synthesize(cfg, wsDir, { project: proj, target: 'report', topic: '实验报告' });
assert.equal(r.mode, 'deterministic', 'LLM 不可用降级为确定性');
assert.ok(r.files.length >= 1 && fs.existsSync(r.files[0]), '产物落盘');
assert.ok(r.files[0].includes('synthesized'), '产物在工作区 synthesized/');
assert.equal(r.target, 'report', 'target 透传');
ok('synthesize 统一入口 + 降级 + 落盘');

// 4. 文体枚举
assert.ok(SYNTHESIZE_TARGETS.product && SYNTHESIZE_TARGETS.readme && SYNTHESIZE_TARGETS.blog, '文体覆盖 product/readme/blog');
ok('文体覆盖');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nsynthesize.test.mjs 全部通过 (${passed} 项)`);
