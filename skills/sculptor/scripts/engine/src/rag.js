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
import { extractCitations, formatReferences } from './citation.js';
import { knowledgeBrief, addEntry, normTitle } from './knowledge.js';
import { assetBrief } from './asset.js';

const CACHE_FILE = 'rag-cache.json';
const ASSET_CACHE_FILE = 'asset-cache.json';
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

/** 检索缓存里的高价值来源（按查询二元组命中，限量）。 */
function cacheBrief(workspace, query, limit = 2) {
  const entries = readCache(workspace);
  if (!entries.length) return '';
  const clean = String(query || '').toLowerCase().replace(/[\s\d]+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
  }
  const scored = [];
  for (const e of entries) {
    const text = `${e.query} ${(e.results || []).map((h) => `${h.title || ''}${h.source || ''}`).join(' ')}`;
    let score = 0;
    for (const g of grams) if (text.includes(g)) score += 1;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, limit)
    .map(({ e }) => {
      const first = (e.results || [])[0];
      return `- ${first?.title || e.query}${first?.source ? `（${first.source}）` : ''}`;
    })
    .join('\n');
}

/**
 * 统一素材注入（v0.21）：一套体系、数据互通——
 * 个人知识库（读过/经历）+ 检索回灌来源（文献/数据）+ 内置写作资产（文法/诗词/论证骨架）。
 * 限量、轮换，只作辅助参考；个人写作库的文体蒸馏由 outline/write 单独注入，避免重复。
 */
export function unifiedBrief(workspace, query, { limit = 4 } = {}) {
  const parts = [];
  const kb = knowledgeBrief(workspace, query);
  if (kb) parts.push(`【你读过的/经历的（个人知识库，轮换使用）】\n${kb}`);
  const assets = webAssetBrief(workspace, query, { limit: 3 });
  if (assets.length) parts.push(`【写作资产（文法/诗词/论证骨架，按主题选取）】\n- ${assets.join('\n- ')}`);
  const cache = cacheBrief(workspace, query);
  if (cache) parts.push(`【检索回灌来源】\n${cache}`);
  return parts.slice(0, limit).join('\n\n');
}

// ── 内置库 RAG 化（v0.22）：联网检索优先，内置 JSON 只做离线兜底 ──────────
function readAssetCache(workspace) {
  try {
    const obj = ws.readJson(path.join(workspace, 'vault', ASSET_CACHE_FILE));
    return Array.isArray(obj.entries) ? obj.entries : [];
  } catch {
    return [];
  }
}

function writeAssetCache(workspace, entries) {
  ws.writeJson(path.join(workspace, 'vault', ASSET_CACHE_FILE), {
    schemaVersion: '1.0',
    entries: entries.slice(-CACHE_MAX),
  });
}

/**
 * 联网资产/思想检索排队（非阻塞、去重）：
 * 内置库命中不足时自动请求宿主代检（purpose: asset-search / thought-search）。
 */
export function queueAssetSearch(workspace, query, { purpose = 'asset-search' } = {}) {
  const q = String(query || '').trim();
  if (q.length < 4) return { queued: 0 };
  const existing = pendingDataNeeds(workspace);
  const dup = existing.some(
    (p) => p.purpose === purpose && p.queries?.some((x) => x.includes(q.slice(0, 8))),
  );
  if (dup) return { queued: 0 };
  return requestHostSearch(workspace, [q], { purpose });
}

/**
 * 回灌联网资产/思想结果：写 asset-cache.json；
 * 识别结果标题里的《书名》→ 一并收入个人知识库（数据互通，source: web-rag）。
 */
