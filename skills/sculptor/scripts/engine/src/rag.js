// 联网 RAG（检索增强）：给事实核查、原创性检查提供"去查证"的通路。
// 两条通路，互不冲突：
//  1) 宿主代检（默认，零网络依赖）：把检索请求写入 protocol/requests.jsonl
//     （status: pending，type: web-search），宿主（Codex/Claude/OpenCode）执行检索后，
//     用 `sculptor rag ingest <results.json>` 或 MCP `rag_ingest` 回灌；
//  2) 直连检索（可选）：配置 SCULPTOR_RAG_ENDPOINT + SCULPTOR_RAG_API_KEY 后，
//     直接 POST {endpoint}/search {queries:[...]}，兼容任何把查询映射到结果的网关。
// 结果缓存 vault/rag-cache.json（最多 100 条），并作为素材回填，供写作/事实核查复用。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';
import { extractCitations } from './citation.js';

const CACHE_FILE = 'rag-cache.json';
const CACHE_MAX = 100;

/** 从文稿与事实核查报告生成检索查询（确定性）。 */
export function buildSearchQueries(text, { factReport = null, topic = '', limit = 6 } = {}) {
  const queries = [];
  const push = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length >= 6 && !queries.includes(s)) queries.push(s);
  };
  for (const it of factReport?.items || []) {
    if (it.supported === 'verify' && it.text) push(`${topic} ${it.text}`);
  }
  for (const c of extractCitations(text)) push(`${topic} ${c.title}`);
  // 年份+名词、数字+单位 等高价值事实片段
  const t = String(text || '');
  for (const m of t.matchAll(/(\d{3,4}\s*年[^，。；\n]{0,18})/g)) push(m[1]);
  for (const m of t.matchAll(/([\d０-９]+[万亿]?[人个座篇家所层米公里吨元])([^，。；\n]{0,12})/g)) {
    push(m[1] + m[2]);
  }
  if (topic) push(topic);
  return queries.slice(0, limit);
}

/** 通路 1：把检索请求写入 requests.jsonl（宿主代检）。 */
export function requestHostSearch(workspace, queries, { purpose = 'fact-check' } = {}) {
  if (!queries?.length) return { queued: 0 };
  const requestId = `${Date.now()}-${purpose}`;
  ws.queueRequest(workspace, {
    type: 'web-search',
    purpose,
    requestId,
    queries,
    hint:
      '请用宿主自身的联网搜索能力检索这些查询，把结果整理成 [{query, results:[{title,url,snippet,source}]}] 的 JSON 文件，然后运行: sculptor rag ingest <results.json>（或 MCP rag_ingest）回灌。',
  });
  ws.logContext(workspace, 'rag', `已排队 ${queries.length} 条检索请求（${purpose}）→ requests.jsonl`);
  return { queued: queries.length, requestId };
}

/** 通路 2：直连检索端点（可选）。约定 POST {endpoint}/search {queries} → {results:[{query,results:[...]}]}。 */
export async function searchOnline(cfg, queries) {
  if (!cfg.ragEndpoint || !cfg.ragApiKey) {
    return { searched: false, hint: '未配置 SCULPTOR_RAG_ENDPOINT/SCULPTOR_RAG_API_KEY——走宿主代检（已写入 requests.jsonl）。' };
  }
  if (!queries?.length) return { searched: false, hint: '没有查询' };
  try {
    const res = await fetch(`${cfg.ragEndpoint}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.ragApiKey}`,
      },
      body: JSON.stringify({ queries }),
    });
    if (!res.ok) throw new Error(`检索端点 ${res.status}`);
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) throw new Error('检索返回空 results');
    return { searched: true, results };
  } catch (err) {
    return { searched: false, hint: `直连检索失败：${String(err.message).slice(0, 120)}` };
  }
}

function readCache(workspace) {
  try {
    const obj = ws.readJson(path.join(workspace, 'vault', CACHE_FILE));
    return Array.isArray(obj.entries) ? obj.entries : [];
  } catch {
    return [];
  }
}

function writeCache(workspace, entries) {
  ws.writeJson(path.join(workspace, 'vault', CACHE_FILE), {
    schemaVersion: '1.0',
    entries: entries.slice(-CACHE_MAX),
  });
}

/** 回灌检索结果：缓存 + 把命中片段作为素材加入 state.materials（限量）。 */
export function ingestSearchResults(workspace, results) {
  if (!Array.isArray(results) || !results.length) throw new Error('results 必须是 [{query, results:[...]}] 数组');
  const entries = readCache(workspace);
  const state = ws.readState(workspace);
  state.materials = state.materials || [];
  let added = 0;
  for (const item of results) {
    const query = String(item.query || '').trim();
    const hits = (item.results || []).slice(0, 5);
    if (!query || !hits.length) continue;
    entries.push({ ts: ws.nowIso(), query, results: hits });
    const text = hits
      .map((h) => `${h.title || ''}（${h.source || h.url || ''}）${h.snippet || ''}`)
      .join('\n');
    state.materials.push(`[检索 ${query}] ${text.slice(0, 1200)}`);
    added += 1;
  }
  writeCache(workspace, entries);
  ws.writeState(workspace, state);
  ws.logContext(workspace, 'rag', `回灌 ${added} 条检索结果 → rag-cache.json + 素材`);
  return { ingested: added, cached: entries.length };
}

/** 检索状态：缓存条数 + 待办请求数 + 配置。 */
export function ragStatus(workspace, cfg = {}) {
  const pending = ws
    .countLines(path.join(workspace, 'protocol', 'requests.jsonl'));
  return {
    cached: readCache(workspace).length,
    pendingRequests: pending,
    direct: Boolean(cfg.ragEndpoint && cfg.ragApiKey),
    endpoint: cfg.ragEndpoint || '',
    cacheFile: path.join(workspace, 'vault', CACHE_FILE),
  };
}
