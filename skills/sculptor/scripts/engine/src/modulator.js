// 外层调制器（Outer Modulator · v0.64）
//
// 路线：未来个性化 AI 不是"每个用户微调一个大模型"，而是"每个用户一个轻量的
// 外层调制器，在推理时实时调制通用模型的行为"。本模块把这条路线落地为
// 可解释、可学习、可追溯的工程实现：
//
//   S(x|c,t) = w₀ + Σᵢ wᵢ·fᵢ(x,c,t) + w_personal·log p_personal(x)
//
// 数据纯净性（只收作者亲手确认过的信号）：
//   · 正例 positives：风格样本(1.0) / 编辑后文本(0.7) / 作者归档作品(0.4) / 成稿(0.4)
//   · 偏好对 pairs：edits.jsonl 的 (original → changed)——作者亲手判定"要什么、不要什么"
//   · 知识库/检索内容不进风格语料（f_knowledge 单独走内容通道，风格与内容严格分离）
//
// 训练（小数据微调，几十个编辑对即可）：
//   · pairwise ranking（hinge margin）＋ L2 正则，SGD + momentum，z-score 归一化
//   · 数据签名变化 → 缓存失效 → 在线重训（无需重启、无需外部依赖）
//   · 权重可解释：wᵢ 表示作者在该特征维度上的"坚定度/回避度"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ws from './workspace.js';
import {
  getPersonalModel,
  personalStyleScore,
  personalCorpusSize,
} from './personal-model.js';
import { listEntries } from './knowledge.js';
import { readVector, embedSparse, cosineSparse } from './style-vector.js';
import { readPrototype, cosineDenseVec } from './embedding.js';
import { readAuthorSheet } from './author-sheet.js';
import { deterministicFakeThinking } from './fake-thinking.js';
import { readAvoidance, writeAvoidance, collectAvoidance } from './avoidance.js';
import {
  readEditTransform,
  editFitScore,
  writeEditTransform,
  collectEditTransform,
} from './edit-transform.js';
import { surfaceMatch } from './stylometry.js';

export const FEATURES = [
  'personal',
  'surface',
  'discourse',
  'stance',
  'knowledge',
  'defect',
  'impedance',
  'vector',
  'embedding',
  'fineread',
  'posture',
  'avoidance',
  'transform',
];

// 经验默认权重（无编辑对时的兜底，等价 v0.62 V1 语义 + 新特征温和先验）
export const DEFAULT_WEIGHTS = {
  personal: 2.0,
  surface: 0.2,
  discourse: 0.1,
  stance: 0.1,
  knowledge: 0.5,
  defect: 1.0,
  impedance: 0.25,
  vector: 0.1,
  embedding: 0.2,
  fineread: 0.15,
  posture: 0.2,
  avoidance: 0.15,
  transform: 0.25,
};

// ── 纯净数据收集 ───────────────────────────────────────────

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 收集调制器训练数据：正例（带可信权重）+ 偏好对（作者亲手判定）。
 * 返回 { positives:[{text,weight}], pairs:[{original,changed,intent}], signature }
 */
