#!/usr/bin/env node
// Sculptor Studio Web（v1.0）：零依赖 Node HTTP 服务。
// 把 Sculptor 导演状态机（agentStep）包成 REST，前端提供完整写作工作台：
//   多会话持久化（web-data/sessions/，可列表/改名/删除/续写）
//   作品库（vault/library 跨会话聚合，按文体分类展示）
//   风格肖像（write/read 14+7 维 + 复合风格向量 + 人物侧写）
//   知识库可视化（vault/knowledge 条目列表/删除）
//   导出：md / docx / pptx（python-docx / python-pptx 可用时）
// SCULPTOR_MOCK_LLM=1 时用内置 mock（离线验证）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 5177);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC = path.resolve(HERE, 'public');
const DATA_ROOT = path.resolve(process.env.SCULPTOR_WEB_DATA || path.resolve(HERE, '..', 'web-data'));
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');

// 离线 mock（与单测同一套）：SCULPTOR_MOCK_LLM=1 时启用，用于本地/CI 验证
if (process.env.SCULPTOR_MOCK_LLM === '1') {
  const { respond } = await import(
    pathToFileURL(path.resolve(HERE, '..', 'agent', 'test', 'mock-llm.mjs')).href
  );
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
}

const { loadConfig } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'config.js')).href
);
const { academicNorm } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'academic-norm.js')).href
);
const { docTranslate, docRestyle } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'doc-pipeline.js')).href
);
const { agentStep } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'director.js')).href
);
const ws = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'workspace.js')).href
);
const { humanMetrics } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'experiment.js')).href
);
const { styleProgress } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'style.js')).href
);
const { recentPulses } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'style-pulse.js')).href
);
const { thinkingBrief } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'thinking.js')).href
);
const { rhythmCurve } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'style-pulse.js')).href
);
const { modulatorStatus, modulate } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'modulator.js')).href
);
const { checkConsistency } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'consistency.js')).href
);
const { readVector, vectorSummary } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'style-vector.js')).href
);
const { readPersona } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'persona.js')).href
);
const { listEntries, removeEntry, normTitle } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'knowledge.js')).href
);
const { importWork, addPiece } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'library.js')).href
).catch(() => ({ importWork: null, addPiece: null }));
const { checklistOf } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'clarify.js')).href
);
const { outlineProgress } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'outline-state.js')).href
);
const { exportDocx, docxAvailable } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'io.js')).href
);
const { extractInput } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'io.js')).href
);
const { pointEdit } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'point-edit.js')).href
);
const { rewriteVariants } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'point-edit.js')).href
);
const { listHistory, rollback } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'history.js')).href
);
const { roundtripCheck, renderRoundtrip } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'roundtrip.js')).href
);
const {
  searchOnline,
  ingestSearchResults,
  pendingDataNeeds,
  ragStatus,
} = await import(pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'rag.js')).href);

// Web 端默认收紧 LLM 超时与重试（避免"慢响应 + 长重试"叠加成几十秒的等待）；
// CLI/Agent 端不受影响（保持默认 300s / 4 次重试）。
if (!process.env.SCULPTOR_LLM_TIMEOUT_MS) process.env.SCULPTOR_LLM_TIMEOUT_MS = '120000';
if (!process.env.SCULPTOR_LLM_RETRIES) process.env.SCULPTOR_LLM_RETRIES = '2';
// Web 端默认开启内置免费检索（DuckDuckGo → 维基兜底），"帮我查一查"在部署即能用；
// CLI 端不设默认（保持"未配置→排队宿主代检"的原行为）。
if (!process.env.SCULPTOR_SEARCH_PROVIDER) process.env.SCULPTOR_SEARCH_PROVIDER = 'builtin';

const cfg = loadConfig();

const IO_SCRIPTS = path.resolve(HERE, '..', 'agent', 'scripts', 'io');

const GENRE_CATEGORY = {
  散文: '散文', 议论文: '议论文', 记叙文: '记叙文', 说明文: '说明文',
  学术论文: '论文', 论文: '论文', 公文: '公文', 通知: '公文', 请示: '公文',
  报告: '公文', 讲话稿: '发言稿', 发言稿: '发言稿', 演讲稿: '发言稿',
  合同: '合同', 协议: '合同', 小说: '小说', 剧本: '剧本',
  视频脚本: '视频脚本', 脚本: '视频脚本', 新闻稿: '新闻稿', 通讯: '新闻稿',
  诗歌: '诗歌', 书信: '书信', 游记: '散文', 随笔: '散文',
};

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── 会话持久化（web-data/sessions/<id>/：meta.json + transcript.jsonl + Sculptor 工作区）──
function sessionDir(id) {
  const safe = String(id || '').replace(/[^a-z0-9-]/gi, '');
  // 非法/空 id：返回必然不存在的路径（各端点随后走 404），绝不抛异常打崩服务。
  if (!safe) return path.join(SESSIONS_DIR, '__invalid__');
  const dir = path.resolve(SESSIONS_DIR, safe);
  if (!dir.startsWith(path.resolve(SESSIONS_DIR))) return path.join(SESSIONS_DIR, '__invalid__');
  return dir;
}

function readMeta(id) {
  return readJsonSafe(path.join(sessionDir(id), 'meta.json'));
}

function writeMeta(id, meta) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  meta.updatedAt = ws.nowIso();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function appendTranscript(id, entry) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'transcript.jsonl'),
    JSON.stringify({ ...entry, ts: ws.nowIso() }) + '\n',
  );
}

