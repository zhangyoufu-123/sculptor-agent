// 最终大检查：风格差异 + 历史问题清单 + 商业化检查。
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-final-'));
process.env.SCULPTOR_MOCK_LLM = '1';
process.env.SCULPTOR_WEB_DATA = path.join(TMP, 'web');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

let handler = null;
http.createServer = (h) => { handler = h; return { listen() {} }; };
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);
const { humanMetrics } = await import(pathToFileURL(path.join(REPO, 'agent', 'src', 'experiment.js')).href);

// 捕获所有 LLM 请求体（用于验证风格注入真的不同）
const captured = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  try { captured.push(String(opts.body || '')); } catch {}
  return origFetch(url, opts);
};

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

const mats = ['我在门口站了很久，想象百年前的脚步声', '二楼有扇窗，窗台积灰', '纪念牌上写着百年征程'];
function makeUser(styleAnswer) {
  const m = [...mats];
  let ex = 0, ae = 0;
  return (q) => {
    if (/打磨|大纲重新呈现/.test(q)) return '不用改了，开始写作';
    if (/大纲|开始写作/.test(q)) return '可以，就是这样';
    if (/字数|多长|篇幅/.test(q)) return '八百字';
    if (/主题|写什么|想写/.test(q)) return '北大红楼';
    if (/相信|立场|目的/.test(q)) return '让读者感到历史可以走进去';
    if (/读者|给谁|听众/.test(q)) return '自己';
    if (/素材|经历|画面|数据|细节|引文/.test(q)) return m.shift() || `第 ${++ex} 个场景：窗台积灰上有一道细痕。`;
    if (/论点|支撑|论证|观点/.test(q)) return `第 ${++ae} 个论点：细节是过去的证词。`;
    if (/立意|中心|核心/.test(q)) return '历史不是展品，而是可以站进去的现场';
    if (/情绪|情感|曲线/.test(q)) return '先好奇，再触动，最后安宁';
    if (/结尾|收尾|姿态/.test(q)) return '停在心安则上';
    if (/风格|旧稿|写过/.test(q)) return styleAnswer;
    return '就按这个方向写吧';
  };
}

async function runStyleSession(styleAnswer) {
  const before = captured.length;
  const user = makeUser(styleAnswer);
  const start = j(await call('/api/start', 'POST', { topic: '写一篇关于北大红楼的散文' }));
  const sid = start.sessionId;
  let kind = start.kind, curQ = String(start.question || ''), guard = 0;
  const questions = [];
  while (kind !== 'deliver' && guard < 40) {
    const msg = kind === 'ask' ? user(curQ) : kind === 'confirm_outline' ? '可以' : '';
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: msg }));
    kind = r.kind;
    if (r.question) { questions.push(r.question); curQ = r.question; }
    guard += 1;
  }
  const draft = j(await call(`/api/draft?sessionId=${sid}`)).text || '';
  const writePrompts = captured.slice(before).filter((b) => b.includes('你是人类风格的写作者'));
  return { kind, draft, writePrompts, questions };
}

console.log('═══ A. 风格差异测试（同题·三套风格）═══');
const styles = {
  克制留白: '整篇更克制一点，短句，爱留白，不把话说满。风格底稿：石阶旧了。风从门里出来。历史不响，它只是等着。我们都不必急着说什么，站一会儿就够了。语言要干净，修饰越少越好，让读者自己往深处走。',
  口语亲切: '整篇更口语一点，像跟朋友聊天，说话带点俏皮，不那么正式。风格底稿：你猜怎么着，那石阶磨得能照人，一百年多少人踩过啊。门是深红的，漆掉了露出灰白，特像我家老木柜。咱就平实地讲，像唠家常一样把历史说近。',
  豪迈大气: '整篇更豪迈大气一点，有气势，句子可以长，意象往大了走。风格底稿：风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，仿佛踏在雷声与号角的交界。历史从纸面站起，成为人。',
};
const styleResults = {};
for (const [name, answer] of Object.entries(styles)) {
  const r = await runStyleSession(answer);
  styleResults[name] = r;
  check(`[${name}] 完整交付`, r.kind === 'deliver', r.kind);
  check(`[${name}] 成稿非空`, r.draft.replace(/\s/g, '').length >= 100, `${r.draft.replace(/\s/g, '').length} 字`);
  check(`[${name}] 全程一次一问`, r.questions.every((q) => (q.match(/[？?]/g) || []).length <= 1), `${r.questions.length} 问`);
}
// 写提示词确实不同（风格注入真的进了提示词）
const wp0 = styleResults['克制留白'].writePrompts[0] || '';
const wp1 = styleResults['口语亲切'].writePrompts[0] || '';
const wp2 = styleResults['豪迈大气'].writePrompts[0] || '';
check('三套风格的写作提示词互不相同', wp0 !== wp1 && wp1 !== wp2 && wp0 !== wp2 && !!wp0, `${wp0.length}/${wp1.length}/${wp2.length} 字符`);
check('克制注入含「克制」标记', wp0.includes('克制') || wp0.includes('留白'));
check('口语注入含「口语」标记', wp1.includes('口语'));
console.log('WP2 tail:', wp2.slice(wp2.indexOf('【写作风格'), wp2.indexOf('【写作风格')+260).replace(/\n/g,' '));
check(
  '豪迈注入生效（方向词或派生维度进入提示词）',
  wp2.includes('豪迈') || wp2.includes('情绪昂扬') || wp2.includes('有气势') || wp2.includes('长句'),
  wp2.includes('情绪昂扬') ? '情绪昂扬' : wp2.includes('有气势') ? '有气势' : wp2.slice(0, 40),
);
// 成稿风格确实不同（指标差异）
const m0 = humanMetrics(styleResults['克制留白'].draft);
const m1 = humanMetrics(styleResults['口语亲切'].draft);
const m2 = humanMetrics(styleResults['豪迈大气'].draft);
const diffs = [['克制/口语', m0, m1], ['克制/豪迈', m0, m2], ['口语/豪迈', m1, m2]];
for (const [label, a, b] of diffs) {
  const differs =
    a.sentenceLengthStddev !== b.sentenceLengthStddev ||
    a.bigramTtr !== b.bigramTtr ||
    a.sentenceStartDedup !== b.sentenceStartDedup ||
    (a.blacklistHits || 0) !== (b.blacklistHits || 0);
  check(`成稿风格有区别（${label}）`, differs, `σ ${a.sentenceLengthStddev}vs${b.sentenceLengthStddev} · TTR ${a.bigramTtr}vs${b.bigramTtr}`);
}

