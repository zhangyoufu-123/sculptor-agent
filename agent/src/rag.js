// 联网 RAG（检索增强）：给事实核查、原创性检查提供"去查证"的通路。
// 两条通路，互不冲突：
//  1) 宿主代检（默认，零网络依赖）：把检索请求写入 protocol/requests.jsonl
//     （status: pending，type: web-search），宿主（Codex/Claude/OpenCode）执行检索后，
//     用 `stylotrace rag ingest <results.json>` 或 MCP `rag_ingest` 回灌；
//  2) 直连检索（可选）：配置 STYLOTRACE_RAG_ENDPOINT + STYLOTRACE_RAG_API_KEY 后，
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

  // ── 多角度查询（吸纳 Deep Research 的"分支搜索/查询编码"思路）────
  // 单一 "topic+片段" 查询只覆盖一个角度；写作场景需要多面素材：
  // 背景现状 / 案例实例 / 数据统计 / 对比差异 / 争议局限 / 最新进展。
  // 确定性模板生成（零 LLM 开销），在事实查询之后按需补齐到 limit。
  if (topic) {
    const angles = [
      `${topic} 背景 现状 发展`,
      `${topic} 案例 实例 应用`,
      `${topic} 数据 统计 报告`,
      `${topic} 对比 区别 优劣 方案`,
      `${topic} 争议 局限 问题 批评`,
      `${topic} 最新 进展 趋势`,
    ];
    for (const q of angles) {
      if (queries.length >= limit) break;
      push(q);
    }
  }
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
      '请用宿主自身的联网搜索能力检索这些查询，把结果整理成 [{query, results:[{title,url,snippet,source}]}] 的 JSON 文件，然后运行: stylotrace rag ingest <results.json>（或 MCP rag_ingest）回灌。',
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

// ── 显式检索请求（"帮我查一查《乡土中国》中…"）────────────────────
// 用户主动要求查证/搜索 → 不再依赖"论文/素材不足"才触发 RAG。
// 通路：已配置 STYLOTRACE_RAG_ENDPOINT 则直连检索并回灌；否则排队宿主代检（requests.jsonl）。
const SEARCH_INTENT_RE =
  /(?<![检审调核复盘排巡考])(查一查|查一下|查查|查一查资料|查一下资料|查查资料|查资料|查证一下|查证|搜一下|搜一搜|搜搜|搜索一下|搜索|检索一下|检索|找一下|找一找|找找|帮我查|帮我搜|帮我找|去查|上网查|找找资料|找一下资料|能不能查|可否查)/;

const SEARCH_PHRASES = [
  '你可以帮我查一查吗', '你能帮我查一查吗', '能不能帮我查一查', '可以帮我查一查吗',
  '帮我查一查', '帮我查一下资料', '帮我查查资料', '帮我查一下', '帮我查查', '帮我查',
  '你帮我查一查', '你帮我查一下', '你帮我查查', '帮我搜一下', '帮我搜搜', '帮我搜',
  '帮我找一下', '帮我找找', '帮我找', '查一查资料', '查一下资料', '查查资料', '查资料',
  '查一查', '查一下', '查查', '查证一下', '查证', '搜一下', '搜一搜', '搜搜', '搜索一下',
  '搜索', '检索一下', '检索', '找一下', '找一找', '找找', '去查一下', '去查查', '去查',
  '上网查', '找找资料', '找一下资料', '能不能查一下', '可否查一下',
];