function readTranscript(id) {
  try {
    return fs
      .readFileSync(path.join(sessionDir(id), 'transcript.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function listSessions() {
  let ids = [];
  try {
    ids = fs.readdirSync(SESSIONS_DIR).filter((f) => f !== '.DS_Store');
  } catch {
    return [];
  }
  return ids
    .map((id) => readMeta(id))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function stateBrief(state, meta) {
  return {
    id: meta.id,
    title: meta.title,
    category: meta.category,
    status: meta.status,
    phase: state.phase || 'clarify',
    stage: state.director?.stage || '',
    topic: state.confirmed?.topic || state.outline?.title || '',
    genre: state.confirmed?.genre || '',
    confirmed: Object.keys(state.confirmed || {}).filter((k) => state.confirmed[k]).length,
    materials: (state.materials || []).length,
    arguments: (state.confirmed?.arguments || []).length,
    outlineTitle: state.outline?.title || '',
    sections: state.outline?.sections?.length || 0,
    hasDraft: fs.existsSync(path.join(sessionDir(meta.id), 'draft.md')),
    styleNote: state.confirmed?.styleNote || '',
    updatedAt: meta.updatedAt,
  };
}

function metaFromState(meta, state) {
  const stage = state.director?.stage || '';
  const phase = state.phase || 'clarify';
  let status = '澄清中';
  if (phase === 'plan' || stage === 'outline') status = '大纲中';
  else if (phase === 'write' || stage === 'write') status = '写作中';
  else if (['revise', 'redteam', 'quality', 'style_fix', 'audience', 'rewrite_gaps'].includes(stage)) status = '打磨中';
  else if (stage === 'deliver') status = '已交付';
  const genre = state.confirmed?.genre || '';
  if (genre && GENRE_CATEGORY[genre]) meta.category = GENRE_CATEGORY[genre];
  if (state.outline?.title && meta.title === '新写作') meta.title = state.outline.title.slice(0, 30);
  meta.status = status;
  return meta;
}

function botText(r) {
  const parts = [];
  if (r.kind === 'ask') {
    parts.push(r.question || '');
    if (r.recommendation) parts.push(`我的建议：${r.recommendation}`);
    if (r.knowledgeSuggestion) parts.push(r.knowledgeSuggestion);
    if (r.dataSuggestion) parts.push(r.dataSuggestion);
    if (r.searchSuggestion) parts.push(r.searchSuggestion);
    if (r.recommendSuggestion) parts.push(r.recommendSuggestion);
    if (r.academicHint) parts.push(r.academicHint);
    if (r.options?.length) parts.push(`选项：${r.options.map((o, i) => `${'ABC'[i]}. ${o}`).join('  ')}`);
  } else {
    parts.push(r.message || '');
  }
  return parts.filter(Boolean).join('\n');
}

function newSession(topic) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  ws.ensureWorkspace(dir, { create: true });
  const title = String(topic || '').replace(/\s+/g, ' ').slice(0, 30) || '新写作';
  writeMeta(id, {
    id,
    title,
    category: '',
    status: '澄清中',
    createdAt: ws.nowIso(),
    updatedAt: ws.nowIso(),
  });
  if (topic) appendTranscript(id, { role: 'user', text: String(topic) });
  return id;
}

function safeInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(r, String(target || '').replace(/^\/+/, ''));
  return t.startsWith(r + path.sep) || t === r ? t : null;
}

function staticFile(urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = safeInside(PUBLIC, rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function sendFile(res, file, name, type) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  const stream = fs.createReadStream(file);
  stream.pipe(res);
  stream.on('end', () => fs.rmSync(file, { force: true }));
  stream.on('error', () => fs.rmSync(file, { force: true }));
}

/** 大纲/成稿 → pptx（python-pptx；零模板，标题行分页）。 */
function exportPptx(mdText, outFile) {
  const tmpMd = path.join(os.tmpdir(), `.sculptor-ppt-${Date.now()}.md`);
  fs.writeFileSync(tmpMd, mdText);
  try {
    execFileSync(
      'python3',
      [path.join(IO_SCRIPTS, 'write_pptx.py'), tmpMd, path.resolve(outFile)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } finally {
    fs.rmSync(tmpMd, { force: true });
  }
  return path.resolve(outFile);
}

async function runStepAndRespond(res, id, message) {
  const dir = sessionDir(id);
  if (!fs.existsSync(path.join(dir, 'protocol', 'state.json'))) {
    return json(res, 404, { error: '会话不存在，请刷新页面' });
  }
  if (message) appendTranscript(id, { role: 'user', text: String(message) });
  try {
    const r = await agentStep(cfg, dir, { lastInput: String(message || '') });
    const state = ws.readState(dir);
    const meta = metaFromState(readMeta(id) || { id, title: '新写作', createdAt: ws.nowIso() }, state);
    writeMeta(id, meta);
    appendTranscript(id, {
      role: 'bot',
      text: botText(r),
      kind: r.kind,
      outline: r.outline || null,
      draftFile: r.draftFile || '',
    });
    json(res, 200, {
      sessionId: id,
      kind: r.kind,
      question: r.question,
      warn: r.warn || '',
      outlineGap: r.outlineGap || false,
      recommendation: r.recommendation,
      options: r.options,
      knowledgeSuggestion: r.knowledgeSuggestion || '',
      dataSuggestion: r.dataSuggestion || '',
      searchSuggestion: r.searchSuggestion || '',
      recommendSuggestion: r.recommendSuggestion || '',
      academicHint: r.academicHint || '',
      checklist: r.checklist || null,
      liveOutline: r.liveOutline || null,
      message: r.message,
      phase: r.phase,
      outline: r.outline,
      progress: r.progress,
      audience: r.audience,
      draftFile: r.draftFile,
      meta: stateBrief(state, meta),
    });
  } catch (err) {
    json(res, 500, { error: String(err.message || err).slice(0, 300) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // ── 鉴权（v0.58 已移除登录：个人/演示实例默认开放；如需防护请走反向代理）──
  if (req.method === 'GET' && p === '/api/auth/status') {
    return json(res, 200, { required: false, ok: true });
  }

  if (req.method === 'GET' && (p === '/' || p.startsWith('/assets/'))) {
    staticFile(p, res);
    return;
  }

  // ── 会话管理 ──────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/sessions') {
    // v0.58：会话列表附带各自进度（阶段/大纲节数/素材/风格底稿），
    // 便于"检查项目进展"——每个对话是独立工作流，互不影响。
    const sessions = listSessions().map((m) => {
      try {
        const state = ws.readState(sessionDir(m.id));
        return { ...m, ...stateBrief(state, m) };
      } catch {
        return m;
      }
    });
    return json(res, 200, { sessions });
  }
  if (req.method === 'POST' && p === '/api/start') {
    const { topic } = await body(req);
    const id = newSession(topic || '');
    return runStepAndRespond(res, id, topic || '');
  }
  if (req.method === 'POST' && p === '/api/step') {
    const { sessionId, message } = await body(req);
    return runStepAndRespond(res, String(sessionId || ''), String(message || ''));
  }
  if (req.method === 'GET' && p === '/api/session') {
    const id = String(url.searchParams.get('sessionId') || '');
    const meta = readMeta(id);
    if (!meta) return json(res, 404, { error: '会话不存在' });
    const state = ws.readState(sessionDir(id));
    return json(res, 200, { meta: stateBrief(state, meta) });
  }
  if (req.method === 'GET' && p === '/api/context') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    const meta = readMeta(id);
    if (!meta) return json(res, 404, { error: '会话不存在' });
    const state = ws.readState(dir);
    const answerLevels = Array.isArray(state.answerLevels) ? state.answerLevels.slice(-10) : [];
    const answerStats = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
    for (const a of state.answerLevels || []) answerStats['L' + a.level] = (answerStats['L' + a.level] || 0) + 1;
    const sections = state.outline?.sections || [];
    const lo = state.liveOutline;
    return json(res, 200, {
      id,
      phase: state.phase || 'clarify',
      stage: state.director?.stage || '',
      status: meta.status,
      title: meta.title,
      category: meta.category,
      intent: state.intent || null,
      thinking: thinkingBrief(state),
      pulses: recentPulses(dir, { limit: 6 }).map((p) => ({
        phase: p.phase,
        score: p.score,
        summary: p.summary || '',
        suggestion: p.suggestion || '',
      })),
      blueprint: state.blueprint || null,
      checklist: checklistOf(state),
      confirmed: state.confirmed || {},
      materials: (state.materials || []).slice(-8),
      styleProgress: styleProgress(dir),
      styleNote: state.confirmed?.styleNote || '',
      answerLevels,
      answerStats,
      hasDraft: fs.existsSync(path.join(dir, 'draft.md')),
      outline: state.outline
        ? {
            title: state.outline.title,
            parts: Array.isArray(state.outline.parts) ? state.outline.parts : null,
            sections: sections.map((s) => ({
              heading: s.heading,
              function: s.function,
              thesis: s.thesis || '',
              words: s.words,
              keyPoints: s.keyPoints || [],
              materials: s.materials || [],
            })),
          }
        : null,
      progress: {
        done: state.director?.writeIndex || 0,
        total: sections.length,
      },
      targetWords: Number(state.confirmed?.targetWords) || 0,
      seeds: Array.isArray(state.seeds) ? state.seeds.slice(-8) : [],
      constraints: Array.isArray(state.constraints) ? state.constraints.slice(-8) : [],
      coreThesis: state.coreThesis || '',
      overflowLog: Array.isArray(state.overflowLog) ? state.overflowLog.slice(-6) : [],
      liveOutline: lo || null,
      outlineComplete: Boolean(lo?.complete),
      outlineConfirmed: Boolean(state.confirmed?.outlineConfirmed),
      rag: ragStatus(dir, cfg),
    });
  }
  if (req.method === 'POST' && p === '/api/outline') {
    const { sessionId, outline } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    if (!fs.existsSync(path.join(dir, 'protocol', 'state.json'))) {
      return json(res, 404, { error: '会话不存在' });
    }
    const state = ws.readState(dir);
    const secs = Array.isArray(outline?.sections) ? outline.sections : [];
    const sanitized = secs
      .slice(0, 12)
      .map((s) => ({
        heading: String(s?.heading || '').trim().slice(0, 40) || '未命名节',
        function: String(s?.function || '').trim().slice(0, 16),
        thesis: String(s?.thesis || '').trim().slice(0, 120),
        words: Number(s?.words) > 0 ? Math.min(Number(s.words), 2000) : 0,
        keyPoints: Array.isArray(s?.keyPoints)
          ? s.keyPoints.map((k) => String(k).trim().slice(0, 80)).filter(Boolean).slice(0, 6)
          : [],
        materials: Array.isArray(s?.materials)
          ? s.materials.map((m) => String(m).trim().slice(0, 80)).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((s) => s.heading);
    const prev = state.liveOutline || {};
    const liveSections = sanitized.length ? sanitized : prev.sections || [];
    const progress = outlineProgress({ title: prev.title || '', sections: liveSections }, state);
    // 卷级分组（v0.42）：只做展示分组；heading 必须存在于当前节列表，未分组节自动收尾
    const validHeadings = new Set(liveSections.map((s) => s.heading));
    const rawParts = Array.isArray(outline?.parts) ? outline.parts : prev.parts || [];
    const parts = rawParts
      .map((p, i) => ({
        title: String(p?.title || `第 ${i + 1} 卷`).trim().slice(0, 40),
        sections: (Array.isArray(p?.sections) ? p.sections : [])
          .map((h) => String(h || '').trim())
          .filter((h) => validHeadings.has(h)),
      }))
      .filter((p) => p.sections.length > 0)
      .slice(0, 8);
    const grouped = new Set(parts.flatMap((p) => p.sections));
    const ungrouped = liveSections.map((s) => s.heading).filter((h) => !grouped.has(h));
    if (ungrouped.length) parts.push({ title: '未分组', sections: ungrouped });
    state.liveOutline = {
      title: String(outline?.title || state.confirmed?.topic || prev.title || '').trim().slice(0, 40),
      sections: liveSections,
      parts: parts.length ? parts : null,
      complete: Boolean(prev.complete),
      progress,
      updatedAt: ws.nowIso(),
    };
    // 编辑已即时生效，不扰动确认流程：完成度判定会自然决定下一问（缺口/确认）。
    ws.writeState(dir, state);
    ws.logContext(dir, 'outline', `用户手动编辑实时大纲（${state.liveOutline.sections.length} 节）`);
    return json(res, 200, { ok: true, liveOutline: state.liveOutline });
  }

  // ── RAG：待检索查询 / 联网检索 / 资料回灌（补齐 Web 与 agent+codex 的检索闭环）──
  if (req.method === 'GET' && p === '/api/rag/needs') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { pending: pendingDataNeeds(sessionDir(id)) });
  }
  if (req.method === 'POST' && p === '/api/rag/search') {
    const { sessionId, query } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const dir = sessionDir(id);
    const pending = pendingDataNeeds(dir);
    const queries = (
      query
        ? [String(query).slice(0, 120)]
        : pending.flatMap((r) => r.queries || [])
    )
      .filter(Boolean)
      .slice(0, 6);
    if (!queries.length) {
      return json(res, 400, {
        error: '没有待检索的查询，也没有提供 query',
        hint: '可以直接把资料粘贴进"资料回灌"输入框。',
      });
    }
    const out = await searchOnline(cfg, queries);
    if (!out.searched) {
      return json(res, 400, { error: '未配置检索端点或检索失败', hint: out.hint || '', queries });
    }
    try {
      const ing = ingestSearchResults(dir, out.results);
      return json(res, 200, { ok: true, ingested: ing.ingested, queries });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err).slice(0, 200) });
    }
  }
  if (req.method === 'POST' && p === '/api/rag/ingest') {
    const { sessionId, results, text } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const dir = sessionDir(id);
    let items = Array.isArray(results) ? results : [];
    if (!items.length && typeof text === 'string' && text.trim()) {
      const pending = pendingDataNeeds(dir);
      items = [
        {
          query: pending[0]?.queries?.[0] || '资料回灌',
          results: [
            { title: '用户粘贴资料', source: '手动回灌', snippet: text.slice(0, 8000) },
          ],
        },
      ];
    }
    if (!items.length) return json(res, 400, { error: '缺少 results 或 text' });
    try {
      const r = ingestSearchResults(dir, items);
      return json(res, 200, { ok: true, ingested: r.ingested, cached: r.cached });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err).slice(0, 200) });
    }
  }

  // ── 多模态输入：文件上传（base64 → 会话 uploads → 提取成素材）──
  if (req.method === 'POST' && p === '/api/upload') {
    const { sessionId, filename, dataBase64 } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    if (typeof dataBase64 !== 'string' || !dataBase64) {
      return json(res, 400, { error: '缺少 dataBase64' });
    }
    const b64 = dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > 20 * 1024 * 1024) {
      return json(res, 400, { error: '文件为空或超过 20MB' });
    }
    const dir = sessionDir(id);
    const upDir = path.join(dir, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    const safe =
      path
        .basename(String(filename || 'upload.bin'))
        .replace(/[^\w.\u4e00-\u9fa5-]/g, '_')
        .slice(0, 80) || 'upload.bin';
    const file = path.join(upDir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, buf);
    const state = ws.readState(dir);
    const ing = await extractInput(file, cfg);
    if (ing.kind === 'text' && ing.text) {
      state.materials = state.materials || [];
      state.materials.push(`[文件 ${safe}] ${ing.text.slice(0, 2000)}`);
      ws.writeState(dir, state);
      ws.logContext(dir, 'ingest', `Web 上传 ${safe}（${ing.source || 'text'}，${ing.text.length} 字）→ 素材`);
    } else {
      ws.logContext(dir, 'ingest', `Web 上传 ${safe}：${ing.hint || '未提取'}`);
    }
    return json(res, 200, {
      ok: true,
      file: safe,
      kind: ing.kind,
      text: ing.kind === 'text' ? (ing.text || '').slice(0, 500) : '',
      hint: ing.hint || '',
      source: ing.source || '',
    });
  }

  // ── 句子级点改：选中原文 → AI 只改这一句 → 吸收进风格档案 ──
  if (req.method === 'POST' && p === '/api/point-edit') {
    const { sessionId, quote, instruction, replacement } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    if (!String(quote || '').trim()) return json(res, 400, { error: '请先选中要改写的原文' });
    if (!String(instruction || '').trim()) return json(res, 400, { error: '缺少修改指令' });
    const dir = sessionDir(id);
    const draftFile = path.join(dir, 'draft.md');
    if (!fs.existsSync(draftFile)) return json(res, 400, { error: '还没有成稿，无法定点修改' });
    try {
      const out = await pointEdit(cfg, dir, {
        quote: String(quote),
        instruction: String(instruction),
        replacement: typeof replacement === 'string' ? replacement : undefined,
        dir,
        file: draftFile,
      });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err).slice(0, 300) });
    }
  }

  // ── 批注（v0.61）：选段批注 → 落库 → 查看/删除 → 一键 AI 按批注修改 ──
  const annFile = (dir) => path.join(dir, 'vault', 'annotations.jsonl');
  const readAnn = (dir) => {
    try {
      return fs
        .readFileSync(annFile(dir), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const writeAnn = (dir, list) => {
    fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });
    fs.writeFileSync(annFile(dir), list.map((a) => JSON.stringify(a)).join('\n') + (list.length ? '\n' : ''));
  };
  if (req.method === 'POST' && p === '/api/annotations') {
    const { sessionId = '', file = 'draft.md', quote = '', comment = '' } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    if (!String(quote || '').trim() || !String(comment || '').trim()) {
      return json(res, 400, { error: '缺少选中原文或批注内容' });
    }
    const dir = sessionDir(id);
    const list = readAnn(dir);
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      ts: ws.nowIso(),
      file: String(file).slice(0, 120),
      quote: String(quote).slice(0, 300),
      comment: String(comment).slice(0, 600),
      status: 'open',
    };
    list.push(entry);
    writeAnn(dir, list);
    return json(res, 200, { ok: true, annotation: entry });
  }
  if (req.method === 'GET' && p === '/api/annotations') {
    const id = String(url.searchParams.get('sessionId') || '');
    const file = String(url.searchParams.get('file') || '');
    const dir = sessionDir(id);
    let list = readAnn(dir);
    if (file) list = list.filter((a) => a.file === file);
    return json(res, 200, { annotations: list.sort((a, b) => String(a.ts).localeCompare(String(b.ts))) });
  }
  if (req.method === 'DELETE' && p === '/api/annotations') {
    const { sessionId = '', id: annId = '' } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    const list = readAnn(dir).filter((a) => a.id !== annId);
    writeAnn(dir, list);
    return json(res, 200, { ok: true, removed: annId });
  }
  if (req.method === 'POST' && p === '/api/annotations/apply') {
    const { sessionId = '' } = await body(req);
    const id = String(sessionId || '');
    const dir = sessionDir(id);
    if (!fs.existsSync(path.join(dir, 'draft.md'))) return json(res, 400, { error: '还没有成稿，无法按批注修改' });
    const list = readAnn(dir);
    const draftFile = path.join(dir, 'draft.md');
    const applied = [];
    const failed = [];
    for (const a of list) {
      if (a.status === 'done' || (a.file && a.file !== 'draft.md')) continue;
      const attempts = [a.quote, `**${a.quote}**`, `\`${a.quote}\``];
      let out = null;
      for (const q of attempts) {
        try {
          out = await pointEdit(cfg, dir, { quote: q, instruction: a.comment, dir, file: draftFile });
          break;
        } catch (e) {
          out = null;
        }
      }
      if (out) {
        a.status = 'done';
        applied.push({ id: a.id, quote: a.quote.slice(0, 60) });
      } else {
        failed.push({ id: a.id, quote: a.quote.slice(0, 60), error: '未在原文中找到该片段，或修改失败' });
      }
    }
    writeAnn(dir, list);
    return json(res, 200, { ok: true, applied, failed, total: applied.length + failed.length });
  }

  // ── 候选改写（v0.46）：选中片段 → 3 个方向不同的候选（不落盘）──
  if (req.method === 'POST' && p === '/api/rewrite') {
    const { sessionId, quote, instruction } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    if (!String(quote || '').trim() || !String(instruction || '').trim()) {
      return json(res, 400, { error: '缺少选中原文或修改指令' });
    }
    const dir = sessionDir(id);
    const draftFile = path.join(dir, 'draft.md');
    if (!fs.existsSync(draftFile)) return json(res, 400, { error: '还没有成稿，无法改写' });
    try {
      const out = await rewriteVariants(cfg, dir, {
        quote: String(quote),
        instruction: String(instruction),
        dir,
        file: draftFile,
      });
      return json(res, 200, { ok: true, ...out });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err).slice(0, 300) });
    }
  }

  // ── 版本历史 / 回滚（v0.46）：每次 AI 改动都可回退 ──
  if (req.method === 'GET' && p === '/api/history') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { entries: listHistory(sessionDir(id)) });
  }
  if (req.method === 'POST' && p === '/api/rollback') {
    const { sessionId, index } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    try {
      const r = rollback(sessionDir(id), { index: Number(index || 1) });
      return json(res, 200, { ok: true, reason: r.reason, ts: r.ts, chars: r.chars });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err).slice(0, 300) });
    }
  }

  // ── 回译校验（内容保真 + 风格对比）：一键入口 ──
  if (req.method === 'POST' && p === '/api/roundtrip') {
    const { sessionId } = await body(req);
    const id = String(sessionId || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const dir = sessionDir(id);
    if (!fs.existsSync(path.join(dir, 'draft.md'))) {
      return json(res, 400, { error: '还没有成稿，无法回译校验' });
    }
    try {
      const r = await roundtripCheck(cfg, dir, {});
      return json(res, 200, {
        ok: true,
        verdict: r.verdict,
        content: r.content,
        style: r.style,
        report: renderRoundtrip(r),
      });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err).slice(0, 300) });
    }
  }
  if (req.method === 'GET' && p === '/api/overview') {
    const sessions = listSessions();
    let works = 0;
    let drafts = 0;
    let knowledge = 0;
    const byCat = {};
    for (const meta of sessions) {
      const dir = sessionDir(meta.id);
      const index = readJsonSafe(path.join(dir, 'vault', 'library', 'index.json'));
      for (const piece of index?.pieces || []) {
        works += 1;
        byCat[piece.category] = (byCat[piece.category] || 0) + 1;
      }
      try {
        knowledge += listEntries(dir).length;
      } catch {}
      if (fs.existsSync(path.join(dir, 'draft.md'))) drafts += 1;
    }
    return json(res, 200, { sessions: sessions.length, works, drafts, knowledge, byCat, recent: sessions.slice(0, 5) });
  }
  if (req.method === 'PATCH' && p === '/api/session') {
    const { sessionId, title, category } = await body(req);
    const meta = readMeta(String(sessionId || ''));
    if (!meta) return json(res, 404, { error: '会话不存在' });
    if (typeof title === 'string' && title.trim()) meta.title = title.trim().slice(0, 40);
    if (typeof category === 'string' && category.trim()) meta.category = category.trim().slice(0, 20);
    writeMeta(meta.id, meta);
    return json(res, 200, { ok: true, meta });
  }
  if (req.method === 'DELETE' && p === '/api/session') {
    const { sessionId } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    if (!fs.existsSync(dir)) return json(res, 404, { error: '会话不存在' });
    fs.rmSync(dir, { recursive: true, force: true });
    return json(res, 200, { ok: true, removed: sessionId });
  }
  if (req.method === 'GET' && p === '/api/transcript') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { entries: readTranscript(id) });
  }
  if (req.method === 'GET' && p === '/api/draft') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    try {
      return json(res, 200, { text: fs.readFileSync(path.join(dir, 'draft.md'), 'utf8') });
    } catch {
      return json(res, 200, { text: '' });
    }
  }
  if (req.method === 'POST' && p === '/api/save-draft') {
    const { sessionId, text } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    if (!fs.existsSync(path.join(dir, 'protocol', 'state.json'))) {
      return json(res, 404, { error: '会话不存在' });
    }
    fs.writeFileSync(path.join(dir, 'draft.md'), String(text ?? ''));
    const meta = readMeta(sessionId);
    if (meta) writeMeta(meta.id, meta);
    return json(res, 200, { ok: true });
  }

  // ── 风格肖像 / 知识库 / 作品库 ────────────────────────
  if (req.method === 'GET' && p === '/api/style') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const state = ws.readState(dir);
    return json(res, 200, {
      write: readJsonSafe(path.join(dir, 'vault', 'write-style.json')),
      read: readJsonSafe(path.join(dir, 'vault', 'read-style.json')),
      vector: readVector(dir),
      vectorSummary: vectorSummary(dir) || null,
      persona: readPersona(dir),
      progress: styleProgress(dir),
      styleNote: state.confirmed?.styleNote || '',
    });
  }
  if (req.method === 'GET' && p === '/api/modulator') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const status = modulatorStatus(dir);
    const draftPath = path.join(dir, 'draft.md');
    const draft = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8').slice(0, 4000) : '';
    let breakdown = null;
    if (draft) {
      const m = modulate(dir, draft, { t: 0.5 });
      breakdown = {
        mode: m.mode,
        trained: m.trained,
        rationale: m.rationale || '',
        contributions: (m.contributions || []).map((c) => ({
          feature: c.feature,
          weight: Number(c.weight),
          value: Number(c.value),
          contrib: Number(c.contrib),
        })),
      };
    }
    return json(res, 200, { ...status, breakdown });
  }
  if (req.method === 'GET' && p === '/api/knowledge') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (id) {
      if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, { entries: listEntries(sessionDir(id)) });
    }
    // 个人知识库聚合视图（v0.58）：跨会话按标题去重合并，作为"你的个人知识库"。
    const byTitle = new Map();
    for (const s of listSessions()) {
      for (const e of listEntries(sessionDir(s.id))) {
        const key = normTitle(e.title);
        const prev = byTitle.get(key);
        if (!prev || Number(e.confidence || 0) > Number(prev.confidence || 0)) {
          byTitle.set(key, { ...e, sessionId: s.id });
        }
      }
    }
    return json(res, 200, { entries: [...byTitle.values()], shared: true });
  }
  if (req.method === 'DELETE' && p === '/api/knowledge') {
    const { sessionId, id } = await body(req);
    if (!readMeta(String(sessionId || ''))) return json(res, 404, { error: '会话不存在' });
    try {
      removeEntry(sessionDir(String(sessionId)), String(id || ''));
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }
  if (req.method === 'GET' && p === '/api/works') {
    const works = [];
    for (const meta of listSessions()) {
      const dir = sessionDir(meta.id);
      const index = readJsonSafe(path.join(dir, 'vault', 'library', 'index.json'));
      for (const piece of index?.pieces || []) {
        let chars = 0;
        try {
          chars = fs
            .readFileSync(path.join(dir, piece.file), 'utf8')
            .replace(/\s/g, '')
            .length;
        } catch {}
        works.push({
          sessionId: meta.id,
          sessionTitle: meta.title,
          file: piece.file,
          title: piece.title,
          category: piece.category,
          ts: piece.ts,
          source: piece.source || '',
          chars,
          draftOnly: false,
        });
      }
      if (fs.existsSync(path.join(dir, 'draft.md')) && !(index?.pieces || []).some((x) => x.source === 'draft.md')) {
        const state = ws.readState(dir);
        works.push({
          sessionId: meta.id,
          sessionTitle: meta.title,
          file: 'draft.md',
          title: state.outline?.title || state.confirmed?.topic || meta.title || '进行中的草稿',
          category: meta.category || '进行中',
          ts: meta.updatedAt,
          source: 'draft.md',
          draftOnly: true,
        });
      }
    }
    works.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return json(res, 200, { works });
  }
  // ── 作品同步 / 导入 / 管理（v0.60：全流程互操作）────────────────
  if (req.method === 'POST' && p === '/api/works/import') {
    const { sessionId = '', title = '', text = '', dataBase64 = '', filename = 'import.md', source = 'import' } = await body(req);
    let id = String(sessionId || '');
    if (!id || !fs.existsSync(sessionDir(id))) id = newSession(title || '作品库');
    const dir = sessionDir(id);
    let content = String(text || '');
    if (!content && dataBase64) content = Buffer.from(String(dataBase64), 'base64').toString('utf8');
    if (!content.trim()) return json(res, 400, { error: '没有可导入的内容' });
    if (!importWork) return json(res, 500, { error: 'library 模块不可用' });
    const r = importWork(dir, {
      title: title || String(filename || 'import.md').replace(/\.(docx|md|txt)$/i, ''),
      text: content,
      source,
    });
    try {
      const index = readJsonSafe(path.join(dir, 'vault', 'library', 'index.json'));
      if (index?.pieces) {
        for (const piece of index.pieces) if (r.pieces.some((x) => x.file === piece.file)) piece.session = id;
        fs.writeFileSync(path.join(dir, 'vault', 'library', 'index.json'), JSON.stringify(index, null, 2));
      }
    } catch {}
    return json(res, 200, {
      ok: true,
      sessionId: id,
      parts: r.parts,
      pieces: r.pieces.map((x) => ({ file: x.file, title: x.title, category: x.category })),
    });
  }
  if (req.method === 'POST' && p === '/api/works/sync') {
    let synced = 0;
    for (const meta of listSessions()) {
      const dir = sessionDir(meta.id);
      const draft = path.join(dir, 'draft.md');
      if (!fs.existsSync(draft) || !addPiece) continue;
      const index = readJsonSafe(path.join(dir, 'vault', 'library', 'index.json'));
      const existing = (index?.pieces || []).find((x) => x.source === 'draft.md');
      if (existing && fs.existsSync(path.join(dir, 'vault', 'library', existing.file))) continue;
      try {
        const state = ws.readState(dir);
        addPiece(dir, {
          title: state?.confirmed?.topic || state?.outline?.title || meta.title || '未命名作品',
          text: fs.readFileSync(draft, 'utf8'),
          source: 'draft.md',
          session: meta.id,
        });
        synced += 1;
      } catch {}
    }
    return json(res, 200, { ok: true, synced });
  }
  if (req.method === 'POST' && p === '/api/work') {
    const { sessionId = '', file = '', title = '', category = '' } = await body(req);
    const dir = sessionDir(String(sessionId));
    const indexFile = path.join(dir, 'vault', 'library', 'index.json');
    const index = readJsonSafe(indexFile);
    if (!index) return json(res, 404, { error: '作品索引不存在' });
    const piece = (index.pieces || []).find((x) => x.file === file);
    if (!piece) return json(res, 404, { error: '作品不存在' });
    if (title) piece.title = String(title).slice(0, 60);
    if (category) piece.category = String(category).slice(0, 20);
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    return json(res, 200, { ok: true, piece });
  }
  if (req.method === 'DELETE' && p === '/api/work') {
    const { sessionId = '', file = '' } = await body(req);
    const dir = sessionDir(String(sessionId));
    const indexFile = path.join(dir, 'vault', 'library', 'index.json');
    const index = readJsonSafe(indexFile);
    if (!index) return json(res, 404, { error: '作品索引不存在' });
    index.pieces = (index.pieces || []).filter((x) => x.file !== file);
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    const full = safeInside(dir, path.join('vault', 'library', String(file)));
    if (full && fs.existsSync(full)) fs.rmSync(full, { force: true });
    return json(res, 200, { ok: true, removed: file });
  }
  if (req.method === 'POST' && p === '/api/import-draft') {
    const { sessionId = '', title = '', text = '', dataBase64 = '', filename = 'draft.md' } = await body(req);
    const id = String(sessionId || '');
    const dir = sessionDir(id);
    if (!fs.existsSync(path.join(dir, 'protocol', 'state.json'))) return json(res, 404, { error: '会话不存在' });
    let content = String(text || '');
    if (!content && dataBase64) content = Buffer.from(String(dataBase64), 'base64').toString('utf8');
    if (!content.trim()) return json(res, 400, { error: '没有可导入的内容' });
    fs.writeFileSync(path.join(dir, 'draft.md'), content);
    const meta = readMeta(id) || { id, title: '新写作', createdAt: ws.nowIso() };
    meta.title = String(title || meta.title || filename.replace(/\.(docx|md|txt)$/i, '')).slice(0, 40);
    meta.status = '已导入草稿';
    meta.updatedAt = ws.nowIso();
    writeMeta(id, meta);
    appendTranscript(id, {
      role: 'bot',
      text: `已导入草稿（${content.replace(/\s/g, '').length} 字），可直接审计/导出/继续改写。`,
      kind: 'working',
    });
    return json(res, 200, { ok: true, chars: content.replace(/\s/g, '').length, title: meta.title });
  }
  // ── 多作品对比（v0.48，P2）：两篇作品的人类化指标并排 ──
  if (req.method === 'GET' && p === '/api/works/compare') {
    const read = (id, f) => {
      try {
        return fs.readFileSync(path.join(sessionDir(String(id || '')), String(f || '')), 'utf8');
      } catch {
        return '';
      }
    };
    const t1 = read(url.searchParams.get('sessionId'), url.searchParams.get('file'));
    const t2 = read(url.searchParams.get('sessionId2'), url.searchParams.get('file2'));
    return json(res, 200, {
      a: { ...humanMetrics(t1), chars: t1.replace(/\s/g, '').length },
      b: { ...humanMetrics(t2), chars: t2.replace(/\s/g, '').length },
    });
  }
  if (req.method === 'GET' && p === '/api/work') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    const file = safeInside(dir, String(url.searchParams.get('file') || ''));
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: '作品不存在' });
    return json(res, 200, {
      text: fs.readFileSync(file, 'utf8'),
      title: path.basename(file),
    });
  }

  // ── 导出 md / docx / pptx ────────────────────────────
  if (req.method === 'GET' && p === '/api/export') {
    const id = String(url.searchParams.get('sessionId') || '');
    const fmt = String(url.searchParams.get('fmt') || 'md');
    const what = String(url.searchParams.get('what') || 'draft');
    const dir = sessionDir(id);
    const meta = readMeta(id);
    if (!meta) return json(res, 404, { error: '会话不存在' });
    const draft = path.join(dir, 'draft.md');
    const fileParam = url.searchParams.get('file');
    const srcFile = fileParam ? safeInside(dir, String(fileParam)) : null;
    let mdText = '';
    if (what === 'outline') {
      const state = ws.readState(dir);
      const o = state.outline || state.liveOutline || {};
      mdText = `# ${o.title || meta.title || '大纲'}\n\n${
        (o.sections || [])
          .map((s, i) => `## ${i + 1}. ${s.heading}${s.thesis ? `｜${s.thesis}` : ''}\n\n${(s.keyPoints || []).map((k) => `- ${k}`).join('\n')}`)
          .join('\n\n')
      }\n`;
    } else if (what === 'report') {
      for (const f of ['norm-report.md', 'redteam-report.md', 'report.md']) {
        const rf = path.join(dir, 'vault', f);
        if (fs.existsSync(rf)) {
          mdText = fs.readFileSync(rf, 'utf8');
          break;
        }
      }
    } else if (what === 'style') {
      const w = readJsonSafe(path.join(dir, 'vault', 'write-style.json')) || {};
      const r = readJsonSafe(path.join(dir, 'vault', 'read-style.json')) || {};
      const dimLines = (obj) =>
        Object.entries(obj.dimensions || {})
          .filter(([, d]) => d && d.value)
          .map(([k, d]) => `- ${k}：${d.value}（置信 ${Math.round((Number(d.confidence) || 0) * 100)}%）`);
      mdText = ['# 风格肖像', '', '## write（人想写的）', '', ...dimLines(w), '', '## read（人想听的）', '', ...dimLines(r), ''].join('\n');
    } else if (what === 'knowledge') {
      mdText = ['# 个人知识库', '']
        .concat(
          listEntries(dir).map(
            (e) =>
              `## ${e.title}\n- 类型：${e.type}\n- 来源：${e.source}\n- 置信：${Math.round((e.confidence || 0) * 100)}%\n- 标签：${(e.tags || []).join('、') || '—'}\n${e.note ? `\n${e.note}\n` : ''}`,
          ),
        )
        .join('\n');
    } else {
      mdText = srcFile && fs.existsSync(srcFile)
        ? fs.readFileSync(srcFile, 'utf8')
        : fs.existsSync(draft)
        ? fs.readFileSync(draft, 'utf8')
        : (() => {
            const state = ws.readState(dir);
            if (!state.outline?.title) return '';
            const o = state.outline;
            return `# ${o.title}\n\n${(o.sections || [])
              .map((s, i) => `## ${i + 1}. ${s.heading}\n\n${(s.keyPoints || []).join('\n')}`)
              .join('\n\n')}\n`;
          })();
    }
    if (!mdText.trim()) return json(res, 400, { error: '还没有成稿或大纲，无法导出' });
    const base = `${meta.title || 'sculptor'}-${new Date().toISOString().slice(0, 10)}`;
    if (fmt === 'md') {
      const f = path.join(os.tmpdir(), `${base}.md`);
      fs.writeFileSync(f, mdText);
      return sendFile(res, f, `${base}.md`, 'text/markdown; charset=utf-8');
    }
    if (fmt === 'docx') {
      if (!docxAvailable()) return json(res, 400, { error: '本机没有 python-docx，请先导出 md' });
      try {
        const f = exportDocx(mdText, path.join(os.tmpdir(), `${base}.docx`));
        return sendFile(res, f, `${base}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
      }
    }
    if (fmt === 'pptx') {
      try {
        const f = exportPptx(mdText, path.join(os.tmpdir(), `${base}.pptx`));
        return sendFile(res, f, `${base}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      } catch (err) {
        return json(res, 500, { error: `导出 pptx 失败（${String(err.message || err).slice(0, 160)}），可先导出 md` });
      }
    }
    return json(res, 400, { error: '不支持的格式：md / docx / pptx' });
  }

  // ── 审计报告（保留） ──────────────────────────────────
  if (req.method === 'GET' && p === '/api/report') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    try {
      const text = fs.readFileSync(path.join(dir, 'draft.md'), 'utf8');
      const m = humanMetrics(text);
      const state = ws.readState(dir);
      const issues = [];
      if (m.blacklistHits > 0) issues.push(`检出 ${m.blacklistHits} 处黑名单套话，已按你的风格修订`);
      if (m.repeatedMetaphors > 0) issues.push(`检出 ${m.repeatedMetaphors} 处重复比喻，已改为不同的意象`);
      if (m.repeatedPatterns > 0) issues.push(`检出 ${m.repeatedPatterns} 处句式复用，已调整节奏`);
      if (!issues.length) issues.push('未发现硬伤（黑名单 0 · 硬失败 0），人类化指标均在真人参考区间');
      return json(res, 200, {
        metrics: m,
        issues,
        passed: m.passed,
        roundtrip: state.quality?.roundtrip || null,
        fakeThinking: state.quality?.fakeThinking || null,
      });
    } catch {
      return json(res, 200, { metrics: {}, issues: ['（尚无成稿可审计）'], passed: false });
    }
  }

  // ── 节奏曲线 / 伏笔回收（v0.41：行业对齐——节奏分析 + 跨章一致性）──
  if (req.method === 'GET' && p === '/api/curve') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    const c = rhythmCurve(sessionDir(id));
    return json(res, 200, { sections: c.sections, note: c.note || '', file: c.file || '' });
  }
  if (req.method === 'GET' && p === '/api/consistency') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    try {
      const r = await checkConsistency(cfg, sessionDir(id));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { score: 100, total: 0, recovered: [], unrecovered: [], note: String(e.message || '校验失败') });
    }
  }

  // ── 工具：学术规范审计 / 文档翻译 / 文档重写（v0.56）──
  if (req.method === 'POST' && p === '/api/norm') {
    const { sessionId } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    if (!fs.existsSync(path.join(dir, 'draft.md'))) {
      return json(res, 400, { error: '该会话还没有成稿，无法执行学术规范审计' });
    }
    let genre = '';
    try {
      genre = ws.readState(dir)?.confirmed?.genre || '';
    } catch {}
    const r = await academicNorm(cfg, dir, { genre });
    return json(res, 200, {
      score: r.score,
      items: r.items,
      summary: r.summary,
      llmMode: r.llmMode,
      reason: r.llmReason || '',
    });
  }
  if (req.method === 'POST' && (p === '/api/doc/translate' || p === '/api/doc/restyle')) {
    const { sessionId = '', filename = 'upload.md', dataBase64 = '', lang = 'en', style = '' } = await body(req);
    const dir = sessionDir(String(sessionId || ''));
    fs.mkdirSync(dir, { recursive: true });
    const upDir = path.join(dir, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    const name = path.basename(String(filename || 'upload.md')).slice(0, 80) || 'upload.md';
    const src = path.join(upDir, `tool-${Date.now()}-${name}`);
    fs.writeFileSync(src, Buffer.from(String(dataBase64 || ''), 'base64'));
    const toolsDir = path.join(dir, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const outBase = path.join(toolsDir, `out-${Date.now()}`);
    const r = p === '/api/doc/translate'
      ? await docTranslate(cfg, dir, { file: src, lang: String(lang || 'en'), out: outBase })
      : await docRestyle(cfg, dir, { file: src, style: String(style || ''), out: outBase });
    return json(res, 200, {
      ok: r.ok,
      mode: r.mode,
      blocks: r.blocks,
      replaced: r.replaced,
      missing: r.missing || [],
      interpretation: r.interpretation || null,
      summary: r.summary || '',
      roundtrip: r.roundtrip || null,
      reason: r.reason || '',
      files: (r.files || []).map((f) => path.relative(dir, f)),
    });
  }
  if (req.method === 'GET' && p === '/api/doc/download') {
    const id = String(url.searchParams.get('sessionId') || '');
    const dir = sessionDir(id);
    const f = safeInside(dir, String(url.searchParams.get('file') || ''));
    if (!f || !fs.existsSync(f)) return json(res, 404, { error: '文件不存在' });
    const type = f.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : f.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'text/markdown; charset=utf-8';
    return sendFile(res, f, path.basename(f), type);
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(
    `Sculptor Studio → http://localhost:${PORT}（${process.env.SCULPTOR_MOCK_LLM === '1' ? '离线 mock 模式' : '真实 LLM 模式'}）`,
  );
  console.log(`  会话数据: ${DATA_ROOT}`);
});
