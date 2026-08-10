// Sculptor Studio API 冒烟测试：不监听端口，直接捕获请求处理器逐路由验证。
// 用法: SCULPTOR_WEB_DATA=$(mktemp -d) node web/test/api-smoke.mjs
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sculptor-web-smoke-'));

process.env.SCULPTOR_MOCK_LLM = '1';
process.env.SCULPTOR_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => {
  handler = h;
  return { listen() {} };
};

await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(c, _enc, cb) {
      chunks.push(Buffer.from(c));
      cb();
    },
  });
  res.statusCode = 200;
  res._headers = {};
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res._headers = headers || {};
  };
  res._body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

function call(urlStr, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = urlStr;
    req.headers = { host: 'localhost' };
    const res = fakeRes();
    const timer = setTimeout(() => reject(new Error(`timeout: ${method} ${urlStr}`)), 30000);
    res.on('finish', () => { clearTimeout(timer); resolve(res); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
    handler(req, res);
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  PASS ${msg}`);
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Sculptor Studio API 冒烟测试（mock LLM，无端口）');

let sid = '';

await step('静态资源', async () => {
  const home = await call('/');
  assert(home.statusCode === 200 && home._body().includes('Sculptor Studio'), '首页可访问');
  const css = await call('/assets/app.css');
  assert(css.statusCode === 200 && css._body().includes('sidebar'), 'CSS 可访问');
  const js = await call('/assets/app.js');
  assert(js.statusCode === 200 && js._body().includes('showView'), 'JS 可访问');
});

await step('新建会话', async () => {
  const r = await call('/api/start', 'POST', { topic: '写一篇百年历久的北大红楼发言稿' });
  assert(r.statusCode === 200, `start 200 (got ${r.statusCode})`);
  const d = JSON.parse(r._body());
  assert(d.sessionId && d.meta, '返回 sessionId 与 meta');
  assert(d.kind === 'ask' && d.question, '进入澄清第一问');
  sid = d.sessionId;
});

await step('会话推进', async () => {
  const r = await call('/api/step', 'POST', { sessionId: sid, message: '大约一千二百字' });
  assert(r.statusCode === 200, `step 200 (got ${r.statusCode})`);
  const d = JSON.parse(r._body());
  assert(d.meta && d.meta.title, 'meta 更新');
});

await step('会话列表/详情/记录', async () => {
  const list = JSON.parse((await call('/api/sessions'))._body());
  assert(list.sessions.some((s) => s.id === sid), '列表包含新会话');
  const detail = JSON.parse((await call(`/api/session?sessionId=${sid}`))._body());
  assert(detail.meta.id === sid && detail.meta.status, '会话详情');
  const tr = JSON.parse((await call(`/api/transcript?sessionId=${sid}`))._body());
  assert(tr.entries.length >= 2, `对话记录已落盘 (${tr.entries.length} 条)`);
});

await step('改名', async () => {
  const r = JSON.parse((await call('/api/session', 'PATCH', { sessionId: sid, title: '红楼测试' }))._body());
  assert(r.ok && r.meta.title === '红楼测试', 'PATCH 改名生效');
});

await step('风格肖像/知识库/作品库接口', async () => {
  const style = JSON.parse((await call(`/api/style?sessionId=${sid}`))._body());
  assert(style.write && style.read && style.vector, 'style 返回 write/read/vector');
  assert(typeof style.persona === 'object' || style.persona === null, 'persona 字段存在');
  const kb = JSON.parse((await call(`/api/knowledge?sessionId=${sid}`))._body());
  assert(Array.isArray(kb.entries), 'knowledge 返回数组');
  const works = JSON.parse((await call('/api/works'))._body());
  assert(Array.isArray(works.works), 'works 返回数组');
});

await step('导出（先落一份草稿）', async () => {
  const draft = '# 百年历久，北大红楼\n\n## 一、站在门口\n\n石阶被磨亮了一百年。\n\n## 二、百年之后\n\n历史从不缺席，只等人走进去。\n';
  const save = await call('/api/save-draft', 'POST', { sessionId: sid, text: draft });
  assert(JSON.parse(save._body()).ok, 'save-draft 成功');
  const md = await call(`/api/export?sessionId=${sid}&fmt=md`);
  assert(md.statusCode === 200 && md._body().includes('北大红楼'), 'md 导出');
  const docx = await call(`/api/export?sessionId=${sid}&fmt=docx`);
  assert(docx.statusCode === 200 && docx._body().startsWith('PK'), 'docx 导出（zip 魔数）');
  const pptx = await call(`/api/export?sessionId=${sid}&fmt=pptx`);
  assert(pptx.statusCode === 200 && pptx._body().startsWith('PK'), 'pptx 导出（zip 魔数）');
  const rep = await call(`/api/report?sessionId=${sid}`);
  assert(rep.statusCode === 200 && JSON.parse(rep._body()).metrics, '审计报告接口');
});

await step('删除会话', async () => {
  const r = JSON.parse((await call('/api/session', 'DELETE', { sessionId: sid }))._body());
  assert(r.ok, 'DELETE 会话成功');
  const gone = await call(`/api/session?sessionId=${sid}`);
  assert(gone.statusCode === 404, '删除后不可再读');
});

console.log(`\n${passed} 组冒烟测试通过`);
fs.rmSync(TMP, { recursive: true, force: true });
