// Web 端全功能 QA：真实 HTTP 处理器 + mock LLM，模拟多类真实用户。
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-web-qa-'));
process.env.SCULPTOR_MOCK_LLM = '1';
process.env.SCULPTOR_WEB_DATA = TMP;

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

function zipCheck(buf, expectEntry) {
  const f = path.join(os.tmpdir(), `qa-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(f, buf);
  try {
    const out = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
bad=z.testzip()
names=z.namelist()
print('OK' if bad is None else 'BAD:'+str(bad))
print('HAS' if '${expectEntry}' in names else 'MISS')
`, f], { encoding: 'utf8' }).trim().split('\n');
    return { zipOk: out[0] === 'OK', hasEntry: out[1] === 'HAS', detail: out.join(' ') };
  } catch (e) {
    return { zipOk: false, hasEntry: false, detail: String(e.message).slice(0, 120) };
  } finally {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

const normQ = (s) => String(s || '').replace(/[，。！？、,.！\s]/g, '').toLowerCase();

// ═══ 会话 1：认真用户主流程 ═══
console.log('\n═══ 会话 1 · 认真用户主流程（北大红楼散文）═══');
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇百年历久的北大红楼散文' }));
  let sid = start.sessionId;
  check('start → 第一问', start.kind === 'ask' && !!start.question, start.kind);
  // 大纲深度编辑器：手动保存一份大纲应即时生效（不阻塞对话流程）
  {
    const save = j(await call('/api/outline', 'POST', {
      sessionId: sid,
      outline: {
        title: '测试大纲',
        sections: [
          { heading: '开篇', function: '铺垫', words: 200, keyPoints: ['门'], materials: [] },
          { heading: '收束', function: '收尾', words: 200, keyPoints: ['心安则上'], materials: [] },
        ],
      },
    }));
    const ctx2 = j(await call(`/api/context?sessionId=${sid}`));
    check('大纲深度编辑器即时生效', save.ok === true && ctx2.liveOutline?.sections?.length === 2, `sections=${ctx2.liveOutline?.sections?.length}`);
  }
  // 首轮主题已由 /api/start 预填，问序从"字数"开始；答案数组与之对齐。
  const answers = [
    '大约一千字',
    '让读者感到历史可以走进去，不是隔着玻璃看展品',
    '写给自己和同学，老师会看',
    '我在门口站了很久，想象百年前的脚步声',
    '二楼西侧有一扇窗，窗台积着灰，灰上有细痕',
    '纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚',
    '历史不是展品，而是可以站进去的现场',
    '现场感来自具体的人，而非抽象的时间',
    '每一个细节都是过去的证词',
    '先好奇，再触动，最后安宁',
    '停在心安则上',
    '史铁生在文中将地坛视为宿命的等待，于荒芜与辉煌的落日中体悟个体生命的流逝。他在生死边缘选择平静审视，将死亡视为必然降临的节日，以通透的智慧将苦难化为对美的沉思。',
    // v0.37：字段齐后由 LLM 总结大纲并进入正式大纲确认，不再有缺口补要点阶段。
  ];
  const questions = [];
  let kind = start.kind;
  let confirmMsg = '';
  for (let i = 0; i < answers.length; i++) {
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: answers[i] }));
    kind = r.kind;
    if (kind === 'confirm_outline') confirmMsg = r.message || '';
    if (r.question) {
      questions.push(r.question);
      const qMarks = (r.question.match(/[？?]/g) || []).length;
      check(`第 ${i + 1} 轮一次一问（${qMarks} 个问号）`, qMarks <= 1, r.question.slice(0, 24));
      if (i > 0) {
        const prev = normQ(questions[questions.length - 2]);
        const cur = normQ(r.question);
        const dup = prev === cur || (prev.length >= 8 && prev.includes(cur)) || (cur.length >= 8 && cur.includes(prev));
        check(`第 ${i + 1} 轮不重复上轮问题`, !dup, r.question.slice(0, 24));
      }
    }
    if (['confirm_outline', 'working', 'deliver'].includes(kind)) break; // 澄清结束，进入大纲/写作
  }
  check('问题总数合理（≤22）', questions.length <= 22, `${questions.length} 问`);
  const ctxAfter = j(await call(`/api/context?sessionId=${sid}`));
  check(
    '大纲由 AI 总结成形（liveOutline 有内容）',
    (ctxAfter.liveOutline?.sections?.length || 0) >= 1 && ctxAfter.liveOutline?.complete === true,
    `${ctxAfter.liveOutline?.sections?.length || 0} 部分 · complete=${ctxAfter.liveOutline?.complete}`,
  );
  check(
    '有明确的确认点（正式大纲确认）',
    questions.some((q) => q.includes('确认这份大纲') || q.includes('开始写作')) ||
      confirmMsg.includes('请确认'),
    confirmMsg.slice(0, 30),
  );
  // 空步进推进到交付
  let guard = 0;
  let deliverKind = kind;
  while (deliverKind !== 'deliver' && guard < 50) {
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: '' }));
    deliverKind = r.kind;
    if (deliverKind === 'confirm_outline') {
      const c = j(await call('/api/step', 'POST', { sessionId: sid, message: '可以' }));
      deliverKind = c.kind;
    }
    guard += 1;
  }
  check('自动推进到交付（≤50 步）', deliverKind === 'deliver', `kind=${deliverKind} 步数=${guard}`);
  const ctx = j(await call(`/api/context?sessionId=${sid}`));
  const draft = j(await call(`/api/draft?sessionId=${sid}`));
  const chars = (draft.text || '').replace(/\s/g, '').length;
  check('成稿存在且非空（≥300 字）', chars >= 300, `${chars} 字`);
  check('大纲节数 ≥3', (ctx.outline?.sections?.length || 0) >= 3, `${ctx.outline?.sections?.length} 节`);
  // 对话记录完整性
  const tr = j(await call(`/api/transcript?sessionId=${sid}`));
  const kinds = {};
  for (const e of tr.entries || []) kinds[e.kind || e.role] = (kinds[e.kind || e.role] || 0) + 1;
  check('对话记录完整（user+bot 均落盘）', (tr.entries || []).length >= 20, `${tr.entries?.length} 条 ${JSON.stringify(kinds)}`);
  // 审计报告 + 自动回译校验
  const rep = j(await call(`/api/report?sessionId=${sid}`));
  check('审计指标通过', rep.passed === true, JSON.stringify(rep.metrics));
  check('交付质量门含回译校验', !!rep.roundtrip, JSON.stringify(rep.roundtrip));
  // 风格采集
  const st = j(await call(`/api/style?sessionId=${sid}`));
  const wd = Object.values(st.write?.dimensions || {}).filter((d) => (d.confidence || 0) > 0).length;
  const rd = Object.values(st.read?.structure || {}).filter((d) => (d.confidence || 0) > 0).length;
  check('风格采集到位（write/read 均有维度）', wd >= 1 && rd >= 1, `write ${wd} 维 · read ${rd} 维`);
  check('风格底稿已记录', !!st.styleNote || !!ctx.styleNote, String(st.styleNote || '').slice(0, 40));
  // 导出
  const md = await call(`/api/export?sessionId=${sid}&fmt=md`);
  check('导出 md', md.statusCode === 200 && md._body().toString().includes('北大红楼'));
  const docx = await call(`/api/export?sessionId=${sid}&fmt=docx`);
  const dz = zipCheck(docx._body(), 'word/document.xml');
  check('导出 docx（zip 完整 + document.xml）', docx.statusCode === 200 && dz.zipOk && dz.hasEntry, dz.detail);
  const pptx = await call(`/api/export?sessionId=${sid}&fmt=pptx`);
  const pz = zipCheck(pptx._body(), 'ppt/slides/slide1.xml');
  check('导出 pptx（zip 完整 + slide）', pptx.statusCode === 200 && pz.zipOk && pz.hasEntry, pz.detail);
  // 上传 / RAG / 点改（同一会话收尾）
  const up = j(await call('/api/upload', 'POST', { sessionId: sid, filename: '笔记.txt', dataBase64: Buffer.from('窗台积灰上有细痕，像有人用手指划过。\n').toString('base64') }));
  check('多模态上传', up.ok && up.kind === 'text', up.file);
  const rg = j(await call('/api/rag/ingest', 'POST', { sessionId: sid, text: '教育史学者指出：红色旧址的现场感来自具体的人与物件。' }));
  check('RAG 资料回灌', rg.ok && rg.ingested >= 1, `ingested=${rg.ingested}`);
  const pe = j(await call('/api/point-edit', 'POST', { sessionId: sid, quote: draft.text.match(/[^\n]{6,20}。/)?.[0] || '', instruction: '更口语一点' }));
  check('句子级点改', pe.ok === true && !!pe.replacement, String(pe.error || '').slice(0, 60));
  // 手动回译校验入口
  const rt = j(await call('/api/roundtrip', 'POST', { sessionId: sid }));
  check('回译校验入口', rt.ok && rt.verdict && rt.report.includes('内容保真'), rt.verdict);
  globalThis.__sid1 = sid;
}

