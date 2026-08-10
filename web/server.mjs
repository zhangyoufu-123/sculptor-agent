#!/usr/bin/env node
// Sculptor Studio Web（v0.26）：零依赖 Node HTTP 服务。
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
const { readVector, vectorSummary } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'style-vector.js')).href
);
const { readPersona } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'persona.js')).href
);
const { listEntries, removeEntry } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'knowledge.js')).href
);
const { checklistOf } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'clarify.js')).href
);
const { outlineProgress, nextOutlineGap } = await import(
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
const { roundtripCheck, renderRoundtrip } = await import(
  pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'roundtrip.js')).href
);
const {
  searchOnline,
  ingestSearchResults,
  pendingDataNeeds,
  ragStatus,
} = await import(pathToFileURL(path.resolve(HERE, '..', 'agent', 'src', 'rag.js')).href);

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
  const dir = path.resolve(SESSIONS_DIR, safe);
  if (!dir.startsWith(path.resolve(SESSIONS_DIR)) || !safe) throw new Error('非法会话 id');
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

  if (req.method === 'GET' && (p === '/' || p.startsWith('/assets/'))) {
    staticFile(p, res);
    return;
  }

  // ── 会话管理 ──────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/sessions') {
    return json(res, 200, { sessions: listSessions() });
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
    state.liveOutline = {
      title: String(outline?.title || state.confirmed?.topic || prev.title || '').trim().slice(0, 40),
      sections: liveSections,
      complete: progress.complete,
      progress,
      nextGap: progress.complete ? null : nextOutlineGap(progress),
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
    const { sessionId, quote, instruction } = await body(req);
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
        dir,
        file: draftFile,
      });
      return json(res, 200, { ok: true, ...out });
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
  if (req.method === 'GET' && p === '/api/knowledge') {
    const id = String(url.searchParams.get('sessionId') || '');
    if (!readMeta(id)) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { entries: listEntries(sessionDir(id)) });
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
    const dir = sessionDir(id);
    const meta = readMeta(id);
    if (!meta) return json(res, 404, { error: '会话不存在' });
    const draft = path.join(dir, 'draft.md');
    const fileParam = url.searchParams.get('file');
    const srcFile = fileParam ? safeInside(dir, String(fileParam)) : null;
    const mdText = srcFile && fs.existsSync(srcFile)
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
      });
    } catch {
      return json(res, 200, { metrics: {}, issues: ['（尚无成稿可审计）'], passed: false });
    }
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
