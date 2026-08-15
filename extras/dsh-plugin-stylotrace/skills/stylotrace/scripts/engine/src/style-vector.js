// 四层复合风格向量（v0.17 核心升级）
//
// L1 连续向量（StyleVector）：作者语料 vs 基线语料的 embedding 方向差，EMA 增量更新。
//    默认用"字符二元组稀疏向量"（零依赖、可解释、可余弦）；配置 STYLOTRACE_EMBED_* 后可升级
//    为真实 embedding API（OpenAI 兼容 /embeddings），同一套 EMA 逻辑。
// L2 动态稀疏维度：基础 14+7 轴（write/read 高置信维度）+ 意象子维（联想库/attentionFocus）
//    + 偏好轴（修改意图归类）+ 素材维（信号文本里的重复实词）。权重 × 新鲜度衰减，限量注入。
// L3 困惑度签名：人类文本的 surprisal（少见二元组占比 + 低重复率 + 句长方差）显著高于 AI 平滑文本。
//    确定性代理指标开箱即用；配置 STYLOTRACE_PERPLEXITY_ENDPOINT 可换真实 perplexity API。
// L4 偏好对：每次 point-edit / 修改建议 = (原文, 改后, 意图) 对比信号——最高权重风格证据，
//    落 vault/edits.jsonl，并同步更新偏好轴与连续向量。
//
// 设计依据：StyleVector(ACL 2025) 的方向差表示；Generative Agents 的 recency+importance+relevance；
// StyleMC 的对比式正/反例；"人类文本困惑度高于 AI"的实证结论。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ws from './workspace.js';
import { embedText } from './embedding.js';

const VECTOR_FILE = 'style-vector.json';
const DEFAULT_EMA = 0.75; // 新信号占比 (1-alpha)；越大越稳、越小越跟手
const TOP_GRAMS = 300; // 稀疏向量保留的最大维度（防 JSON 膨胀）
const FRESH_HALF_DAYS = 120; // 动态维度新鲜度半衰期
const DIM_LIMIT = 8; // 注入提示词时动态维度上限
const MIN_TEXT_FOR_SIGNATURE = 20; // 困惑度签名最短文本

// AI 平滑文本的高频连接/框架二元组：密度越高，文本越"顺"、越可预测，surprisal 越低。
const AI_CONNECTIVES = new Set([
  '值得', '随着', '不难', '发现', '注意', '我们', '他们', '你们', '同时', '此外',
  '然而', '但是', '而且', '因此', '所以', '总之', '综上', '可见', '由此', '其实',
  '首先', '其次', '最后', '不仅', '更是', '所谓', '本质', '层面', '维度', '一定',
  '必然', '无疑', '显然', '更多', '更加', '进一步', '通过', '从而', '进而', '对于',
  '关于', '作为', '如果', '那么', '这样', '那样', '这些', '那些', '一般', '往往',
]);

const INTENT_AXES = [
  { re: /克制|收敛|冷静|内敛|不煽情|少抒情|别太抒情/, key: '克制收敛' },
  { re: /豪迈|激昂|澎湃|气势|磅礴|大气/, key: '豪迈有气势' },
  { re: /口语|自然|生活化|亲切|接地气|像聊天/, key: '口语化' },
  { re: /简洁|精炼|利落|啰嗦|冗长|拖沓|短一点/, key: '简洁精炼' },
  { re: /细节|画面|具体|场景|画面感/, key: '具体细节' },
  { re: /文艺|诗意|意象|唯美|抒情/, key: '文艺意象' },
  { re: /留白|含蓄|余味|收束|结尾/, key: '留白收束' },
  { re: /幽默|轻松|活泼|俏皮/, key: '轻松幽默' },
  { re: /理性|客观|分析|克制情绪/, key: '理性克制' },
  { re: /ai|机器|模板|套话/, key: '反 AI 痕迹' },
];

const MATERIAL_STOP = new Set([
  '我们', '他们', '你们', '这个', '那个', '什么', '一个', '没有', '自己', '就是',
  '因为', '所以', '但是', '还是', '可以', '已经', '这样', '那样', '时候', '现在',
  '然后', '知道', '觉得', '真的', '起来', '出来', '这样', '那样', '有点', '一些',
  '东西', '事情', '感觉', '开始', '最后', '最后', '第一', '第二', '不是', '只是',
]);

