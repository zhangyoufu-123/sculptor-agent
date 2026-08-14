// v0.60 作品同步/分割/全流程互操作 QA：导入分片、同步、改名、删除、
// 导入草稿继续处理、按阶段导出（outline/report/style/knowledge）。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-works-'));
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

// 1) 导入长作品 → 自动分片入库，作品库可见
{
  const longText =
    '# 第一章 缘起\n\n' + '这是第一章的内容，用来把每一章撑到超长以便触发分片。'.repeat(420) + '\n\n# 第二章 发展\n\n' + '这是第二章的内容，用来把每一章撑到超长以便触发分片。'.repeat(420) + '\n\n# 第三章 收束\n\n' + '结尾内容，用来把每一章撑到超长以便触发分片。'.repeat(420);
  const r = j(await call('/api/works/import', 'POST', { title: '长文测试', text: longText }));
  check('导入返回分片', r.ok === true && r.parts >= 2, `parts=${r.parts}`);
  const works = j(await call('/api/works')).works;
  const imported = works.filter((w) => w.title.includes('长文测试') || w.title.includes('第一章'));
  check('作品库可见导入分片', imported.length >= 1, `${imported.length} 片`);
  const piece = imported[0];
  const renamed = j(await call('/api/work', 'POST', { sessionId: piece.sessionId, file: piece.file, title: '长文测试·改名版' }));
  check('作品改名', renamed.ok === true && renamed.piece.title === '长文测试·改名版');
  const del = j(await call('/api/work', 'DELETE', { sessionId: piece.sessionId, file: piece.file }));
  check('作品删除', del.ok === true);
  const after = j(await call('/api/works')).works;
  check('删除后不可见', !after.some((w) => w.file === piece.file));
  console.log('PASS 导入/分片/改名/删除');
}

// 2) 导入草稿 → 继续处理（导出/审计）
{
  const start = j(await call('/api/start', 'POST', { topic: '互操作测试' }));
  const sid = start.sessionId;
  const draftText = '# 互操作测试\n\n## 摘要\n\n这是一段用于测试的正文，包含《乡土中国》引文。'.repeat(8);
  const imp = j(await call('/api/import-draft', 'POST', { sessionId: sid, title: '互操作测试稿', text: draftText }));
  check('导入草稿成功', imp.ok === true && imp.chars > 100, `chars=${imp.chars}`);
  const md = await call(`/api/export?sessionId=${sid}&fmt=md`);
  check('导出草稿 md', md.statusCode === 200 && md._body().includes('互操作测试'));
  const norm = j(await call('/api/norm', 'POST', { sessionId: sid }));
  check('导入草稿可审计', typeof norm.score === 'number');
  const rep = await call(`/api/export?sessionId=${sid}&fmt=md&what=report`);
  check('导出审计报告', rep.statusCode === 200 && rep._body().includes('审计') || rep._body().includes('报告'));
  const sty = await call(`/api/export?sessionId=${sid}&fmt=md&what=style`);
  check('导出风格肖像', sty.statusCode === 200);
  const kb = await call(`/api/export?sessionId=${sid}&fmt=md&what=knowledge`);
  check('导出知识库', kb.statusCode === 200);
  console.log('PASS 导入草稿/导出/审计');
}

// 3) 大纲导出（先写大纲再导出 what=outline）
{
  const start = j(await call('/api/start', 'POST', { topic: '大纲导出测试' }));
  const sid = start.sessionId;
  const o = j(await call('/api/outline', 'POST', {
    sessionId: sid,
    outline: { title: '大纲导出测试', sections: [{ heading: '一、问题', keyPoints: ['现状'], thesis: '核心' }, { heading: '二、对策', keyPoints: ['建议'], thesis: '方案' }] },
  }));
  check('大纲可写入', o.ok === true);
  const ex = await call(`/api/export?sessionId=${sid}&fmt=md&what=outline`);
  check('导出大纲 md', ex.statusCode === 200 && ex._body().includes('一、问题') && ex._body().includes('二、对策'), `code=${ex.statusCode}`);
  console.log('PASS 大纲导出');
}

console.log(`\n${failures === 0 ? '✓ works-qa 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