export function ingestAssetResults(workspace, results, { intoKb = true, purpose = 'asset-search' } = {}) {
  if (!Array.isArray(results) || !results.length) throw new Error('results 必须是数组');
  const entries = readAssetCache(workspace);
  const state = ws.readState(workspace);
  let added = 0;
  let kbAdded = 0;
  for (const item of results) {
    const query = String(item.query || '').trim();
    const hits = (item.results || []).slice(0, 6);
    if (!query || !hits.length) continue;
    entries.push({ ts: ws.nowIso(), query, purpose, results: hits });
    added += 1;
    if (intoKb) {
      for (const h of hits) {
        const m = String(h.title || '').match(/《([^》]{1,30})》/);
        const title = m ? m[1] : '';
        if (!title) continue;
        try {
          const r = addEntry(workspace, {
            title: `《${title}》`,
            type: 'book',
            note: `${h.snippet || h.summary || ''}`.slice(0, 200),
            source: 'web-rag',
            relatedTo: [query.slice(0, 20)],
          });
          if (r.created) kbAdded += 1;
        } catch {}
      }
    }
  }
  writeAssetCache(workspace, entries);
  ws.logContext(workspace, 'asset-rag', `回灌 ${added} 组联网资产${kbAdded ? `，${kbAdded} 本书目入知识库` : ''}`);
  return { ingested: added, kbAdded, cached: entries.length };
}

/** 联网荐书：从 thought-search 缓存里找与主题相近的作品，返回推荐语（无则空）。 */
export function webRecommendation(workspace, topic) {
  const clean = String(topic || '').toLowerCase().replace(/[\s\d]+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
  }
  let best = null;
  let bestScore = 0;
  for (const e of readAssetCache(workspace)) {
    if (e.purpose !== 'thought-search') continue;
    const text = `${e.query} ${(e.results || []).map((h) => `${h.title || ''} ${h.snippet || ''}`).join(' ')}`;
    let score = 0;
    for (const g of grams) if (text.includes(g)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (!best || !bestScore) return '';
  const first = (best.results || [])[0];
  if (!first) return '';
  const title = String(first.title || '').trim();
  return `（联网搜到一本与你主题相关的作品：《${title.replace(/^《|》$/g, '')}》${first.source ? `（${first.source}）` : ''}${first.snippet ? `——${String(first.snippet).slice(0, 80)}` : ''}。需要我把它记进你的知识库吗？）`;
}

/** 联网资产缓存匹配（二元组），命中不足时退回内置库（离线兜底）。 */
export function webAssetBrief(workspace, query, { limit = 3 } = {}) {
  const clean = String(query || '').toLowerCase().replace(/[\s\d]+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
  }
  const scored = [];
  for (const e of readAssetCache(workspace)) {
    const text = `${e.query} ${(e.results || []).map((h) => `${h.title || ''}${h.snippet || ''}`).join(' ')}`;
    let score = 0;
    for (const g of grams) if (text.includes(g)) score += 1;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const { e } of scored) {
    for (const h of e.results || []) {
      if (out.length >= limit) break;
      const title = String(h.title || '').trim();
      if (!title) continue;
      out.push(`（联网资料）${title}${h.source ? `（${h.source}）` : ''}${h.snippet ? `：${String(h.snippet).slice(0, 60)}` : ''}`);
    }
    if (out.length >= limit) break;
  }
  if (out.length) return out;
  return assetBrief(query, { limit }); // 离线兜底：确定性内置库
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
  state.ragIngestedAt = ws.nowIso(); // 供"回灌后自动重写缺口节"判断时序
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

/**
 * 自动参考文献草稿：从检索缓存（rag-cache.json）的来源生成 web 条目（GB/T 7714 / APA），
 * 写入工作区 references.md。结构化条目仍需用户核对（sculptor citations 可追加/校对）。
 */
export function autoReferences(workspace, { style = 'gbt7714' } = {}) {
  const entries = readCache(workspace);
  const refs = [];
  for (const e of entries) {
    for (const h of e.results || []) {
      const title = String(h.title || '').trim();
      if (!title || refs.some((r) => r.title === title)) continue;
      refs.push({
        type: 'web',
        title,
        site: String(h.source || '').trim(),
        url: String(h.url || '').trim(),
        year: h.year ? Number(h.year) : undefined,
        accessDate: new Date().toISOString().slice(0, 10),
      });
    }
  }
  if (!refs.length) return { file: '', refs: [] };
  const text =
    '## 参考文献（草稿：来自检索回灌来源，请用 sculptor citations 校对格式）\n\n' +
    formatReferences(refs, style)
      .map((l) => `${l}\n`)
      .join('') +
    '\n';
  const file = path.join(workspace, 'references.md');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, refs: refs.length };
}
