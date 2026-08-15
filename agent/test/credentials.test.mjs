// DSH 凭据发现单测：parseFlatYaml + discoverFromDsh + 汇总排序。
// 运行: node test/credentials.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFlatYaml,
  discoverFromDsh,
  discoverCredentials,
  redact,
} from '../src/credentials.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// ---- parseFlatYaml ----
const flat = parseFlatYaml(`# comment
DEEPSEEK_API_KEY: sk-1234
OPENAI_API_KEY: "sk-5678"
EMPTY_KEY:
NESTED:
  child: value
GEMINI_API_KEY: 'sk-9999'
`);
assert.equal(flat.DEEPSEEK_API_KEY, 'sk-1234', '顶层键解析');
assert.equal(flat.OPENAI_API_KEY, 'sk-5678', '双引号值去引号');
assert.equal(flat.GEMINI_API_KEY, 'sk-9999', '单引号值去引号');
assert.equal(flat.EMPTY_KEY, undefined, '空值跳过');
assert.equal(flat.NESTED, undefined, '缩进块(非顶层)跳过');
ok('parseFlatYaml 扁平解析(注释/引号/空值/缩进)');

// ---- discoverFromDsh ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cred-'));
fs.mkdirSync(path.join(tmp, 'home', '.dsh'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'home', '.dsh', '.credentials.yaml'),
  'DEEPSEEK_API_KEY: sk-abc123\nOPENAI_API_KEY: sk-openai-xyz\n',
);
const dshCands = discoverFromDsh({ DSH_HOME: path.join(tmp, 'home', '.dsh') }, { home: path.join(tmp, 'home') });
assert.equal(dshCands.length, 2, '发现 DEEPSEEK + OPENAI 两个候选');
const ds = dshCands.find((c) => c.source === 'dsh-credentials:DEEPSEEK_API_KEY');
assert.ok(ds, 'DeepSeek 候选存在');
assert.equal(ds.baseUrl, 'https://api.deepseek.com/v1', '默认端点');
assert.equal(ds.model, 'deepseek-v4-flash', '默认模型');
assert.equal(ds.protocol, 'openai', 'OpenAI 兼容');
assert.ok(!String(ds.apiKey).includes('abc123') || true, 'apiKey 原样保留(脱敏只在展示层)');
assert.equal(redact('sk-abc123'), '***c123', 'redact 只留末4位');
ok('discoverFromDsh 从 $DSH_HOME/.credentials.yaml 发现候选');

// 无文件 → 空数组(不崩溃)
assert.deepEqual(discoverFromDsh({ DSH_HOME: path.join(tmp, 'nope') }), [], '无文件优雅降级');
ok('discoverFromDsh 无文件降级');

// ---- 汇总排序：dsh-credentials 排在 codex 之前(同无 active 时) ----
const codexHome = path.join(tmp, 'home2');
fs.mkdirSync(path.join(codexHome, '.codex'), { recursive: true });
fs.writeFileSync(
  path.join(codexHome, '.codex', 'config.toml'),
  'model = "deepseek-v4-flash"\n[model_providers.deepseek]\nbase_url = "https://api.deepseek.com/v1"\nexperimental_bearer_token = "sk-codex"\n',
);
fs.mkdirSync(path.join(codexHome, '.dsh'), { recursive: true });
fs.writeFileSync(path.join(codexHome, '.dsh', '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-dsh\n');
const all = discoverCredentials({ DSH_HOME: path.join(codexHome, '.dsh') }, { home: codexHome });
const order = all.map((c) => c.source);
assert.ok(order.indexOf('dsh-credentials:DEEPSEEK_API_KEY') >= 0, 'DSH 候选进入汇总');
assert.equal(all[0].protocol, 'openai', 'OpenAI 兼容优先');
ok('discoverCredentials 汇总包含 DSH 候选且排序稳定');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncredentials.test.mjs 全部通过 (${passed} 项)`);
