// 深度 QA：双端（Web HTTP + CLI agent）+ 全格式导出 + 字数达标 + 前端接线。
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-deep-'));
process.env.STYLOTRACE_MOCK_LLM = '1';
process.env.STYLOTRACE_WEB_DATA = path.join(TMP, 'web');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

// ── Web HTTP 处理器 ────────────────────────────────
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

// 按问题动态作答的模拟用户（最人性化：涵盖口语/否定/低意愿/素材/要点/确认）
const qaMats = ['调研显示70%高中生用过AI写作工具', '作文平均分提升但同质化严重', '教育部相关政策文件', '我校高二备课组教学案例', '同题写作对比数据', '学生真实反馈'];
const qaArgs = ['AI降低写作门槛但挤占个性化空间', '风格向量与个人语料可缓解同质化'];
let extra = 0, argExtra = 0;
function qaAnswer(q) {
  if (/已经记过/.test(q)) return '你决定';
  if (/打磨|大纲重新呈现/.test(q)) return '不用改了，开始写作';
  if (/大纲|开始写作/.test(q)) return '可以，就是这样';
  if (/字数|多长|篇幅/.test(q)) return '两千字左右';
  if (/主题|写什么|想写/.test(q)) return '生成式人工智能对高中生写作的影响';
  if (/相信|立场|目的/.test(q)) return '论证AI辅助写作对个性化表达的利弊';
  if (/读者|给谁|听众/.test(q)) return '高中生、老师、评委';
  if (/素材|经历|画面|数据|细节|引文/.test(q)) return qaMats.shift() || `第 ${++extra} 个场景：机房里的同题写作对比数据。`;
  if (/论点|支撑|论证|观点/.test(q)) return qaArgs.shift() || `第 ${++argExtra} 个支撑论点：细节比结论可信。`;
  if (/立意|中心|核心/.test(q)) return 'AI是助手不是代笔，关键在风格意识';
  if (/情绪|情感|曲线/.test(q)) return '先客观，再给出立场';
  if (/结尾|收尾|姿态/.test(q)) return '平衡引导';
  if (/风格|旧稿|写过/.test(q)) return '没有旧稿，按学术规范写';
  if (/还差「/.test(q)) return '跳过';
  if (/主送|对象|当事人/.test(q)) return '全体师生';
  if (/依据|缘由/.test(q)) return '依据上级要求';
  if (/事项|要点|条款/.test(q)) return '防溺水、防诈骗、值班安排';
  return '就按这个方向写吧';
}

function zipCheck(buf, expectEntry) {
  const f = path.join(TMP, `z-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(f, buf);
  try {
    const out = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
bad=z.testzip()
names=z.namelist()
print('OK' if bad is None else 'BAD')
print('HAS' if '${expectEntry}' in names else 'MISS')
`, f], { encoding: 'utf8' }).trim().split('\n');
    return out[0] === 'OK' && out[1] === 'HAS';
  } catch {
    return false;
  } finally {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

console.log('═══ A. Web 端：论文全流程 + 字数达标 + 全格式导出 ═══');
let sid = '';
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇关于生成式人工智能对高中生写作影响的学术论文' }));
  sid = start.sessionId;
  let kind = start.kind;
  let curQ = String(start.question || '');
  let guard = 0;
  while (kind !== 'deliver' && guard < 40) {
    const msg = kind === 'ask' ? qaAnswer(curQ) : kind === 'confirm_outline' ? '可以' : '';
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: msg }));
    kind = r.kind;
    if (r.question) curQ = r.question;
    guard += 1;
  }
  check('Web 论文完整交付', kind === 'deliver', `步数=${guard}`);
  const ctx = j(await call(`/api/context?sessionId=${sid}`));
  const draft = j(await call(`/api/draft?sessionId=${sid}`));
  const chars = (draft.text || '').replace(/\s/g, '').length;
  const target = ctx.targetWords || 0;
  check('Web 字数达标（≥85% 目标）', target > 0 && chars >= target * 0.85, `${chars}/${target} 字`);
  check('文体识别=学术论文', ctx.confirmed?.genre === '学术论文', ctx.confirmed?.genre);

  const md = await call(`/api/export?sessionId=${sid}&fmt=md`);
  check('Web 导出 md', md.statusCode === 200 && md._body().toString().includes('##'), md.statusCode);
  const docx = await call(`/api/export?sessionId=${sid}&fmt=docx`);
  check('Web 导出 docx（zip + document.xml）', docx.statusCode === 200 && zipCheck(docx._body(), 'word/document.xml'), docx.statusCode);
  const pptx = await call(`/api/export?sessionId=${sid}&fmt=pptx`);
  check('Web 导出 pptx（zip + slide）', pptx.statusCode === 200 && zipCheck(pptx._body(), 'ppt/slides/slide1.xml'), pptx.statusCode);
  const badFmt = await call(`/api/export?sessionId=${sid}&fmt=pdf`);
  check('Web 未知格式优雅报错（不 500）', badFmt.statusCode === 400, badFmt.statusCode);
}