function buildSearchQuery(input, state = {}) {
  let q = String(input || '');
  for (const p of SEARCH_PHRASES) q = q.split(p).join(' ');
  // 优先保留《书名号》里的实体，作为查询的核心词（v0.58 查询清洗）。
  const book = q.match(/《([^》]{1,30})》/)?.[1] || '';
  q = q.replace(/[《》]/g, ' ');
  q = q
    .replace(/[吗呢吧啊呀。！？，,.]/g, ' ')
    .replace(
      /(我在|我|你|请|麻烦|帮我|帮忙|可以|能不能|记得|有|这个|那个|一些|一个|讲|讲过|说到|说到过|看过|读过|在B站|B站|b站|纪录片|视频|里面|里面说|中说到|中讲过|上|里|的|关于|学术讨论|论述|相关内容|资料|信息|方面|问题)/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (book) q = `${book} ${q}`.trim();
  // 去重相邻同词（书名提取与原文残留可能重复出现）。
  {
    const seen = new Set();
    q = q
      .split(' ')
      .filter((w) => {
        if (!w || seen.has(w)) return false;
        seen.add(w);
        return true;
      })
      .join(' ');
  }
  if (q.length < 6) {
    const topic = String(state?.confirmed?.topic || '').trim();
    q = topic ? `${topic} ${String(input || '').slice(0, 60)}` : String(input || '').slice(0, 60);
  }
  return q.slice(0, 60);
}

/**
 * 处理用户显式检索请求：返回面向用户的提示语；同时把请求排队（宿主代检）
 * 或直连检索回灌（配置了 RAG 端点时），并把命中书目写入个人知识库。
 * 同一条查询去重；结果写入 state.lastSearchQuery 防重复。
 */
export async function explicitSearchSuggestion(cfg, workspace, input, state = {}) {
  const text = String(input || '').trim();
  if (!SEARCH_INTENT_RE.test(text)) return '';
  const query = buildSearchQuery(text, state);
  if (!query) return '';
  if (state.lastSearchQuery === query) {
    return `（「${query.slice(0, 40)}」我刚才已经帮你检索过了——结果回灌后会自动补进素材与知识库；没回灌的话我再催宿主。）`;
  }
  const existing = pendingDataNeeds(workspace);
  const dup = existing.some(
    (p) => p.purpose === 'user-request' && p.queries?.some((q) => q.includes(query.slice(0, 10))),
  );
  if (dup) {
    state.lastSearchQuery = query;
    return `（你让我查的「${query.slice(0, 40)}」已在待办检索队列里——回灌后我会自动用上，并把它记进素材与知识库。）`;
  }
  const online = await searchOnline(cfg, [query]);
  if (online.searched) {
    let kbNote = '';
    try {
      const ingested = ingestAssetResults(workspace, online.results, { purpose: 'user-request' });
      if (ingested.kbAdded) kbNote = `，${ingested.kbAdded} 本书目已入知识库（来源未核实，标低置信）`;
    } catch {}
    state.lastSearchQuery = query;
    const first = online.results?.[0]?.results?.[0];
    if (first) {
      return `（已直连检索「${query.slice(0, 40)}」：${String(first.title || '').slice(0, 60)}${first.snippet ? `——${String(first.snippet).slice(0, 90)}` : ''}。来源未核实，已入素材待你确认${kbNote}。）`;
    }
    return `（已直连检索「${query.slice(0, 40)}」，结果已缓存${kbNote}。）`;
  }
  const queued = requestHostSearch(workspace, [query], { purpose: 'user-request' });
  if (!queued.queued) return '';
  state.lastSearchQuery = query;
  return `（你让我查「${query.slice(0, 40)}」——已排队检索（宿主代检），回灌后会自动补进素材与知识库。你直接贴片段给我也行。）`;
}

/** 通路 2：直连检索端点（可选）。约定 POST {endpoint}/search {queries} → {results:[{query,results:[...]}]}。 */
/**
 * 联网检索（v0.31）：支持三种来源，按配置优先级取用——
 * 1) STYLOTRACE_SEARCH_PROVIDER=tavily + STYLOTRACE_SEARCH_API_KEY（推荐，开箱即用）
 * 2) STYLOTRACE_SEARCH_PROVIDER=serper + STYLOTRACE_SEARCH_API_KEY
 * 3) 自建端点 STYLOTRACE_RAG_ENDPOINT + STYLOTRACE_RAG_API_KEY（POST {queries} → {results:[{query,results:[{title,url,snippet,source}]}]}）
 * 都没配置 → 排队宿主代检（requests.jsonl），不阻塞写作。
 */
async function searchTavily(key, queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: q, max_results: 5, search_depth: 'basic' }),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}`);
    const data = await res.json();
    out.push({
      query: q,
      results: (data.results || []).map((h) => ({
        title: String(h.title || ''),
        url: String(h.url || ''),
        source: String(h.url || ''),
        snippet: String(h.content || ''),
      })),
    });
  }
  if (!out.some((o) => o.results.length)) throw new Error('Tavily 返回空结果');
  return { searched: true, results: out };
}

async function searchSerper(key, queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q, num: 5 }),
    });
    if (!res.ok) throw new Error(`Serper ${res.status}`);
    const data = await res.json();
    out.push({
      query: q,
      results: (data.organic || []).map((h) => ({
        title: String(h.title || ''),
        url: String(h.link || ''),
        source: String(h.link || ''),
        snippet: String(h.snippet || ''),
      })),
    });
  }
  if (!out.some((o) => o.results.length)) throw new Error('Serper 返回空结果');
  return { searched: true, results: out };
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 内置免费检索 A：DuckDuckGo HTML（无需密钥；被限流时由 Wikipedia 兜底）。 */
async function searchDuckDuckGo(queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`DDG ${res.status}`);
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      let url = stripHtml(m[1]);
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) {
        try { url = decodeURIComponent(uddg[1]); } catch {}
      }
      results.push({ title: stripHtml(m[2]), url, source: url, snippet: '' });
    }
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => stripHtml(x[1]));
    results.forEach((r, i) => {
      if (snips[i]) r.snippet = snips[i];
    });
    if (results.length) out.push({ query: q, results });
  }
  if (!out.some((o) => o.results.length)) throw new Error('DDG 返回空结果');
  return { searched: true, results: out };
}

/** 内置免费检索 B：必应中国（中国大陆可达，无需密钥）。 */
async function searchBingCN(queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`Bing ${res.status}`);
    const html = await res.text();
    const results = [];
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const snip = m[3].match(/class="b_lineclamp2"[^>]*>([\s\S]*?)<\/p>/);
      results.push({
        title: stripHtml(m[2]),
        url: String(m[1] || '').split(' ')[0],
        source: 'bing',
        snippet: snip ? stripHtml(snip[1]) : '',
      });
    }
    if (results.length) out.push({ query: q, results });
  }
  if (!out.some((o) => o.results.length)) throw new Error('Bing 返回空结果');
  return { searched: true, results: out };
}

/** 内置免费检索 C：B站视频搜索（中国大陆可达；用于"视频/B站/纪录片"类查询）。 */
async function searchBilibili(queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } },
    );
    if (!res.ok) throw new Error(`Bilibili ${res.status}`);
    const data = await res.json();
    const hits = data?.data?.result || [];
    if (hits.length) {
      out.push({
        query: q,
        results: hits.slice(0, 5).map((h) => ({
          title: stripHtml(String(h.title || '')),
          url: `https://www.bilibili.com/video/${String(h.bvid || h.aid || '')}`,
          source: 'bilibili',
          snippet: stripHtml(String(h.description || h.author || '')).slice(0, 200),
        })),
      });
    }
  }
  if (!out.some((o) => o.results.length)) throw new Error('B站返回空结果');
  return { searched: true, results: out };
}

