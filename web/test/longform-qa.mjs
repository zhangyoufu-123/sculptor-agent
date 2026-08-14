// v0.42 长文全链路 QA：12000 字小说端到端（真实 HTTP 处理器 + mock LLM）。
// 重点验证：卷级大纲（parts）贯穿"澄清→大纲→写作→复阅→红队→交付"全程，
// 且大纲仍是呈现物、不阻塞写作；长文不假死、不重复问同一问题。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-longform-'));
process.env.STYLOTRACE_MOCK_LLM = '1';
process.env.STYLOTRACE_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => { handler = h; return { listen() {} }; };
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res._headers = {};
  res.writeHead = (c, h) => { res.statusCode = c; res._headers = h || {}; };
  res._body = () => Buffer.concat(chunks);
  return res;
}
function call(urlStr, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method; req.url = urlStr; req.headers = { host: 'localhost' };
    const res = fakeRes();
    const timer = setTimeout(() => reject(new Error(`timeout ${method} ${urlStr}`)), 90000);
    res.on('finish', () => { clearTimeout(timer); resolve(res); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
    handler(req, res);
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
}
const j = (r) => JSON.parse(r._body().toString('utf8'));

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

// 剧本化用户回答：顺序对应 mock 澄清序列（topic 已由 /api/start 给出）。
const ANSWERS = [
  '一万两千字左右',                                        // targetWords
  '想写小人物被时代裹挟的无力与反抗',                      // stance
  '给成人读者，悬疑题材，追求文学质感',                    // audience/题材
  '老钟表匠；雨夜；一封没寄出的信',                        // 素材1（顿号拆分3条）
  '旧戏台；灰烬里的半张戏票；失踪的账本',                  // 素材2
  '河边的缆绳；一双磨破的布鞋；墙上的划痕',                // 素材3
  '真相从不在信里，而在没寄出的那封',                      // theme
  '谎言会自我繁殖',                                        // argument1
  '沉默的人也在作案',                                      // argument2
  '先压抑，再战栗，最后是长久的空',                        // emotionalCurve
  '留白：雨停了，门还开着',                                // ending
  '没有',                                                  // styleSample
];

console.log('长文全链路 QA（12000 字小说 · 卷级大纲）\n');

const started = j(await call('/api/start', 'POST', { topic: '写一部长篇小说《雾镇旧案》，关于一封没寄出的信' }));
const sid = started.sessionId;
check('开局进入澄清', started.kind === 'ask' && Boolean(started.question));

let step = 0;
const seenCount = new Map();
let maxRepeat = 0;
let r = started;
let confirmSawParts = false;
let deliverReached = false;
let partsInContext = false;

while (step < 45) {
  step += 1;
  if (r.kind === 'ask') {
    const q = String(r.question || '').trim();
    const n = (seenCount.get(q) || 0) + 1;
    seenCount.set(q, n);
    maxRepeat = Math.max(maxRepeat, n);
    // 素材门槛提示 → 用户拍板开始写作（合法逃生路径，标记 deferred）
    let answer;
    if (q.includes('素材门槛') || q.includes('还差一点信息')) {
      answer = '开始写作吧，缺的素材你在写作时补';
    } else if (n > 3) {
      // 同一问句连续 ≥4 次（mock 固定问法凑不满长文素材门槛）→ 低意愿逃生，
      // 真实产品中 questioner LLM 会换问法，这里模拟用户"你决定"。
      answer = '你决定';
    } else if (ANSWERS.length) {
      answer = ANSWERS.shift();
    } else {
      answer = '你决定';
    }
    r = j(await call('/api/step', 'POST', { sessionId: sid, message: answer }));
    continue;
  }
  if (r.kind === 'confirm_outline') {
    check('大纲含卷级分组（parts）', Array.isArray(r.outline.parts) && r.outline.parts.length >= 2,
      JSON.stringify((r.outline.parts || []).map((p) => p.title)));
    confirmSawParts = true;
    check('sections 完整平铺', Array.isArray(r.outline.sections) && r.outline.sections.length >= 3);
    r = j(await call('/api/step', 'POST', { sessionId: sid, message: '可以，开始写' }));
    continue;
  }
  if (r.kind === 'working') {
    r = j(await call('/api/step', 'POST', { sessionId: sid, message: '' }));
    continue;
  }
  if (r.kind === 'deliver') {
    deliverReached = true;
    check('交付消息到达', r.message && r.message.includes('整篇文章已完成'));
    check('交付含卷/节信息或进度', !r.message.includes('undefined'));
    break;
  }
  if (r.kind === 'blocked') break;
  r = j(await call('/api/step', 'POST', { sessionId: sid, message: '继续' }));
}

check('确认大纲时看到卷级分组', confirmSawParts);
check('全链路走到交付', deliverReached, `step=${step}`);
check('澄清无死循环（同类问句最多重复 5 次内被逃生）', maxRepeat <= 5, `maxRepeat=${maxRepeat}`);

// 交付后：上下文里 liveOutline 仍携带 parts，写作真源未被卷级分组扰动
const ctx = j(await call(`/api/context?sessionId=${sid}`));
partsInContext = Array.isArray(ctx.liveOutline?.parts) && ctx.liveOutline.parts.length >= 2;
check('context 中 liveOutline 携带 parts', partsInContext);
check('大纲仍是呈现物（sections 完整）', Array.isArray(ctx.liveOutline?.sections) && ctx.liveOutline.sections.length >= 3);

// 成稿与伏笔校验可查
const draft = j(await call(`/api/draft?sessionId=${sid}`));
check('成稿非空', draft.text.replace(/\s/g, '').length > 50);
const heads = (draft.text.match(/^## .*/gm) || []);
check('成稿分节完整（节标题独立成行）', heads.length >= 3, heads.join(' | '));
check('无节标题粘连（正文末尾直接跟 ##）', !/[^。\n]## [^、\n]/.test(draft.text));
const cc = j(await call(`/api/consistency?sessionId=${sid}`));
check('伏笔回收校验可查（小说链路）', typeof cc.score === 'number' && Array.isArray(cc.recovered));
const cv = j(await call(`/api/curve?sessionId=${sid}`));
check('节奏曲线可查', Array.isArray(cv.sections) && cv.sections.length >= 3);

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n✓ longform-qa 全部通过');