export function collectModulatorData(workspace) {
  const positives = [];
  const pairs = [];
  const push = (text, weight) => {
    const s = String(text || '').trim();
    if (s.length >= 12) positives.push({ text: s, weight });
  };
  // 风格样本：作者主动提供的旧稿（最高可信）
  try {
    const sampleDir = path.join(workspace, 'vault', 'style-samples');
    if (fs.existsSync(sampleDir)) {
      for (const f of fs.readdirSync(sampleDir)) {
        if (f.endsWith('.md')) push(fs.readFileSync(path.join(sampleDir, f), 'utf8'), 1.0);
      }
    }
  } catch {}
  // 编辑对：作者亲手判定"原文不好、改后更好"（最高密度信号）
  try {
    for (const line of readLines(path.join(workspace, 'vault', 'edits.jsonl'))) {
      try {
        const e = JSON.parse(line);
        const original = String(e.original || '').trim();
        const changed = String(e.changed || '').trim();
        if (original.length >= 4 && changed.length >= 4 && original !== changed) {
          pairs.push({
            original,
            changed,
            intent: String(e.intent || ''),
            ctxBefore: String(e.ctxBefore || ''),
            ctxAfter: String(e.ctxAfter || ''),
          });
          push(changed, 0.7);
        }
      } catch {}
    }
  } catch {}
  // 作者归档作品（vault/library，写作资产，权重较低）
  try {
    const lib = path.join(workspace, 'vault', 'library');
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.md')) push(fs.readFileSync(p, 'utf8'), 0.4);
      }
    };
    if (fs.existsSync(lib)) walk(lib);
  } catch {}
  // 成稿（迭代确认过的当前草稿，权重较低）
  try {
    const draft = path.join(workspace, 'draft.md');
    if (fs.existsSync(draft)) push(fs.readFileSync(draft, 'utf8'), 0.4);
  } catch {}

  const h = crypto.createHash('sha1');
  const files = [];
  const collect = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        if (fs.statSync(p).isDirectory()) collect(p);
        else files.push([p, fs.statSync(p).size, fs.statSync(p).mtimeMs]);
      } catch {}
    }
  };
  collect(path.join(workspace, 'vault', 'style-samples'));
  collect(path.join(workspace, 'vault', 'library'));
  for (const f of ['draft.md', path.join('vault', 'edits.jsonl')]) {
    const p = path.join(workspace, f);
    try {
      files.push([p, fs.statSync(p).size, fs.statSync(p).mtimeMs]);
    } catch {}
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const f of files) h.update(String(f));
  h.update(`pairs=${pairs.length};pos=${positives.length}`);
  return { positives, pairs, signature: h.digest('hex').slice(0, 16) };
}

// ── 特征函数族（八维，全部确定性、可解释、可追溯） ─────────────

function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(w, 'g');
    const m = String(text || '').match(re);
    if (m) n += m.length;
  }
  return n;
}

const AI_LEXICON = [
  '在当今', '随着', '与此同时', '因此', '所以', '然而', '但是', '而且', '不仅',
  '总而言之', '综上所述', '值得注意的是', '首先', '其次', '最后', '众所周知',
  '不可否认', '深刻', '前所未有', '充分发挥', '积极作用', '必然趋势', '我们应当',
  '我们应该', '让我们', '赋能', '助力', '点亮', '共赴', '新篇章', '开启', '更加美好的',
];

/** S_defect：命中 AI 腔词表越多，分数越低（负偏置）。 */
export function defectScore(text) {
  const hits = countHits(text, AI_LEXICON);
  const chars = Math.max(1, String(text || '').replace(/\s/g, '').length);
  return -Math.min(3, hits * 0.35 + (hits / chars) * 30);
}

/** S_knowledge：与个人知识库/检索来源的术语重合度（弱正偏，0~+1）。 */
export function knowledgeScore(workspace, text) {
  const t = String(text || '');
  if (!t) return 0;
  let hits = 0;
  try {
    for (const e of listEntries(workspace)) {
      const title = String(e.title || '').replace(/《|》/g, '');
      if (title.length >= 2 && t.includes(title)) hits += 1;
    }
  } catch {}
  return Math.min(1, hits * 0.35);
}