// ── L1 稀疏嵌入（字符二元组，兼容中英混排）──────────────────────

export function tokenize(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[\s\d]+/g, '')
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z]/g, '');
  const grams = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.push(g);
  }
  return grams;
}

/** 稀疏向量：gram → 出现次数（Map）。 */
export function embedSparse(text) {
  const out = new Map();
  for (const g of tokenize(text)) out.set(g, (out.get(g) || 0) + 1);
  return out;
}

function l2(map) {
  let s = 0;
  for (const v of map.values()) s += v * v;
  return Math.sqrt(s) || 1;
}

export function cosineSparse(a, b) {
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const v2 = large.get(k);
    if (v2) dot += v * v2;
  }
  return dot / (l2(a) * l2(b));
}

export function cosineDense(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** EMA 合并两个稀疏向量（old 为 Map，sig 为 Map）。 */
function emaSparse(oldMap, sigMap, alpha) {
  const out = new Map();
  const keys = new Set([...oldMap.keys(), ...sigMap.keys()]);
  for (const k of keys) {
    const v = alpha * (oldMap.get(k) || 0) + (1 - alpha) * (sigMap.get(k) || 0);
    if (v !== 0) out.set(k, v);
  }
  if (out.size > TOP_GRAMS) {
    const top = [...out.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, TOP_GRAMS);
    out.clear();
    for (const [k, v] of top) out.set(k, v);
  }
  return out;
}

function objectToMap(obj) {
  return new Map(Object.entries(obj || {}).map(([k, v]) => [k, Number(v) || 0]));
}

function mapToObject(map, top = TOP_GRAMS) {
  const entries = [...map.entries()]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, top);
  return Object.fromEntries(entries.map(([k, v]) => [k, Number(v.toFixed(6))]));
}

// ── vault/style-vector.json 读写 ─────────────────────────────

export function templateVector() {
  return {
    schemaVersion: '0.1',
    continuous: {
      mode: 'sparse',
      sparse: {},
      dense: null,
      baseline: null,
      direction: {},
      alpha: DEFAULT_EMA,
      embedModel: '',
      updatedAt: null,
    },
    dynamic: { base: {}, imagery: {}, preference: {}, material: {} },
    preferencePairs: [],
    perplexity: { proxy: true, samples: 0, min: null, mean: null, max: null },
    learnedFrom: { signals: 0, clarify: 0, conversation: 0, outline: 0, write: 0, transform: 0, edit: 0, correction: 0, direction: 0, manual: 0 },
    lastUpdated: null,
  };
}

