#!/usr/bin/env node
// Sculptor Web 演示版（v0.24）：零依赖 Node HTTP 服务。
// 把 Sculptor 导演状态机（agentStep）包成 REST，前端聊天式展示
// "Codex + Sculptor 组合"的完整写作流程：澄清 → 大纲 → 逐节写作 → 审计 → 交付。
// 会话：进程内临时工作区（演示级）；SCULPTOR_MOCK_LLM=1 时用内置 mock（离线验证）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 5177);
const PUBLIC = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'public');

// 离线 mock（与单测同一套）：SCULPTOR_MOCK_LLM=1 时启用，用于本地/CI 验证
if (process.env.SCULPTOR_MOCK_LLM === '1') {
  const { respond } = await import(
    pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'agent', 'test', 'mock-llm.mjs')).href
  );
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
}

const { loadConfig } = await import(
  pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'agent', 'src', 'config.js')).href
);
const { agentStep } = await import(
  pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'agent', 'src', 'director.js')).href
);
const { ensureWorkspace } = await import(
  pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'agent', 'src', 'workspace.js')).href
);

const cfg = loadConfig();
const sessions = new Map();

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

function staticFile(urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function newSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-web-'));
  ensureWorkspace(dir, { create: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(id, { dir, createdAt: Date.now() });
  // 会话超过 50 个或超过 2 小时，清理最旧的（演示级防泄漏）
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (sessions.size > 50 || now - v.createdAt > 2 * 3600 * 1000) sessions.delete(k);
  }
  return id;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
    staticFile(url.pathname, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    const { topic } = await body(req);
    const id = newSession();
    try {
      const r = await agentStep(cfg, sessions.get(id).dir, { lastInput: topic || '' });
      json(res, 200, { sessionId: id, kind: r.kind, question: r.question, recommendation: r.recommendation, options: r.options, message: r.message, phase: r.phase, outline: r.outline });
    } catch (err) {
      json(res, 500, { error: String(err.message || err).slice(0, 300) });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/step') {
    const { sessionId, message } = await body(req);
    const s = sessions.get(String(sessionId || ''));
    if (!s) return json(res, 404, { error: '会话不存在或已过期，请刷新页面重新开始' });
    try {
      const r = await agentStep(cfg, s.dir, { lastInput: String(message || '') });
      json(res, 200, {
        kind: r.kind,
        question: r.question,
        recommendation: r.recommendation,
        options: r.options,
        knowledgeSuggestion: r.knowledgeSuggestion || '',
        dataSuggestion: r.dataSuggestion || '',
        message: r.message,
        phase: r.phase,
        outline: r.outline,
        progress: r.progress,
        audience: r.audience,
        draftFile: r.draftFile,
      });
    } catch (err) {
      json(res, 500, { error: String(err.message || err).slice(0, 300) });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/draft') {
    const s = sessions.get(String(url.searchParams.get('sessionId') || ''));
    if (!s) return json(res, 404, { error: '会话不存在' });
    try {
      const text = fs.readFileSync(path.join(s.dir, 'draft.md'), 'utf8');
      json(res, 200, { text });
    } catch {
      json(res, 200, { text: '' });
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`Sculptor Web 演示版 → http://localhost:${PORT}（${process.env.SCULPTOR_MOCK_LLM === '1' ? '离线 mock 模式' : '真实 LLM 模式'}）`);
});