/** S_impedance(w,t)：随写作进度 t∈(0,1] 调制——后期奖励短句、加重惩罚平滑连接词。 */
export function impedanceScore(text, t) {
  const ratio = Math.max(0.05, Math.min(1, Number(t) || 0));
  const sents = String(text || '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const shortRatio = sents.length ? sents.filter((s) => [...s].length <= 8).length / sents.length : 0;
  const connectors = countHits(text, ['因此', '所以', '然而', '而且', '综上所述', '总而言之']);
  return shortRatio * 1.2 * ratio - Math.min(1.2, connectors * 0.25 * ratio);
}

const IMAGERY_WORDS = [
  '风', '雨', '门', '窗', '楼', '石', '路', '灯', '树', '花', '灰', '光', '影',
  '雪', '河', '山', '桥', '街', '墙', '木', '火', '水', '云', '月', '夜', '烟',
  '钟', '鸟', '纸', '墨', '舟', '巷',
];

/** 表层特征：句长波动 + 短句占比 + 词汇丰富度 + 意象密度（0~1）。 */
export function surfaceFeature(text) {
  const t = String(text || '');
  const chars = t.replace(/\s/g, '');
  if (chars.length < 4) return 0.5;
  const sents = t.split(/[。！？.!?；;]+/).map((s) => s.trim()).filter(Boolean);
  const lens = sents.map((s) => [...s].length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) : 0;
  const shortRatio = lens.length ? lens.filter((l) => l <= 8).length / lens.length : 0;
  const uniq = new Set([...chars]).size;
  const ttr = uniq / Math.max(1, chars.length);
  const imgHits = IMAGERY_WORDS.filter((w) => chars.includes(w)).length;
  const imgDensity = Math.min(1, imgHits / 8);
  const variety = Math.min(1, sd / Math.max(1, mean) / 3);
  return 0.25 * variety + 0.3 * shortRatio + 0.25 * ttr + 0.2 * imgDensity;
}

/** 话语修辞特征：设问、非排比重复、对话性（0~1）。 */
export function discourseFeature(text) {
  const t = String(text || '');
  if (t.replace(/\s/g, '').length < 4) return 0.5;
  const sents = t.split(/[。！？.!?；;]+/).map((s) => s.trim()).filter(Boolean);
  const qCount = (t.split('？').length - 1) + (t.split('?').length - 1);
  const qRatio = sents.length ? Math.min(1, (qCount / sents.length) * 3) : 0;
  const starts = sents.map((s) => [...s].slice(0, 3).join(''));
  let repeat = 0;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] && starts[i] === starts[i - 1]) repeat += 1;
  }
  const repPenalty = Math.min(1, repeat / Math.max(1, sents.length - 1));
  const quotes = (t.match(/[「」“”]/g) || []).length;
  const dialogRatio = Math.min(1, quotes / Math.max(2, sents.length * 2));
  return 0.4 * qRatio + 0.4 * (1 - repPenalty) + 0.2 * dialogRatio;
}

/** 立场特征：红线（用户定死不许改的词/句）命中度（0~1）。 */
export function stanceFeature(workspace, text) {
  const t = String(text || '');
  if (!t) return 0;
  let hits = 0;
  try {
    const state = ws.readState(workspace);
    for (const c of state.constraints || []) {
      const key = String(c || '').replace(/[「」“”《》【】]/g, '').trim();
      if (key.length >= 2 && t.includes(key)) hits += 1;
    }
  } catch {}
  return Math.min(1, hits * 0.5);
}

/** 风格向量方向特征：候选文本与作者 L1 方向差的余弦（0~1）。 */
export function vectorFeature(workspace, text) {
  try {
    const v = readVector(workspace);
    const direction = v.continuous?.direction;
    if (!direction || typeof direction !== 'object') return 0.5;
    const e = embedSparse(String(text || ''));
    const c = cosineSparse(e, direction);
    if (!Number.isFinite(c)) return 0.5;
    return Math.max(0, Math.min(1, (c + 1) / 2));
  } catch {
    return 0.5;
  }
}

/**
 * L3 细读特征（v0.66）：候选文本对"作者写作清单"红线/关键词的命中。
 * 红线是作者定死不许改的信号，命中即强正偏；无清单时中性 0.5。
 */
