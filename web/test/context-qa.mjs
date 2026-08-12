// v0.56 上下文如实分析 QA：完整 mock 对话流后，断言实时大纲 / 思想脉络 / 素材 / 回答分级 /
// 完成度全部如实可读（覆盖"大纲读取 + 已有对话上下文分析"）。
// 用法: node web/test/context-qa.mjs
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sculptor-web-ctx-'));
process.env.SCULPTOR_MOCK_LLM = '1';
process.env.SCULPTOR_LLM_API_KEY = 'mock';
process.env.SCULPTOR_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => { handler = h; return { listen() {} }; };
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res._headers = {};
  res.writeHead = (code, h) => { res.statusCode = code; res._headers = h || {}; };
  res._body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}
function call(urlStr, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method; req.url = urlStr; req.headers = { host: 'localhost' };
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

let mats = ['我在门口站了很久，想象百年前的脚步声', '纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚'];
let args = ['现场感来自具体的人'];
function answer(q) {
  if (/大纲|开始写作/.test(q)) return '可以，就是这样';
  if (/字数|多长/.test(q)) return '大约一千字';
  if (/主题|写什么/.test(q)) return '我想写语言匮乏这件事';
  if (/相信|立场|目的/.test(q)) return '让读者感到语言简化正在切断共同意义';
  if (/读者|给谁/.test(q)) return '老师和同学';
  if (/素材|经历|画面|数据|细节|引文/.test(q))
    return '我记得同学们总爱说各种烂梗。我看过《乡土中国》的文字下乡，语言简化是文化发展的结果，可以顺着这个思路推理';
  if (/论点|支撑|论证/.test(q)) return args.shift() || '细节是过去的证词';
  if (/立意|中心|核心/.test(q)) return '烂梗不是没素质，而是共同意义消失了';
  if (/情绪|情感|曲线/.test(q)) return '先困惑，再刺痛，最后安静';
  if (/结尾|收尾|姿态/.test(q)) return '留白';
  if (/风格|旧稿|写过/.test(q)) return '短句、具体细节、克制抒情';
  if (/还差「/.test(q)) return '跳过';
  return '就按这个方向写吧';
}

const start = JSON.parse((await call('/api/start', 'POST', { topic: '语言匮乏' })).body);
const sid = start.sessionId;
let q = start.question || '';
let guard = 0;
while (guard++ < 40) {
  const r = JSON.parse((await call('/api/step', 'POST', { sessionId: sid, message: answer(q) })).body);
  if (r.kind === 'confirm_outline' || r.kind === 'deliver') break;
  q = r.question || '';
}
const ctx = JSON.parse((await call(`/api/context?sessionId=${sid}`)).body);

check('实时大纲可读（对话中生成）', (ctx.liveOutline?.sections?.length || 0) >= 2, `sections=${ctx.liveOutline?.sections?.length}`);
check('大纲完成度如实结算', ctx.liveOutline?.progress?.percent >= 80 && ctx.outlineComplete === true, `percent=${ctx.liveOutline?.progress?.percent}`);
check('已有对话上下文：素材如实呈现', (ctx.materials?.length || 0) >= 2, `materials=${ctx.materials?.length}`);
check('已有对话上下文：回答分级如实统计', Object.values(ctx.answerStats || {}).some((n) => n > 0), JSON.stringify(ctx.answerStats));
check('已有对话上下文：思想脉络如实提炼（推理链）', String(ctx.thinking || '').includes('《乡土中国》') && String(ctx.thinking || '').includes('推理'), String(ctx.thinking || '').slice(0, 120));
check('大纲标题与节数一致', Boolean(ctx.outline?.title) && (ctx.outline?.sections?.length || 0) >= 2);

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