console.log('\n═══ B. 历史问题清单抽查 ═══');
// B1 用户说"好"不应误判低意愿早退
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇散文' }));
  const sid = start.sessionId;
  let kind = start.kind, curQ = String(start.question || '');
  const r1 = j(await call('/api/step', 'POST', { sessionId: sid, message: '好' }));
  check('[B1] "好" 不被误判为低意愿（继续正常提问）', r1.kind === 'ask' && !!r1.question, r1.kind);
  const r2 = j(await call('/api/step', 'POST', { sessionId: sid, message: '好' }));
  check('[B1] 连续两个"好"也不触发低意愿早退', r2.kind === 'ask' && !!r2.question, `kind=${r2.kind}`);
}
// B2 大纲编辑不扰乱确认流程
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇关于夏天的散文' }));
  const sid = start.sessionId;
  await call('/api/step', 'POST', { sessionId: sid, message: '六百字' });
  const save = j(await call('/api/outline', 'POST', { sessionId: sid, outline: { title: '夏', sections: [{ heading: '开头', function: '铺垫', words: 200, keyPoints: ['风'], materials: [] }, { heading: '结尾', function: '收束', words: 200, keyPoints: ['空'], materials: [] }] } }));
  const r = j(await call('/api/step', 'POST', { sessionId: sid, message: '就按这个方向写吧' }));
  check('[B2] 大纲编辑即时生效且不报错', save.ok === true && r.kind === 'ask', `${save.ok} ${r.kind}`);
}
// B3 读者群像在交付链路触发
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇关于爷爷的散文' }));
  const sid = start.sessionId;
  const user = makeUser('没有旧稿，先写吧');
  let kind = start.kind, curQ = String(start.question || ''), guard = 0;
  while (kind !== 'deliver' && guard < 40) {
    const msg = kind === 'ask' ? user(curQ) : kind === 'confirm_outline' ? '可以' : '';
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: msg }));
    kind = r.kind;
    if (r.question) curQ = r.question;
    guard += 1;
  }
  const tr = j(await call(`/api/transcript?sessionId=${sid}`));
  const botText = (tr.entries || []).map((e) => String(e.text || '')).join('\n');
  check('[B3] 交付含读者群像/交锋', kind === 'deliver' && (botText.includes('读者') || botText.includes('交锋')), `kind=${kind}`);
}

console.log('\n═══ C. 商业化检查 ═══');
// C1 安全扫描
{
  const scan = spawnSync('bash', [path.join(REPO, 'scripts', 'scan-secrets.sh')], { encoding: 'utf8', cwd: REPO });
  check('[C1] 密钥扫描无泄漏', scan.status === 0 && !/KEY|SECRET|token/i.test(scan.stdout.replace(/扫描完成|OK|通过|未发现/g, '')), (scan.stdout || '').slice(0, 80));
}
// C2 硬编码 key 抽查
{
  const bad = spawnSync('bash', ['-c', "rg -n -i 'sk-[a-zA-Z0-9]{24,}|api[_-]?key\\s*[=:]\\s*[\"\\x27][^\"\\x27]{24,}' agent/src web/server.mjs web/public scripts install.sh 2>/dev/null | head -5"], { encoding: 'utf8' });
  check('[C2] 无硬编码 API key', bad.status === 1 || !bad.stdout.trim(), bad.stdout.slice(0, 120));
}
// C3 安装 dry-run
{
  const inst = spawnSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--project', path.join(TMP, 'proj')], { encoding: 'utf8' });
  check('[C3] 安装脚本 dry-run 正常', inst.status === 0 && inst.stdout.includes('sculptor'), (inst.stdout || '').slice(0, 60));
}
// C4 版本一致 + README/CHANGELOG 存在
{
  const ag = JSON.parse(fs.readFileSync(path.join(REPO, 'agent', 'package.json'), 'utf8'));
  const we = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'package.json'), 'utf8'));
  check('[C4] agent/web 版本一致', ag.version === we.version, `${ag.version}/${we.version}`);
  check('[C4] README/CHANGELOG/LICENSE 齐备', ['README.md', 'CHANGELOG.md', 'LICENSE'].every((f) => fs.existsSync(path.join(REPO, f))));
}
// C5 风格面板不崩（/api/style 可用）
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇散文' }));
  const st = j(await call(`/api/style?sessionId=${start.sessionId}`));
  check('[C5] 风格/向量/侧写接口完整', !!st.write && !!st.read && !!st.vector, Object.keys(st).join(','));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✓ 最终大检查全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