export function fineReadFeature(workspace, text) {
  const sheet = readAuthorSheet(workspace);
  if (!sheet?.ok) return 0.5;
  const t = String(text || '');
  if (!t) return 0;
  const hits = [];
  for (const k of sheet.redLineFragments || sheet.redLines || []) {
    const key = String(k || '').trim();
    if (key.length >= 2 && t.includes(key)) hits.push(key);
  }
  for (const k of sheet.keywords || []) {
    const key = String(k || '').trim();
    if (key.length >= 2 && t.includes(key)) hits.push(key);
  }
  return Math.min(1, hits.length * 0.25);
}

/**
 * 姿态层细读特征（v0.67）：复用"假思考六层细读"的确定性判据
 * （金句排比收束 / 路标式转折 / 点题式顿悟），转成 0~1 健康度——
 * 越高越不像"表演思考"。软性加权（正偏置），不做硬约束、不拒绝生成。
 */
export function postureFeature(text) {
  const det = deterministicFakeThinking(text);
  return Math.max(0, Math.min(1, 1 - (det.score || 0) / 100));
}

/**
 * 个人回避特征（v0.68）：候选文本命中作者亲手删过的词越多，值越低（"越高越好"方向）。
 * 无回避库时中性 0.5。
 */
export function avoidanceFeature(workspace, text) {
  const av = readAvoidance(workspace);
  if (!av?.ok) return 0.5;
  const terms = Object.keys(av.terms || {});
  if (!terms.length) return 0.5;
  const t = String(text || '');
  const hits = terms.filter((k) => k.length >= 2 && t.includes(k)).length;
  return Math.max(0, Math.min(1, 1 - Math.min(1, hits * 0.25)));
}

/**
 * 提取十二维特征（未归一化的原始值）。
 * embedding 为神经风格特征：需要作者稠密原型 + 候选稠密编码（decodeSection 预计算传入）；
 * fineread 为 L3 细读特征（作者写作清单命中）；均无则取中性 0.5，不破坏降级路径。
 */
export function extractFeatures(workspace, text, { t = 0.5, prototype = null, candidateEmbedding = null } = {}) {
  const model = getPersonalModel(workspace);
  const proto = prototype || readPrototype(workspace);
  let embedding = 0.5;
  if (proto?.ok && candidateEmbedding) {
    const c = cosineDenseVec(proto.vector, candidateEmbedding);
    if (c !== null && Number.isFinite(c)) embedding = Math.max(0, Math.min(1, (c + 1) / 2));
  }
  return {
    personal: model && model.ok ? personalStyleScore(model, text) : 0,
    surface: model && model.ok ? surfaceMatch(model.surfaceProfile, text) : 0.5,
    discourse: discourseFeature(text),
    stance: stanceFeature(workspace, text),
    knowledge: knowledgeScore(workspace, text),
    defect: defectScore(text),
    impedance: impedanceScore(text, t),
    vector: vectorFeature(workspace, text),
    embedding,
    fineread: fineReadFeature(workspace, text),
    posture: postureFeature(text),
    avoidance: avoidanceFeature(workspace, text),
    transform: editFitScore(readEditTransform(workspace), text),
  };
}

// ── 小数据权重学习（签名 → 模型的关键一步） ─────────────────────

/** 把局部编辑对放进原文上下文（v0.68，B2）：无上下文时退回原文本。 */
function ctxJoin(p, text) {
  const joined = `${p?.ctxBefore || ''}${text}${p?.ctxAfter || ''}`.trim();
  return joined || text;
}

function zstats(rows) {
  const mean = {};
  const std = {};
  for (const f of FEATURES) mean[f] = 0;
  const n = rows.length || 1;
  for (const r of rows) for (const f of FEATURES) mean[f] += r[f];
  for (const f of FEATURES) mean[f] /= n;
  for (const f of FEATURES) std[f] = 0;
  for (const r of rows) for (const f of FEATURES) std[f] += (r[f] - mean[f]) ** 2;
  for (const f of FEATURES) std[f] = Math.sqrt(std[f] / n) || 1e-4;
  return { mean, std };
}