/** 内置免费检索 D：百度（中国大陆可达；跟随重定向 + 宽松解析）。 */
async function searchBaidu(queries) {
  const out = [];
  for (const q of queries.slice(0, 2)) {
    const res = await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&ie=utf-8`, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`Baidu ${res.status}`);
    const html = await res.text();
    const results = [];
    const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const title = stripHtml(m[2]);
      if (!title || title.length < 4) continue;
      results.push({ title, url: String(m[1] || '').split(' ')[0], source: 'baidu', snippet: '' });
    }
    if (results.length) out.push({ query: q, results });
  }
  if (!out.some((o) => o.results.length)) throw new Error('Baidu 返回空结果');
  return { searched: true, results: out };
}

/** 内置免费检索 B：中文维基百科 API（无需密钥，适合书/理论/事件查证）。 */
async function searchWikipedia(queries) {
  const out = [];
  for (const q of queries.slice(0, 3)) {
    const url = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&origin=*&srlimit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Wiki ${res.status}`);
    const data = await res.json();
    const hits = data?.query?.search || [];
    if (hits.length) {
      out.push({
        query: q,
        results: hits.map((h) => ({
          title: String(h.title || ''),
          url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(h.title || '').replace(/ /g, '_'))}`,
          source: 'wikipedia',
          snippet: stripHtml(String(h.snippet || '')),
        })),
      });
    }
  }
  if (!out.some((o) => o.results.length)) throw new Error('Wiki 返回空结果');
  return { searched: true, results: out };
}

export async function searchOnline(cfg, queries) {
  if (!queries?.length) return { searched: false, hint: '没有查询' };
  const provider = String(cfg.searchProvider || '').toLowerCase();
  const key = cfg.searchApiKey || cfg.ragApiKey || '';
  try {
    if (provider === 'tavily' && key) return await searchTavily(key, queries);
    if (provider === 'serper' && key) return await searchSerper(key, queries);
    if (['ddg', 'duckduckgo'].includes(provider)) return await searchDuckDuckGo(queries);
    if (provider === 'wikipedia') return await searchWikipedia(queries);
    if (provider === 'bing') return await searchBingCN(queries);
    if (provider === 'bilibili') return await searchBilibili(queries);
    if (provider === 'baidu') return await searchBaidu(queries);
    if (cfg.ragEndpoint && cfg.ragApiKey) {
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
    }
    // 内置检索（v0.58）：无需密钥。链路按"中国大陆可达性"排序：
    // 视频类查询 → B站；否则必应中国 → 百度 → DDG → 维基（海外环境也能用）。
    if (provider === 'builtin') {
      const firstQ = String(queries[0] || '');
      if (/视频|B站|b站|纪录片|up主|弹幕|番剧|观影/.test(firstQ)) {
        try {
          return await searchBilibili(queries);
        } catch {}
      }
      try {
        return await searchBingCN(queries);
      } catch {}
      try {
        return await searchBaidu(queries);
      } catch {}
      try {
        return await searchDuckDuckGo(queries);
      } catch {
        try {
          return await searchWikipedia(queries);
        } catch {}
      }
      return {
        searched: false,
        hint: '内置检索暂不可达（网络受限）——可以直接粘贴资料片段给我回灌',
      };
    }
    return {
      searched: false,
      hint: '未配置检索（STYLOTRACE_SEARCH_PROVIDER+KEY 或 STYLOTRACE_RAG_ENDPOINT）——走宿主代检（已写入 requests.jsonl），也可手动粘贴资料回灌。',
    };
  } catch (err) {
    return { searched: false, hint: `联网检索失败：${String(err.message).slice(0, 120)}` };
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
            confidence: 0.5, // 网络来源未核实：低置信度，用户确认后再提升
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
  return `（联网搜到一本与你主题相关的作品：《${title.replace(/^《|》$/g, '')}》${first.source ? `（${first.source}）` : ''}${first.snippet ? `——${String(first.snippet).slice(0, 80)}` : ''}。来源未核实，需要我记进知识库并标注待核实吗？）`;
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
      out.push(`（联网资料·待核实）${title}${h.source ? `（${h.source}）` : ''}${h.snippet ? `：${String(h.snippet).slice(0, 60)}` : ''}`);
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
  const provider = String(cfg.searchProvider || '').toLowerCase();
  const direct =
    Boolean(cfg.ragEndpoint && cfg.ragApiKey) ||
    Boolean(provider && (cfg.searchApiKey || cfg.ragApiKey));
  return {
    cached: readCache(workspace).length,
    pendingRequests: pending,
    direct,
    provider: provider || (cfg.ragEndpoint ? 'custom' : ''),
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
 * 写入工作区 references.md。结构化条目仍需用户核对（stylotrace citations 可追加/校对）。
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
    '## 参考文献（草稿：来自检索回灌来源，请用 stylotrace citations 校对格式）\n\n' +
    formatReferences(refs, style)
      .map((l) => `${l}\n`)
      .join('') +
    '\n';
  const file = path.join(workspace, 'references.md');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, refs: refs.length };
}