console.log('\n═══ B. 前端接线静态检查（页面/面板/按钮） ═══');
{
  const app = fs.readFileSync(path.join(REPO, 'web', 'public', 'assets', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(REPO, 'web', 'public', 'index.html'), 'utf8');
  // 视图/阶段映射一致性
  const views = [...app.matchAll(/VIEWS = \[([^\]]+)\]/g)][0]?.[1] || '';
  const stages = [...app.matchAll(/STAGES = \[([^\]]+)\]/g)][0]?.[1] || '';
  for (const v of ['home', 'sessions', 'session', 'outline', 'draft', 'report', 'persona', 'knowledge', 'works']) {
    check(`视图已注册: ${v}`, views.includes(`'${v}'`));
  }
  for (const s of ['home', 'clarify', 'outline', 'write', 'audit', 'deliver']) {
    check(`阶段已注册: ${s}`, stages.includes(`'${s}'`));
  }
  // 面板页签
  check('面板页签接线（大纲/写作/上下文）', /panelTabs/.test(app) && ['pane-outline', 'pane-draft', 'pane-context'].every((p) => html.includes(p) || app.includes(p)));
  // 关键按钮 id 都在 HTML 或动态创建中存在
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...app.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !htmlIds.has(id) && !jsIds.has(id));
  check('所有 $() 引用都有对应 id（HTML 或动态创建）', missing.length === 0, `缺: ${missing.slice(0, 8).join(',')}`);
  // 阶段条 → 视图映射
  const stageMapOk = /const map = \{ clarify: 'session', outline: 'outline', write: 'session', audit: 'report', deliver: 'draft' \}/.test(app);
  check('阶段条 → 视图映射存在', stageMapOk);
}

console.log('\n═══ C. CLI（agent 端）：论文全流程 + 导出全格式 ═══');
{
  // 用与 Web 相同的 mock fetch（server.mjs 已注入）
  const { runCli } = await import(pathToFileURL(path.join(REPO, 'agent', 'src', 'cli.js')).href);
  const wsDir = path.join(TMP, 'cli-ws');
  process.env.STYLOTRACE_WORKSPACE = wsDir;
  const run = async (args, { input = '' } = {}) => {
    process.exitCode = 0;
    const logs = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(a.join(' '));
    try { await runCli(args, { input }); } catch (e) { logs.push('[thrown] ' + e.message); process.exitCode = 1; }
    finally { console.log = origLog; console.error = origErr; }
    return { code: process.exitCode, out: logs.join('\n') };
  };
  let r = await run(['init']);
  check('CLI init', r.code === 0);
  r = await run(['agent', '--once'], { input: '\n' });
  let ar = JSON.parse(r.out);
  let aq = ar.question || '';
  let guard = 0;
  while (ar.kind !== 'deliver' && guard < 40) {
    const msg = ar.kind === 'ask' ? qaAnswer(aq) : ar.kind === 'confirm_outline' ? '可以' : '';
    r = await run(['agent', '--once'], { input: msg + '\n' });
    ar = JSON.parse(r.out);
    if (ar.question) aq = ar.question;
    guard += 1;
  }
  check('CLI 论文完整交付', ar.kind === 'deliver', `步数=${guard} kind=${ar.kind}`);
  const draftText = fs.readFileSync(path.join(wsDir, 'draft.md'), 'utf8');
  const chars = draftText.replace(/\s/g, '').length;
  const st = JSON.parse(fs.readFileSync(path.join(wsDir, 'protocol', 'state.json'), 'utf8'));
  const target = st.targetWords || 0;
  check('CLI 字数达标（≥85% 目标）', target > 0 && chars >= target * 0.85, `${chars}/${target} 字`);
  r = await run(['export', '--docx', path.join(wsDir, 'out.docx')]);
  check('CLI 导出 docx', r.code === 0 && fs.existsSync(path.join(wsDir, 'out.docx')) && zipCheck(fs.readFileSync(path.join(wsDir, 'out.docx')), 'word/document.xml'), r.out.slice(0, 60));
  r = await run(['export', '--html', path.join(wsDir, 'out.html')]);
  const htmlOut = path.join(wsDir, 'out.html');
  check('CLI 导出 html', r.code === 0 && fs.existsSync(htmlOut) && fs.readFileSync(htmlOut, 'utf8').includes('<html'), r.out.slice(0, 60));
  r = await run(['export', '--srt', path.join(wsDir, 'out.srt')]);
  const srtOut = path.join(wsDir, 'out.srt');
  check('CLI 导出 srt（时间轴格式）', r.code === 0 && fs.existsSync(srtOut) && /-->\s*\d{2}:\d{2}/.test(fs.readFileSync(srtOut, 'utf8')), r.out.slice(0, 60));
  r = await run(['export', '--pdf', path.join(wsDir, 'out.pdf')]);
  const pdfOk = r.code === 0 && fs.existsSync(path.join(wsDir, 'out.pdf')) && fs.readFileSync(path.join(wsDir, 'out.pdf')).slice(0, 4).toString() === '%PDF';
  const pdfGrace = r.code !== 0 && r.out.includes('reportlab');
  check('CLI 导出 pdf（可用则 %PDF，缺依赖则优雅报错）', pdfOk || pdfGrace, r.out.slice(0, 70));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✓ 深度 QA 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
