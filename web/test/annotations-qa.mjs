// v0.61 批注 QA：选段批注保存/读取/删除/一键 AI 按批注修改（mock LLM）。
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-ann-'));
process.env.STYLOTRACE_MOCK_LLM = '1';
process.env.STYLOTRACE_LLM_API_KEY = 'mock';
process.env.STYLOTRACE_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => { handler = h; return { listen() {} }; };
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res._headers = {};
  res.writeHead = (c, h) => { res.statusCode = c; res._headers = h || {}; };
  res._body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}
function call(urlStr, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method; req.url = urlStr; req.headers = { host: 'localhost' };
    const res = fakeRes();
    const timer = setTimeout(() => reject(new Error(`timeout ${method} ${urlStr}`)), 60000);
    res.on('finish', () => { clearTimeout(timer); resolve(res); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
    handler(req, res);
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
}
const j = (r) => JSON.parse(r._body());
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

const start = j(await call('/api/start', 'POST', { topic: '批注测试' }));
const sid = start.sessionId;
const draftText = [
  '# 批注测试文档',
  '',
  '## 第一节',
  '这是第一段的唯一句子，风把落叶卷成一团。',
  '',
  '## 第二节',
  '这是第二段的唯一句子，路灯刚刚亮起。',
  '',
].join('\n');
const imp = j(await call('/api/import-draft', 'POST', { sessionId: sid, title: '批注测试', text: draftText }));
check('准备草稿', imp.ok === true);

// 1) 保存批注 + 读取
{
  const a1 = j(await call('/api/annotations', 'POST', { sessionId: sid, quote: '这是第一段的唯一句子', comment: '这句改成短句' }));
  const a2 = j(await call('/api/annotations', 'POST', { sessionId: sid, quote: '这是第二段的唯一句子', comment: '结尾再克制一点' }));
  check('保存批注', a1.ok === true && a2.ok === true);
  const list = j(await call(`/api/annotations?sessionId=${sid}`)).annotations;
  check('读取批注（2 条）', list.length === 2, `${list.length}`);
  const filtered = j(await call(`/api/annotations?sessionId=${sid}&file=draft.md`)).annotations;
  check('按文件过滤', filtered.length === 2);
  console.log('PASS 批注保存与读取');
}

// 2) 一键 AI 按批注修改（mock LLM 直接替换，定位唯一句成功即 applied）
{
  const r = j(await call('/api/annotations/apply', 'POST', { sessionId: sid }));
  check('AI 按批注修改返回结构', Array.isArray(r.applied) && Array.isArray(r.failed) && r.total === 2, `applied=${r.applied.length} failed=${r.failed.length}`);
  const list = j(await call(`/api/annotations?sessionId=${sid}`)).annotations;
  check('已应用批注标记 done', list.every((a) => a.status === 'done'));
  const draft = j(await call(`/api/draft?sessionId=${sid}`)).text;
  check('草稿确实被修改（不再含原句）', !draft.includes('这是第一段的唯一句子'));
  console.log('PASS AI 按批注修改');
}

// 3) 删除
{
  const list = j(await call(`/api/annotations?sessionId=${sid}`)).annotations;
  const del = j(await call('/api/annotations', 'DELETE', { sessionId: sid, id: list[0].id }));
  check('删除批注', del.ok === true);
  const after = j(await call(`/api/annotations?sessionId=${sid}`)).annotations;
  check('删除后剩 1 条', after.length === 1, `${after.length}`);
  console.log('PASS 批注删除');
}

console.log(`\n${failures === 0 ? '✓ annotations-qa 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