function normalizeRow(row, norm) {
  const out = {};
  for (const f of FEATURES) out[f] = (row[f] - norm.mean[f]) / norm.std[f];
  return out;
}

/**
 * 用偏好对训练权重（pairwise hinge ranking + L2，SGD + momentum，确定性）。
 * @param pairs [{original, changed}]
 * @param positives [{text, weight}] 用于补充正例锚点（负例取该工作区的"不想要"信号，
 *        无独立负例时只用于统计，不参与配对）
 */
export function trainModulatorWeights(workspace, data = null) {
  const d = data || collectModulatorData(workspace);
  const feats = FEATURES.length;
  if (d.pairs.length < 2) {
    return {
      ok: false,
      reason: `偏好对不足（${d.pairs.length}/2），保持经验默认权重`,
      pairs: d.pairs.length,
      positives: d.positives.length,
      signature: d.signature,
    };
  }
  const rows = [];
  for (const p of d.pairs) {
    const negText = ctxJoin(p, p.original);
    const posText = ctxJoin(p, p.changed);
    rows.push(extractFeatures(workspace, negText, { t: 0.5 }));
    rows.push(extractFeatures(workspace, posText, { t: 0.5 }));
  }
  const norm = zstats(rows);
  // 配对样本（归一化后）
  const pairRows = [];
  for (const p of d.pairs) {
    const neg = normalizeRow(extractFeatures(workspace, ctxJoin(p, p.original), { t: 0.5 }), norm);
    const pos = normalizeRow(extractFeatures(workspace, ctxJoin(p, p.changed), { t: 0.5 }), norm);
    pairRows.push({ pos, neg });
  }
  const dim = feats;
  let w = new Array(dim + 1).fill(0); // [bias, ...feats]
  const M = pairRows.length;
  const MARGIN = 0.2;
  const L2 = 0.02;
  const LR = 0.05;
  const ITERS = 300;
  const CLIP = 15;
  let lastLoss = 0;
  for (let it = 0; it < ITERS; it++) {
    const grad = new Array(dim + 1).fill(0);
    for (let d = 1; d <= dim; d++) grad[d] += L2 * w[d];
    let loss = 0;
    for (const row of pairRows) {
      let sPos = w[0];
      let sNeg = w[0];
      for (let d = 0; d < dim; d++) {
        sPos += w[d + 1] * row.pos[FEATURES[d]];
        sNeg += w[d + 1] * row.neg[FEATURES[d]];
      }
      const diff = sPos - sNeg;
      const l = Math.max(0, MARGIN - diff);
      loss += l;
      if (l > 0) {
        for (let d = 0; d < dim; d++) {
          // pairwise hinge：∂L/∂w = +(pos − neg)（bias 在成对差中抵消）
          grad[d + 1] += row.pos[FEATURES[d]] - row.neg[FEATURES[d]];
        }
      }
    }
    lastLoss = loss / M;
    for (let d = 0; d <= dim; d++) {
      w[d] += LR * (grad[d] / M);
      if (Math.abs(w[d]) > CLIP) w[d] = Math.sign(w[d]) * CLIP;
    }
  }
  const weights = {};
  for (let d = 0; d < dim; d++) weights[FEATURES[d]] = Number(w[d + 1].toFixed(4));
  return {
    ok: true,
    bias: Number(w[0].toFixed(4)),
    weights,
    norm,
    meta: {
      pairs: d.pairs.length,
      positives: d.positives.length,
      chars: rows.length ? rows.length : 0,
      loss: Number(lastLoss.toFixed(5)),
      epoch: ITERS,
      trainedAt: new Date().toISOString(),
      signature: d.signature,
    },
  };
}

// ── 缓存 + 推理调制 ────────────────────────────────────────

const modCache = new Map();

export function weightsFile(workspace) {
  return path.join(workspace, 'vault', 'modulator-weights.json');
}

