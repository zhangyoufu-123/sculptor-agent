// Stylotrace Studio API 冒烟测试：不监听端口，直接捕获请求处理器逐路由验证。
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

console.log('Stylotrace Studio API 冒烟测试（mock LLM，无端口）');

let sid = '';

await step('静态资源', async () => {
  const home = await call('/');
  assert(home.statusCode === 200 && home._body().includes('Stylotrace Studio'), '首页可访问');
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

await step('上下文面板与概览接口', async () => {
  const ctx = JSON.parse((await call(`/api/context?sessionId=${sid}`))._body());
  assert(Array.isArray(ctx.checklist) && ctx.checklist.length > 0, 'context 返回确认清单');
  assert(typeof ctx.thinking === 'string', 'context 返回思想脉络字段');
  assert(Array.isArray(ctx.pulses), 'context 返回风格脉搏列表');
  assert(typeof ctx.answerStats === 'object' && 'L0' in ctx.answerStats, 'context 回答层次统计');
  assert(typeof ctx.materials === 'object', 'context 素材字段');
  assert(typeof ctx.progress === 'object' && 'done' in ctx.progress, 'context 写作进度字段');
  assert(ctx.outline === null || Array.isArray(ctx.outline.sections), 'context 大纲完整节列表');
  assert(ctx.liveOutline === null || Array.isArray(ctx.liveOutline.sections), 'context 实时大纲字段');
  const save = await call('/api/outline', 'POST', {
    sessionId: sid,
    outline: {
      title: '实时大纲测试',
      parts: [
        { title: '卷一·起', sections: ['开头'] },
        { title: '卷二·承', sections: ['主体'] },
      ],
      sections: [
        { heading: '开头', function: '铺垫', words: 200, keyPoints: ['门'], materials: [] },
        { heading: '主体', function: '展开', words: 500, keyPoints: ['窗', '灰'], materials: [] },
      ],
    },
  });
  assert(JSON.parse(save._body()).ok, 'POST /api/outline 保存实时大纲');
  const ctx2 = JSON.parse((await call(`/api/context?sessionId=${sid}`))._body());
  assert(ctx2.liveOutline?.sections?.length === 2, '保存后 liveOutline 已更新');
  assert(ctx2.liveOutline?.parts?.length === 2, '卷级分组随大纲保存');
  assert(
    ctx2.liveOutline.parts[0].sections.join() === '开头' &&
      ctx2.liveOutline.parts[1].sections.join() === '主体',
    '卷分组引用有效节',
  );
  const ov = JSON.parse((await call('/api/overview'))._body());
  assert(typeof ov.sessions === 'number' && ov.sessions >= 1, 'overview 会话统计');
  assert(typeof ov.byCat === 'object', 'overview 分类统计');
});

await step('文件上传（多模态摄入）', async () => {
  const b64 = Buffer.from(
    '这是一段从文档里提取的素材：窗台积灰与百年前的脚步声。\n',
  ).toString('base64');
  const up = await call('/api/upload', 'POST', {
    sessionId: sid,
    filename: '素材.txt',
    dataBase64: b64,
  });
  const d = JSON.parse(up._body());
  assert(up.statusCode === 200 && d.ok && d.kind === 'text', '上传并提取为文本素材');
  const ctx = JSON.parse((await call(`/api/context?sessionId=${sid}`))._body());
  assert(
    ctx.materials.some((m) => String(m).includes('素材.txt')),
    '上传文件进入会话素材',
  );
});

await step('RAG 待检索查询与资料回灌', async () => {
  const needs = JSON.parse((await call(`/api/rag/needs?sessionId=${sid}`))._body());
  assert(Array.isArray(needs.pending), 'rag/needs 返回数组');
  const ing = await call('/api/rag/ingest', 'POST', {
    sessionId: sid,
    text: '某研究指出：数字教育转型的实证数据（来源：教育学报 2025）。',
  });
  const d = JSON.parse(ing._body());
  assert(d.ok && d.ingested >= 1, '粘贴资料回灌成功');
  const ctx = JSON.parse((await call(`/api/context?sessionId=${sid}`))._body());
  assert(typeof ctx.rag?.pendingRequests === 'number', 'context 携带 RAG 状态');
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
  const cmp = await call(
    `/api/works/compare?sessionId=${sid}&file=draft.md&sessionId2=${sid}&file2=draft.md`,
  );
  assert(
    cmp.statusCode === 200 && typeof JSON.parse(cmp._body()).a?.chars === 'number',
    '作品对比接口返回指标',
  );
});

await step('节奏曲线与伏笔回收端点（v0.41）', async () => {
  const cv = JSON.parse((await call(`/api/curve?sessionId=${sid}`))._body());
  assert(Array.isArray(cv.sections) && cv.sections.length === 2, 'curve 返回按节曲线');
  assert(
    cv.sections.every(
      (s) =>
        s.tension >= 0 && s.tension <= 100 &&
        s.emotion >= 0 && s.emotion <= 100 &&
        s.density >= 0 && s.density <= 100 &&
        s.pacing >= 0 && s.pacing <= 100,
    ),
    '曲线四维分值在 0-100',
  );
  const cc = JSON.parse((await call(`/api/consistency?sessionId=${sid}`))._body());
  assert(typeof cc.score === 'number' && Array.isArray(cc.recovered), 'consistency 返回报告');
  assert(cc.total === 0 || cc.note.includes('伏笔'), '无伏笔时给出说明');
});

await step('句子级点改', async () => {
  const pe = await call('/api/point-edit', 'POST', {
    sessionId: sid,
    quote: '石阶被磨亮了一百年。',
    instruction: '更口语一点',
  });
  const d = JSON.parse(pe._body());
  assert(pe.statusCode === 200 && d.ok && d.replacement, `point-edit 返回改写结果 (${pe.statusCode})`);
  const draft = JSON.parse((await call(`/api/draft?sessionId=${sid}`))._body());
  assert(draft.text.includes('那扇窗没有开口'), '文件已被改写（mock 修订生效）');
  const ctx = JSON.parse((await call(`/api/context?sessionId=${sid}`))._body());
  assert(typeof ctx.styleProgress === 'object', '点改后上下文面板仍正常');
});

await step('候选改写 / 版本历史 / 回滚（v0.46）', async () => {
  const rw = await call('/api/rewrite', 'POST', {
    sessionId: sid,
    quote: '那扇窗没有开口，却什么都知道。',
    instruction: '更口语一点',
  });
  const d = JSON.parse(rw._body());
  assert(rw.statusCode === 200 && d.ok && d.candidates?.length === 3, '候选改写返回 3 个候选');
  const pe = await call('/api/point-edit', 'POST', {
    sessionId: sid,
    quote: d.quote,
    instruction: '更口语一点',
    replacement: d.candidates[1],
  });
  assert(JSON.parse(pe._body()).ok, '应用候选成功');
  const draft2 = JSON.parse((await call(`/api/draft?sessionId=${sid}`))._body());
  assert(draft2.text.includes(d.candidates[1]), '候选已写回草稿');
  const hist = JSON.parse((await call(`/api/history?sessionId=${sid}`))._body());
  assert(Array.isArray(hist.entries) && hist.entries.length >= 1, '版本历史存在');
  const rb = await call('/api/rollback', 'POST', { sessionId: sid, index: 1 });
  assert(JSON.parse(rb._body()).ok, '回滚最新版本成功');
  const draft3 = JSON.parse((await call(`/api/draft?sessionId=${sid}`))._body());
  assert(draft3.text.includes('那扇窗'), '回滚后成稿恢复');
});

await step('回译校验（内容保真）', async () => {
  const r = await call('/api/roundtrip', 'POST', { sessionId: sid });
  const d = JSON.parse(r._body());
  assert(r.statusCode === 200 && d.ok, `roundtrip 200 (got ${r.statusCode})`);
  assert(d.verdict === 'pass' && d.report.includes('内容保真'), '回译校验返回报告与判定');
  assert(typeof d.content?.lost?.length === 'number', '信息点核对字段完整');
  assert(typeof d.style?.original?.sentenceLengthStddev === 'number', '风格对比指标齐全');
});

await step('删除会话', async () => {
  const r = JSON.parse((await call('/api/session', 'DELETE', { sessionId: sid }))._body());
  assert(r.ok, 'DELETE 会话成功');
  const gone = await call(`/api/session?sessionId=${sid}`);
  assert(gone.statusCode === 404, '删除后不可再读');
});

console.log(`\n${passed} 组冒烟测试通过`);
fs.rmSync(TMP, { recursive: true, force: true });
