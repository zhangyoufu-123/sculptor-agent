#!/usr/bin/env node
// Stylotrace 无头引擎桥（headless bridge）：供 FastAPI / 任意后端以子进程方式调用。
// 输入：stdin 一段 JSON —— {"message":"用户输入","workspace":"/abs/会话目录"}
// 凭据：环境变量 BYOK —— STYLOTRACE_LLM_API_KEY / STYLOTRACE_LLM_BASE_URL / STYLOTRACE_LLM_MODEL
// 输出：stdout 一段 JSON —— agentStep 的结果 + 轻量状态摘要（或 {"error":"..."}）。
// 离线：STYLOTRACE_MOCK_LLM=1 时用内置 mock（便于后端冒烟测试）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function fail(msg) {
  process.stdout.write(JSON.stringify({ error: String(msg || '未知错误') }) + '\n');
  process.exit(0);
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return fail('无法读取 stdin');
  }
  let req = {};
  try {
    req = JSON.parse(raw || '{}');
  } catch {
    return fail('请求不是合法 JSON');
  }

  const message = String(req.message ?? '');
  const workspace = String(req.workspace || '').trim();
  if (!workspace || !path.isAbsolute(workspace)) {
    return fail('缺少绝对路径 workspace');
  }

  // 离线 mock（与单测/Web 同一套）
  if (process.env.STYLOTRACE_MOCK_LLM === '1') {
    const { respond } = await import(
      pathToFileURL(path.resolve(ROOT, 'test', 'mock-llm.mjs')).href
    );
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts?.body || '{}');
      const content = respond(body.messages || []);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
      };
    };
  }

  const { loadConfig } = await import(pathToFileURL(path.resolve(ROOT, 'src', 'config.js')).href);
  const { agentStep } = await import(pathToFileURL(path.resolve(ROOT, 'src', 'director.js')).href);
  const ws = await import(pathToFileURL(path.resolve(ROOT, 'src', 'workspace.js')).href);

  const cfg = loadConfig();
  fs.mkdirSync(workspace, { recursive: true });
  const dir = ws.ensureWorkspace(workspace, { create: true });

  try {
    const r = await agentStep(cfg, dir, { lastInput: message });
    const state = ws.readState(dir);
    const out = {
      ok: true,
      model: cfg.model,
      kind: r.kind || '',
      question: r.question || '',
      message: r.message || '',
      warn: r.warn || '',
      recommendation: r.recommendation || '',
      options: Array.isArray(r.options) ? r.options : [],
      knowledgeSuggestion: r.knowledgeSuggestion || '',
      dataSuggestion: r.dataSuggestion || '',
      searchSuggestion: r.searchSuggestion || '',
      academicHint: r.academicHint || '',
      checklist: r.checklist || null,
      liveOutline: r.liveOutline || null,
      phase: state.phase || '',
      stage: state.director?.stage || '',
      outline: r.outline || state.outline || null,
      draftFile: r.draftFile || '',
      docx: r.docx || '',
      archived: r.archived || '',
      progress: r.progress ?? null,
      next: r.next || '',
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  } catch (e) {
    fail(e?.message || e);
  }
}

main();
