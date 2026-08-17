// Node 半区文件预览路由单测：直接调用注册的 handler 验证读文件逻辑。
// 运行: node test/node-route.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, FILE_ROUTE } from '../index.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// mock ctx：捕获 webServer.register 的配置
let captured = null;
const mockCtx = {
  inject(services, fn) {
    fn({
      webServer: {
        register(cfg) {
          captured = cfg;
          return () => {};
        },
      },
      effect(fn2) { fn2(); },
    });
  },
  effect() {},
};
apply(mockCtx);

assert.ok(captured, 'apply 应注册路由');
assert.equal(captured.kind, 'prefix');
assert.equal(captured.path, FILE_ROUTE);
assert.equal(typeof captured.handler, 'function');
ok('路由注册（prefix /stylotrace/file）');

// 造文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-route-'));
const mdFile = path.join(tmp, 'demo.md');
fs.writeFileSync(mdFile, '# Demo\n本地优先的 AI 笔记工具。\n');
const binFile = path.join(tmp, 'demo.docx');
fs.writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

// 模拟 req/res
function makeReq(url, headers = {}) {
  return { url, method: 'GET', headers: { host: 'localhost:3080', ...headers } };
}
function makeRes() {
  let status = 0;
  let body = '';
  return {
    writeHead(s) { status = s; },
    end(b) { body = b; },
    get status() { return status; },
    get body() { return body; },
  };
}

const handler = captured.handler;

// 1. 文本文件 → 返回内容
{
  const res = makeRes();
  await handler(makeReq(`/stylotrace/file?path=${encodeURIComponent(mdFile)}`), res);
  const data = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.kind, 'text');
  assert.ok(data.content.includes('本地优先的 AI 笔记工具'));
  assert.equal(data.name, 'demo.md');
  ok('文本文件返回内容');
}

// 2. 二进制文件 → binary 标记
{
  const res = makeRes();
  await handler(makeReq(`/stylotrace/file?path=${encodeURIComponent(binFile)}`), res);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.binary, true);
  assert.ok(data.hint.includes('Word'));
  ok('docx 返回 binary 标记与提示');
}

// 3. 不存在的文件 → 500
{
  const res = makeRes();
  await handler(makeReq(`/stylotrace/file?path=${encodeURIComponent(path.join(tmp, 'nope.md'))}`), res);
  assert.equal(res.status, 500);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  ok('不存在文件返回 500');

}

// 4. 缺 path → 400
{
  const res = makeRes();
  await handler(makeReq('/stylotrace/file'), res);
  assert.equal(res.status, 400);
  ok('缺 path 返回 400');
}

// 5. 非本机 Host → 403
{
  const res = makeRes();
  await handler(makeReq(`/stylotrace/file?path=${encodeURIComponent(mdFile)}`, { host: 'evil.example.com' }), res);
  assert.equal(res.status, 403);
  ok('非本机 Host 被拒(403)');
}

// 6. 大文件 → 413
{
  const big = path.join(tmp, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(400 * 1024));
  const res = makeRes();
  await handler(makeReq(`/stylotrace/file?path=${encodeURIComponent(big)}`), res);
  assert.equal(res.status, 413);
  ok('超限文件返回 413');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nnode-route.test.mjs 全部通过 (${passed} 项)`);
