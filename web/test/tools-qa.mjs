// v0.56 Web 工具与鉴权 QA：学术规范审计 / 文档翻译 / 文档重写 / 登录保护（handler 捕获，离线 mock）。
// 用法: node web/test/tools-qa.mjs
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'stylotrace-web-tools-'));

process.env.STYLOTRACE_MOCK_LLM = '1';
process.env.STYLOTRACE_LLM_API_KEY = 'mock';
process.env.STYLOTRACE_WEB_PASSWORD = 'secret123';
process.env.STYLOTRACE_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => {
  handler = h;
  return { listen() {} };
};
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

let AUTH_TOKEN = '';

function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(c, _enc, cb) { chunks.push(Buffer.from(c)); cb(); },
  });
  res.statusCode = 200;
  res._headers = {};
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.writeHead = (code, headers) => { res.statusCode = code; res._headers = headers || {}; };
  res._body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

function call(urlStr, method = 'GET', payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = urlStr;
    req.headers = { host: 'localhost', ...(AUTH_TOKEN ? { 'x-auth-token': AUTH_TOKEN } : {}), ...headers };
    const res = fakeRes();
    const t = setTimeout(() => reject(new Error('handler timeout')), 20000);
    res.on('finish', () => { clearTimeout(t); resolve({ res, body: res._body() }); });
    handler(req, res).catch((e) => { clearTimeout(t); reject(e); });
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
}

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// 1) 鉴权（v1.0）：设置 STYLOTRACE_WEB_PASSWORD 时需登录
{
  const st = JSON.parse((await call('/api/auth/status')).body);
  check('auth/status 需要登录', st.required === true && st.ok === false);
  const denied = await call('/api/sessions');
  check('未登录访问 API 返回 401', denied.res.statusCode === 401);
  const bad = await call('/api/auth/login', 'POST', { password: 'wrong' });
  check('错误密码返回 401', bad.res.statusCode === 401);
  const login = await call('/api/auth/login', 'POST', { password: 'secret123' });
  check('正确密码登录成功', login.res.statusCode === 200 && JSON.parse(login.body).ok === true);
  AUTH_TOKEN = JSON.parse(login.body).token;
  const ok = await call('/api/sessions');
  check('带 token 访问 API 正常', ok.res.statusCode === 200);
  console.log('PASS 密码门鉴权');
}

// 2) 学术规范审计：构造带问题的会话成稿
{
  const sid = 'n1';
  const dir = path.join(TMP, 'machines', 'default', 'sessions', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: sid, title: '规范审计样例' }));
  fs.mkdirSync(path.join(dir, 'protocol'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol', 'state.json'), JSON.stringify({ confirmed: { genre: '学术论文' } }));
  fs.writeFileSync(path.join(dir, 'draft.md'), '## 摘要\n' + '这是一段用于测试摘要长度的文字。'.repeat(40) + '\n\n个人知识库(Personal Knowledge Base, PKB)。\n', 'utf8');
  const r = JSON.parse((await call('/api/norm', 'POST', { sessionId: sid })).body);
  check('norm 返回评分与问题', typeof r.score === 'number' && Array.isArray(r.items) && r.items.length >= 2, `items=${r.items.length}`);
  console.log('PASS 学术规范审计（web 端点）');
}

// 3) 文档翻译（md 输入）与下载
{
  const r = JSON.parse(
    (await call('/api/doc/translate', 'POST', { sessionId: 'n1', filename: 'doc.md', dataBase64: b64('# Title\n\n你好，世界。'), lang: 'en' })).body,
  );
  check('doc translate 成功并产出文件', r.ok === true && Array.isArray(r.files) && r.files.some((f) => f.endsWith('.md')), JSON.stringify(r.files));
  check('doc translate 含原意解读', r.interpretation && r.interpretation.intent);
  const mdFile = r.files.find((f) => f.endsWith('.md'));
  const dl = await call(`/api/doc/download?sessionId=n1&file=${encodeURIComponent(mdFile)}`, 'GET');
  check('doc download 可下载译文', dl.res.statusCode === 200 && dl.body.includes('This is a translated paragraph'));
  console.log('PASS 文档翻译与下载（web 端点）');
}

// 4) 文档风格重写与回译/产物
{
  const r = JSON.parse(
    (await call('/api/doc/restyle', 'POST', { sessionId: 'n1', filename: 'doc.md', dataBase64: b64('# T\n\n旧石阶。'), style: '克制短句' })).body,
  );
  check('doc restyle 成功并产出文件', r.ok === true && Array.isArray(r.files) && r.files.some((f) => f.endsWith('.md')));
  console.log('PASS 文档风格重写（web 端点）');
}

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
