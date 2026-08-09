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

/** 待办检索请求（status=pending，尚未回灌）。 */
export function pendingDataNeeds(workspace) {
  try {
    return fs
      .readFileSync(path.join(workspace, 'protocol', 'requests.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && r.type === 'web-search' && r.status === 'pending')
      .map((r) => ({
        requestId: r.requestId,
        purpose: r.purpose,
        queries: r.queries,
        ts: r.ts,
      }));
  } catch {
    return [];
  }
}

/**
 * 素材缺口（按文体）：论文/报告/新闻稿必须有可查证的文献、数据或来源。
 * 缺口存在 → 返回需要补什么；已有可查证素材 → 不需要。
 */
export function dataGap(state) {
  const g = String(state?.confirmed?.genre || '');
  const needsData = /学术论文|报告|新闻稿/.test(g);
  if (!needsData) return { needed: false, missing: [] };
  const materials = state?.materials || [];
  const verifiable = materials.some((m) =>
    /[0-9０-９]|《|来源|数据|研究|文献|调查|报告|发表|统计|https?:/.test(String(m)),
  );
  if (verifiable) return { needed: false, missing: [] };
  return { needed: true, missing: ['可查证的文献/数据/来源（数字、引文、报告、链接）'] };
}

/**
 * 澄清中的"实时取数"提议：题材需要数据且素材不足 → 自动排队一次检索请求
 * （宿主代检，非阻塞、可拒绝；已有 pending 同款请求则不重复排队）。
 */
export function dataSuggestion(state, workspace, { sessionAsked = false } = {}) {
  if (sessionAsked) return '';
  const gap = dataGap(state);
  if (!gap.needed) return '';
  const topic = String(state.confirmed?.topic || '').trim();
  const queries = topic
    ? [`${topic} 文献 数据 研究现状`, topic]
    : ['研究文献 数据'];
  const existing = pendingDataNeeds(workspace);
  const dup = existing.some(
    (p) => p.purpose === 'clarify-data' && p.queries?.some((q) => q.includes(topic.slice(0, 8))),
  );
  if (!dup) requestHostSearch(workspace, queries, { purpose: 'clarify-data' });
  const g = state.confirmed?.genre || '论文';
  return (
    `（这篇${g}需要可查证的资料支撑。我已自动排队检索「${queries[0]}」的文献与数据——` +
    '宿主/协作 agent 检索后回灌，我会把结果补进素材再继续；你直接给我文献、数据或链接也行。）'
  );
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
  // 回灌完成 → 待办检索标记 done（重写 requests.jsonl，保留历史）
  try {
    const reqFile = path.join(workspace, 'protocol', 'requests.jsonl');
    const lines = fs.readFileSync(reqFile, 'utf8').split('\n').filter(Boolean);
    const next = lines.map((l) => {
      try {
        const r = JSON.parse(l);
        return r.type === 'web-search' && r.status === 'pending'
          ? JSON.stringify({ ...r, status: 'done', doneAt: ws.nowIso() })
          : l;
      } catch {
        return l;
      }
    });
    fs.writeFileSync(reqFile, next.join('\n') + '\n');
  } catch {}
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

/** 从写作文本解析"素材不足"标注（EXPAND_PROMPT 约定：【素材不足：还需要××】）。 */
export function parseDataNeed(text) {
  const out = [];
  const re = /【素材不足[:：]?\s*([^】]{2,60})】/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const v = m[1].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