function readJsonSafe(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function vectorFile(workspace) {
  return path.join(workspace, 'vault', VECTOR_FILE);
}

export function readVector(workspace) {
  const obj = readJsonSafe(vectorFile(workspace));
  if (!obj) {
    const fresh = templateVector();
    try {
      ws.writeJson(vectorFile(workspace), fresh);
    } catch {
      // 工作区未初始化时只返回内存模板，不落盘
    }
    return fresh;
  }
  const base = templateVector();
  return { ...base, ...obj, continuous: { ...base.continuous, ...(obj.continuous || {}) } };
}

export function writeVector(workspace, obj) {
  ws.writeJson(vectorFile(workspace), obj);
}

// ── L3 困惑度签名（确定性代理）───────────────────────────────

export function perplexityProxy(text) {
  const grams = tokenize(text);
  const n = grams.length;
  if (n < 4) return null;
  const counts = new Map();
  for (const g of grams) counts.set(g, (counts.get(g) || 0) + 1);
  const unique = counts.size;
  const rare = [...counts.values()].filter((c) => c === 1).length;
  const repeatRate = 1 - unique / n;
  const rareRate = rare / n;
  const aiRate = grams.filter((g) => AI_CONNECTIVES.has(g)).length / n;
  const lens = String(text)
    .split(/[。！？.!?]+/)
    .map((s) => [...s.trim()].length)
    .filter((l) => l > 0);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
    : 0;
  const sentVarNorm = mean > 0 ? Math.min(1, sd / mean) : 0;
  // 人类文本：内容二元组更"稀"（rareRate 高）、句式长短错落（sentVarNorm 高）、
  // 连接框架密度低（aiRate 低）→ surprisal 高。AI 平滑文本相反。
  const surprisal = 0.5 * rareRate + 0.3 * sentVarNorm + 0.2 * (1 - aiRate);
  const perplexity = Number((2 + surprisal * 6).toFixed(2));
  return {
    perplexity,
    surprisal: Number(surprisal.toFixed(4)),
    metrics: {
      rareRate: Number(rareRate.toFixed(4)),
      repeatRate: Number(repeatRate.toFixed(4)),
      sentVarNorm: Number(sentVarNorm.toFixed(4)),
      aiConnectiveRate: Number(aiRate.toFixed(4)),
      unique,
      total: n,
    },
  };
}

/** 可选真实 perplexity 端点：POST {text} → {perplexity}。失败静默回退代理。 */
async function perplexityOf(cfg, text) {
  const ep = String(cfg.perplexityEndpoint || '').trim();
  if (!ep) return null;
  try {
    const res = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const p = Number(j?.perplexity);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// ── L2 动态维度派生 ─────────────────────────────────────────

function classifyIntent(intent) {
  const i = String(intent || '');
  for (const rule of INTENT_AXES) {
    if (rule.re.test(i)) return rule.key;
  }
  return i ? `偏好·${i.slice(0, 12)}` : '';
}

function materialWords(text) {
  const counts = new Map();
  for (const w of String(text || '').match(/[\u4e00-\u9fff]{2,4}/g) || []) {
    if (MATERIAL_STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c]) => ({ word: w, count: c }));
}

function bumpDim(v, group, key, delta, evidence = '') {
  v.dynamic = v.dynamic || {};
  v.dynamic[group] = v.dynamic[group] || {};
  const dim = v.dynamic[group][key] || { w: 0, count: 0, lastTs: null, evidence: [] };
  dim.w = Math.min(1, dim.w + delta);
  dim.count += 1;
  dim.lastTs = ws.nowIso();
  dim.evidence = dim.evidence || [];
  if (evidence && !dim.evidence.includes(evidence)) {
    dim.evidence.push(String(evidence).slice(0, 60));
    if (dim.evidence.length > 5) dim.evidence = dim.evidence.slice(-5);
  }
  v.dynamic[group][key] = dim;
}

/** 从 write-style 高置信维度刷新 base 动态维。 */
function syncBaseDims(v, workspace) {
  const write = readJsonSafe(path.join(workspace, 'vault', 'write-style.json'));
  if (!write) return;
  for (const [k, d] of Object.entries(write.dimensions || {})) {
    if (d && (d.confidence || 0) >= 0.5 && d.value) {
      bumpDim(v, 'base', `${k}·${d.value}`, 0.16, `置信 ${(d.confidence * 100).toFixed(0)}%`);
    }
  }
  const vec = write.vector || {};
  const assoc = vec.personalDataset?.topAssociations || [];
  for (const a of assoc.slice(0, 8)) bumpDim(v, 'imagery', String(a).slice(0, 16), 0.18, '联想库');
  for (const [obj, w] of Object.entries(vec.attentionFocus || {})) {
    bumpDim(v, 'imagery', String(obj).slice(0, 16), Math.min(0.25, Number(w) || 0.1), '注意力焦点');
  }
}

/** 从 edits.jsonl 刷新偏好轴（与 L4 同源，落盘后重算）。 */
function syncPreferenceAxes(v, workspace) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(workspace, 'vault', 'edits.jsonl'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  const seen = new Map();
  for (const line of lines.slice(-60)) {
    try {
      const e = JSON.parse(line);
      const axis = classifyIntent(e.intent);
      if (!axis) continue;
      seen.set(axis, (seen.get(axis) || 0) + 1);
    } catch {
      // 坏行跳过
    }
  }
  for (const [axis, count] of seen) bumpDim(v, 'preference', axis, Math.min(0.3, 0.12 * count), '亲手修改');
}

function pruneDynamic(v) {
  const now = Date.now();
  for (const group of Object.keys(v.dynamic || {})) {
    for (const [key, dim] of Object.entries(v.dynamic[group] || {})) {
      const ageDays = dim.lastTs ? (now - new Date(dim.lastTs).getTime()) / 86400000 : 0;
      const eff = (dim.w || 0) * Math.exp(-Math.max(0, ageDays) / FRESH_HALF_DAYS);
      if (eff < 0.05) delete v.dynamic[group][key];
    }
  }
}

/** 排序后的实时动态维度（权重 × 新鲜度衰减）。 */
export function topDynamicDims(v, limit = DIM_LIMIT) {
  const out = [];
  const now = Date.now();
  for (const [group, dims] of Object.entries(v?.dynamic || {})) {
    for (const [key, d] of Object.entries(dims || {})) {
      if (!d || !(d.w || 0)) continue;
      const ageDays = d.lastTs ? (now - new Date(d.lastTs).getTime()) / 86400000 : 0;
      const eff = (d.w || 0) * Math.exp(-Math.max(0, ageDays) / FRESH_HALF_DAYS);
      if (eff >= 0.05) {
        out.push({
          label: `${group === 'base' ? '轴' : group === 'imagery' ? '意象' : group === 'preference' ? '偏好' : '素材'}·${key}`,
          weight: Number(eff.toFixed(2)),
          group,
          key,
          count: d.count || 0,
          evidence: (d.evidence || []).slice(-1)[0] || '',
        });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

// ── 主刷新入口：每轮澄清/大纲/写作/修改后调用 ───────────────────

/**
 * 全链路实时刷新四层复合风格向量。
 * @param cfg    loadConfig() 结果（可缺省，纯稀疏/代理模式）
 * @param workspace 工作区
 * @param opts  { text, kind, edit: {original, changed, intent}, evidence }
 */
export async function refreshStyleVector(cfg = {}, workspace, { text = '', kind = 'clarify', edit = null, evidence = '' } = {}) {
  const v = readVector(workspace);
  const alpha = Number(cfg.styleEma) || Number(v.continuous?.alpha) || DEFAULT_EMA;
  v.continuous.alpha = alpha;
  const t = String(text || '').trim();

  // L1 连续向量：EMA 增量更新（dense 优先，失败降级稀疏）
  if (t) {
    if (cfg.embedBaseUrl && cfg.embedApiKey && cfg.embedModel) {
      const dense = await embedText(cfg, t);
      if (dense) {
        const old = v.continuous.dense;
        v.continuous.dense = old && old.length === dense.length
          ? old.map((x, i) => alpha * x + (1 - alpha) * dense[i])
          : Array.from(dense);
        v.continuous.mode = 'dense';
        v.continuous.embedModel = String(cfg.embedModel);
      } else {
        v.continuous.sparse = mapToObject(emaSparse(objectToMap(v.continuous.sparse), embedSparse(t), alpha));
        v.continuous.mode = 'sparse';
      }
    } else {
      v.continuous.sparse = mapToObject(emaSparse(objectToMap(v.continuous.sparse), embedSparse(t), alpha));
      v.continuous.mode = 'sparse';
    }
    v.continuous.updatedAt = ws.nowIso();
    // 基线语料（可选）：作者向量 − 基线向量 = 风格偏离方向
    if (cfg.baselineText && !v.continuous.baseline && fs.existsSync(cfg.baselineText)) {
      try {
        const bt = fs.readFileSync(cfg.baselineText, 'utf8');
        v.continuous.baseline = mapToObject(emaSparse(new Map(), embedSparse(bt), 0.5));
      } catch {
        // 基线读取失败不影响
      }
    }
  }

  // L4 偏好对：最高权重信号，落 preferencePairs（edits.jsonl 由调用方已落）
  if (edit && (edit.changed || edit.original)) {
    v.preferencePairs = v.preferencePairs || [];
    v.preferencePairs.push({
      original: String(edit.original || '').slice(0, 500),
      changed: String(edit.changed || '').slice(0, 500),
      intent: String(edit.intent || '').slice(0, 200),
      ts: ws.nowIso(),
    });
    if (v.preferencePairs.length > 50) v.preferencePairs = v.preferencePairs.slice(-50);
    const axis = classifyIntent(edit.intent);
    if (axis) bumpDim(v, 'preference', axis, 0.2, edit.intent || '亲手修改');
  }

  // L2 动态维度：base/imagery 从档案同步，material 从信号文本衍生，preference 从编辑重算
  syncBaseDims(v, workspace);
  syncPreferenceAxes(v, workspace);
  for (const m of materialWords(t || edit?.changed || '')) {
    bumpDim(v, 'material', m.word, Math.min(0.3, 0.1 * m.count), `重复素材「${m.word}」`);
  }
  pruneDynamic(v);

  // L3 困惑度签名：作者文本采样累计 min/mean/max
  const sigText = t.length >= MIN_TEXT_FOR_SIGNATURE ? t : edit?.changed || '';
  let pp = perplexityProxy(sigText);
  if (cfg.perplexityEndpoint && sigText) {
    const real = await perplexityOf(cfg, sigText);
    if (real) pp = { perplexity: real, surprisal: null, real: true };
  }
  if (pp && sigText.length >= MIN_TEXT_FOR_SIGNATURE) {
    const p = v.perplexity || { proxy: true, samples: 0, min: null, mean: null, max: null };
    p.samples = (p.samples || 0) + 1;
    const val = pp.perplexity;
    p.min = p.min === null ? val : Math.min(p.min, val);
    p.max = p.max === null ? val : Math.max(p.max, val);
    p.mean = p.mean === null ? val : p.mean + (val - p.mean) / p.samples;
    if (pp.real) p.proxy = false;
    v.perplexity = p;
  }

  v.learnedFrom = v.learnedFrom || {};
  v.learnedFrom.signals = (v.learnedFrom.signals || 0) + 1;
  v.learnedFrom[kind] = (v.learnedFrom[kind] || 0) + 1;
  v.lastUpdated = ws.nowIso();
  writeVector(workspace, v);

  return {
    updated: true,
    mode: v.continuous.mode,
    dynamic: topDynamicDims(v, 50).length,
    samples: v.perplexity?.samples || 0,
    kind,
  };
}

// ── 摘要（CLI / 压缩守卫 / 注入）─────────────────────────────

export function vectorSummary(workspace) {
  const v = readVector(workspace);
  const dirs = topDynamicDims(v, 12);
  const sparse = objectToMap(v.continuous?.sparse);
  let directionTop = [];
  if (sparse.size) {
    const baseline = objectToMap(v.continuous?.baseline);
    const diff = new Map();
    const keys = new Set([...sparse.keys(), ...baseline.keys()]);
    for (const k of keys) {
      const d = (sparse.get(k) || 0) - (baseline.get(k) || 0);
      if (d !== 0) diff.set(k, d);
    }
    directionTop = [...diff.entries()]
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6)
      .map(([k, v2]) => ({ gram: k, v: Number(v2.toFixed(4)) }));
  }
  return {
    mode: v.continuous?.mode || 'sparse',
    embedModel: v.continuous?.embedModel || '',
    signals: v.learnedFrom?.signals || 0,
    byKind: v.learnedFrom || {},
    topDims: dirs,
    directionTop,
    perplexity: v.perplexity || { proxy: true, samples: 0 },
    preferencePairs: (v.preferencePairs || []).length,
    lastUpdated: v.lastUpdated,
  };
}

export function renderVectorSummary(s) {
  const lines = [];
  lines.push(
    `风格向量：${s.mode === 'dense' ? `真实 embedding（${s.embedModel}）` : '稀疏字符二元组'} · 累计信号 ${s.signals} 次 · 偏好对 ${s.preferencePairs} 条`,
  );
  if (s.topDims.length) {
    lines.push('实时动态维度（权重 × 新鲜度）:');
    for (const d of s.topDims) {
      lines.push(`  · ${d.label}（权重 ${d.weight}${d.evidence ? '，' + d.evidence : ''}）`);
    }
  } else {
    lines.push('实时动态维度: （尚无——澄清/大纲/写作/修改时会自动累积）');
  }
  if (s.directionTop.length) {
    lines.push(
      `偏离方向（相对基线的作者高频二元组）: ${s.directionTop.map((d) => `${d.gram}${d.v > 0 ? '+' : '−'}`).join(' ')}`,
    );
  }
  const pp = s.perplexity;
  lines.push(
    pp.samples
      ? `困惑度签名: ${pp.samples} 次采样 · 均值 ${Number(pp.mean).toFixed(2)} · 峰值 ${Number(pp.max).toFixed(2)}（${pp.real ? '真实端点' : '确定性代理'}）`
      : '困惑度签名: 尚未采样（写作后会累计）',
  );
  lines.push(`最后刷新: ${s.lastUpdated || '—'}`);
  return lines.join('\n');
}