/** 读取/训练/缓存调制器（数据签名变化自动重训）。 */
export function getModulator(workspace) {
  const data = collectModulatorData(workspace);
  const cached = modCache.get(data.signature);
  if (cached) return cached;
  let mod = null;
  try {
    const file = weightsFile(workspace);
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.ok && saved.meta?.signature === data.signature) mod = saved;
    }
  } catch {}
  if (!mod) {
    mod = trainModulatorWeights(workspace, data);
    if (mod.ok) {
      try {
        fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
        fs.writeFileSync(weightsFile(workspace), JSON.stringify(mod, null, 2) + '\n', { mode: 0o600 });
        writeAvoidance(workspace, collectAvoidance(workspace));
        writeEditTransform(workspace, collectEditTransform(workspace));
      } catch {}
    }
  }
  modCache.set(data.signature, mod);
  if (modCache.size > 20) modCache.delete(modCache.keys().next().value);
  return mod;
}

/** 逐特征贡献分解（B7）：wᵢ × zᵢ，按贡献绝对值排序。 */
export function contributionBreakdown(weights, features, norm = null) {
  const out = [];
  for (const f of FEATURES) {
    const raw = Number(features[f]) || 0;
    const z = norm ? (raw - (norm.mean[f] || 0)) / (norm.std[f] || 1e-4) : raw;
    const w = Number(weights[f]) || 0;
    out.push({ feature: f, contrib: w * z, weight: w, value: raw });
  }
  return out.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
}

const FEATURE_LABELS = {
  personal: '笔迹接近度',
  surface: '句法节奏',
  discourse: '话语习惯',
  stance: '立场红线',
  knowledge: '知识呼应',
  defect: 'AI 腔回避',
  impedance: '节奏调制',
  vector: '风格方向',
  embedding: '语义原型',
  fineread: '深层清单',
  posture: '姿态健康度',
  avoidance: '个人回避',
  transform: '改迹贴合',
};

/** 把贡献分解翻译成人话（候选级"为什么选它"）。 */
export function humanRationale(contributions) {
  if (!Array.isArray(contributions) || !contributions.length) return '（无可解释信号）';
  const pos = contributions.filter((c) => c.contrib > 0.02).slice(0, 2);
  const neg = contributions.filter((c) => c.contrib < -0.02).slice(0, 1);
  const parts = [];
  if (pos.length) {
    parts.push(`它更贴你的笔迹，主要因为${pos.map((c) => FEATURE_LABELS[c.feature] || c.feature).join('、')}占优`);
  }
  if (neg.length) {
    parts.push(`它在${FEATURE_LABELS[neg[0].feature] || neg[0].feature}上扣分更少`);
  }
  return parts.length ? parts.join('；') : '各信号均衡，没有明显的主导选择';
}

/** 推理时调制：返回 {score, features, weights, trained, mode}。 */
export function modulate(workspace, text, { t = 0.5, prototype = null, candidateEmbedding = null } = {}) {
  const mod = getModulator(workspace);
  const features = extractFeatures(workspace, text, { t, prototype, candidateEmbedding });
  if (mod.ok) {
    const norm = normalizeRow(features, mod.norm);
    let score = mod.bias;
    for (const f of FEATURES) score += mod.weights[f] * norm[f];
    const contributions = contributionBreakdown(mod.weights, features, mod.norm);
    return {
      score: Number(score.toFixed(4)),
      features,
      weights: { ...mod.weights },
      trained: true,
      mode: 'learned',
      meta: mod.meta,
      contributions,
      rationale: humanRationale(contributions),
    };
  }
  let score = 0;
  for (const f of FEATURES) score += DEFAULT_WEIGHTS[f] * features[f];
  const contributions = contributionBreakdown(DEFAULT_WEIGHTS, features, null);
  return {
    score: Number(score.toFixed(4)),
    features,
    weights: { ...DEFAULT_WEIGHTS },
    trained: false,
    mode: 'default',
    contributions,
    rationale: humanRationale(contributions),
  };
}