// ═══ 会话 2：不耐烦用户（低意愿早退，不许无限追问）═══
console.log('\n═══ 会话 2 · 不耐烦用户（“你决定”×2 应提前进大纲）═══');
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇关于夏天的随笔' }));
  const sid = start.sessionId;
  const answers = [
    '写夏天傍晚的一阵风',
    '六百字就行',
    '让读者觉得凉爽又有点怅然',
    '自己看',
    '操场边的风，吹起旧练习册的纸页',
    '风里有汗味和青草味',
    '那种风一停，人就忽然安静下来',
    '你决定',
    '你决定',
  ];
  let kind = start.kind;
  let questions = 0;
  for (const a of answers) {
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: a }));
    kind = r.kind;
    if (r.question) questions += 1;
  }
  check('低意愿用户不陷入无限追问（≤12 问即收束）', questions <= 12, `${questions} 问后 kind=${kind}`);
  let guard = 0;
  while (kind !== 'deliver' && guard < 50) {
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: '' }));
    kind = r.kind;
    if (kind === 'confirm_outline') {
      const c = j(await call('/api/step', 'POST', { sessionId: sid, message: '可以' }));
      kind = c.kind;
    }
    guard += 1;
  }
  check('不耐烦用户也能完整交付', kind === 'deliver', `kind=${kind}`);
  const st = j(await call(`/api/style?sessionId=${sid}`));
  const wd = Object.values(st.write?.dimensions || {}).filter((d) => (d.confidence || 0) > 0).length;
  check('无风格底稿时对话级风格提炼仍发生', wd >= 1, `write ${wd} 维`);
}

// ═══ 会话 3：真实对话记录可查看（逐条列出核心信息）═══
console.log('\n═══ 会话 3 · 对话记录可查看 ═══');
{
  const sid = globalThis.__sid1;
  const tr = j(await call(`/api/transcript?sessionId=${sid}`));
  const userMsgs = tr.entries.filter((e) => e.role === 'user').length;
  const botAsks = tr.entries.filter((e) => e.kind === 'ask').length;
  const working = tr.entries.filter((e) => e.kind === 'working').length;
  const deliver = tr.entries.filter((e) => e.kind === 'deliver').length;
  check('记录含用户发言/澄清问/过程/交付', userMsgs >= 12 && botAsks >= 9 && working >= 2 && deliver === 1,
    `user=${userMsgs} ask=${botAsks} working=${working} deliver=${deliver}`);
  console.log('  · 最后 3 条记录：');
  for (const e of tr.entries.slice(-3)) {
    console.log(`    [${e.role}/${e.kind || '-'}] ${String(e.text || e.question || '').slice(0, 60)}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✓ QA 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