/** CLI/状态展示：数据量 + 训练状态 + 权重表。 */
export function modulatorStatus(workspace) {
  const data = collectModulatorData(workspace);
  const mod = getModulator(workspace);
  return {
    positives: data.positives.length,
    pairs: data.pairs.length,
    chars: data.positives.reduce((a, p) => a + p.text.length, 0),
    signature: data.signature,
    trained: Boolean(mod.ok),
    mode: mod.ok ? 'learned' : 'default',
    weights: mod.ok ? { ...mod.weights, bias: mod.bias } : { ...DEFAULT_WEIGHTS },
    meta: mod.meta || { reason: mod.reason || '经验默认' },
  };
}

/** 强制重训（绕过缓存并覆盖权重文件；数据不足时返回未训练状态）。 */
export function forceRetrain(workspace) {
  const data = collectModulatorData(workspace);
  const mod = trainModulatorWeights(workspace, data);
  if (mod.ok) {
    try {
      fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
      fs.writeFileSync(weightsFile(workspace), JSON.stringify(mod, null, 2) + '\n', { mode: 0o600 });
    } catch {}
  }
  modCache.delete(data.signature);
  modCache.set(data.signature, mod);
  return mod;
}

/**
 * 增量在线更新（v0.65）：新编辑对到达时，用现有归一化参数做局部 SGD 几步，
 * 避免全量重训；从未训练（<2 对）时自动走批量重训。
 */
export function applyEditIncremental(
  workspace,
  edit,
  { steps = 25, lr = 0.04, margin = 0.2, l2 = 0.02 } = {},
) {
  const original = String(edit?.original || '').trim();
  const changed = String(edit?.changed || '').trim();
  if (original.length < 4 || changed.length < 4 || original === changed) {
    return { ok: false, reason: '无效编辑对' };
  }
  const data = collectModulatorData(workspace);
  const mod = getModulator(workspace);
  if (!mod.ok) return forceRetrain(workspace);
  const neg = normalizeRow(extractFeatures(workspace, ctxJoin(edit, original), { t: 0.5 }), mod.norm);
  const pos = normalizeRow(extractFeatures(workspace, ctxJoin(edit, changed), { t: 0.5 }), mod.norm);
  const w = [Number(mod.bias || 0), ...FEATURES.map((f) => Number(mod.weights[f] || 0))];
  const dim = FEATURES.length;
  let loss = 0;
  for (let it = 0; it < steps; it++) {
    let sPos = w[0];
    let sNeg = w[0];
    for (let d = 0; d < dim; d++) {
      sPos += w[d + 1] * pos[FEATURES[d]];
      sNeg += w[d + 1] * neg[FEATURES[d]];
    }
    loss = Math.max(0, margin - (sPos - sNeg));
    if (loss > 0) {
      for (let d = 0; d < dim; d++) {
        w[d + 1] += lr * (pos[FEATURES[d]] - neg[FEATURES[d]]) - l2 * w[d + 1];
        if (Math.abs(w[d + 1]) > 15) w[d + 1] = Math.sign(w[d + 1]) * 15;
      }
    }
  }
  const weights = {};
  for (let d = 0; d < dim; d++) weights[FEATURES[d]] = Number(w[d + 1].toFixed(4));
  const next = {
    ok: true,
    bias: Number(w[0].toFixed(4)),
    weights,
    norm: mod.norm,
    meta: {
      ...(mod.meta || {}),
      pairs: data.pairs.length,
      positives: data.positives.length,
      loss: Number(loss.toFixed(5)),
      epoch: (mod.meta?.epoch || 0) + steps,
      trainedAt: new Date().toISOString(),
      signature: data.signature,
    },
  };
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(weightsFile(workspace), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch {}
  modCache.delete(data.signature);
  modCache.set(data.signature, next);
  return next;
}

export { personalCorpusSize };
