// 风格记忆检索层（RAG 风格注入）：从作者本人的旧稿、亲手修改记录、对话日志中，
// 按"当前论题 + 文体 + 高置信风格维度"检索少样本，注入写作/大纲/红队修订提示。
// 零依赖：中文按字符二元组做 BM25；评分 = 相关度 + 时间衰减 + 重要性 加权。
// 设计依据：Generative Agents 的 recency+importance+relevance 记忆评分、
// StyleMC 的对比式风格表示（正例 + 反例）、MemGPT 的档案记忆分层。
import fs from 'node:fs';
import path from 'node:path';

// 作者绝不会写的 AI 腔反例（与红队黑名单同源，压缩成句式级样例）。
const NEGATIVE_EXAMPLES = [
  '在当今社会，随着时代的快速发展，我们不难发现……',
  '值得注意的是，这不仅是一种选择，更是一种责任。',
  '总而言之，我们应该共同努力，创造一个更加美好的未来。',
  '让我们不禁思考：我们究竟该何去何从？',
  '综上所述，这无疑具有深远的意义。',
];

const RECENCY_HALF_DAYS = 120; // 风格随时间缓慢漂移：120 天衰减一半权重
const WEIGHTS = { relevance: 0.62, recency: 0.22, importance: 0.16 };
const SAMPLE_CAP = 360; // 每段旧稿注入的字符上限，控制上下文开销

/** 中文分词：去除标点后取字符二元组（含至少一个汉字），兼容中英混排。 */
function tokenize(text) {
  const clean = String(text || '')
    .toLowerCase()
    // 注意：不能用 \W 清洗中文（非 u 模式下 \W 会把汉字当非词字符删掉），
    // 这里显式保留中日韩汉字与 ASCII 字母，其余标点/空白/数字一律剔除。
    .replace(/[\s\d]+/g, '')
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z]/g, '');
  const grams = [];
  const chars = clean.replace(/\s+/g, '');
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.push(g);
  }
  return grams;
}

/** BM25 打分（k1=1.5, b=0.75），返回与 docs 等长的原始分数数组。 */
function bm25Scores(docs, query) {
  const qGrams = [...new Set(tokenize(query))];
  if (!qGrams.length || !docs.length) return docs.map(() => 0);
  const N = docs.length;
  const df = new Map();
  for (const d of docs) {
    for (const g of new Set(d.grams)) df.set(g, (df.get(g) || 0) + 1);
  }
  const avgdl = docs.reduce((s, d) => s + d.grams.length, 0) / N;
  return docs.map((d) => {
    const tf = new Map();
    for (const g of d.grams) tf.set(g, (tf.get(g) || 0) + 1);
    let score = 0;
    for (const g of qGrams) {
      const f = tf.get(g) || 0;
      if (!f) continue;
      const n = df.get(g) || 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const dl = d.grams.length;
      score += idf * ((f * 2.5) / (f + 1.5 * (1 - 0.75 + 0.75 * (dl / Math.max(1, avgdl)))));
    }
    return score;
  });
}

function daysSince(ts) {
  const t = ts ? new Date(ts).getTime() : Date.now();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function recencyScore(ts) {
  return Math.exp(-daysSince(ts) / RECENCY_HALF_DAYS);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function truncateSample(text) {
  const s = String(text || '').trim();
  return s.length > SAMPLE_CAP ? `${s.slice(0, SAMPLE_CAP)}…` : s;
}

/** 读取 vault/style-samples/*.md：用户贴过的旧稿底稿。 */
function readSamples(workspace) {
  const dir = path.join(workspace, 'vault', 'style-samples');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const file = path.join(dir, f);
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text.length < 40) continue;
      out.push({
        kind: 'sample',
        source: f,
        text,
        ts: fs.statSync(file).mtime.toISOString(),
        importance: 0.8, // 旧稿是最高质量的风格证据
      });
    } catch {
      // 单个样本损坏不阻塞整体
    }
  }
  return out;
}

/** 读取 vault/edits.jsonl：作者亲手修改的记录（原文→修改→意图）。 */
function readEdits(workspace) {
  let lines = [];
  try {
    lines = fs
      .readFileSync(path.join(workspace, 'vault', 'edits.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!e.changed && !e.original) continue;
      out.push({
        kind: 'edit',
        original: String(e.original || '').trim(),
        changed: String(e.changed || '').trim(),
        intent: String(e.intent || '').trim(),
        ts: e.ts,
        importance: e.intent ? 0.95 : 0.85, // 带意图的修改是更深的风格信号
      });
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 读取 protocol/context.jsonl：对话日志里的用户长句（弱风格证据）。 */
function readContext(workspace) {
  let lines = [];
  try {
    lines = fs
      .readFileSync(path.join(workspace, 'protocol', 'context.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const summary = String(rec.summary || '');
      const m = summary.match(/→\s*(.+)$/);
      const text = rec.event === 'user' ? summary : m ? m[1] : '';
      if (text.length < 40) continue;
      out.push({
        kind: 'context',
        text: text.slice(0, 300),
        ts: rec.ts,
        importance: 0.5, // 对话素材弱于旧稿与修改记录
      });
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 从 write-style.json 取高置信维度的值（≥0.5），并入查询词，让档案反向影响检索。 */
function highConfidenceDimValues(workspace) {
  const obj = readJsonSafe(path.join(workspace, 'vault', 'write-style.json'));
  if (!obj) return '';
  return Object.entries(obj.dimensions || {})
    .filter(([, d]) => d && (d.confidence || 0) >= 0.5 && d.value)
    .map(([, d]) => d.value)
    .join(' ');
}

function readProfile(workspace) {
  const obj = readJsonSafe(path.join(workspace, 'vault', 'write-style.json'));
  const vector = obj?.vector || {};
  return {
    associations: vector.personalDataset?.topAssociations || [],
    techniques: vector.personalDataset?.topTechniques || [],
  };
}

/**
 * 查询风格记忆：按论题/文体/本节信息打分排序，返回旧稿片段 + 编辑对 + 联想库 + 反例。
 * 无任何可用记忆时返回 empty: true，调用方应静默跳过（不阻塞写作）。
 */
export function queryStyleMemory(
  workspace,
  { topic = '', genre = '', section = null, maxSamples = 3, maxEdits = 4, withContext = true } = {},
) {
  const docs = [
    ...readSamples(workspace),
    ...readEdits(workspace),
    ...(withContext ? readContext(workspace) : []),
  ];
  const queryText = [
    topic,
    genre,
    section?.heading,
    section?.thesis,
    ...(section?.keyPoints || []),
    highConfidenceDimValues(workspace),
  ]
    .filter(Boolean)
    .join(' ');
  if (!docs.length) {
    return {
      query: queryText,
      samples: [],
      edits: [],
      associations: [],
      techniques: [],
      negatives: NEGATIVE_EXAMPLES.slice(0, 4),
      empty: true,
    };
  }
  for (const d of docs) d.grams = tokenize(d.text || [d.original, d.changed, d.intent].join(' '));
  const raw = bm25Scores(docs, queryText);
  const max = Math.max(...raw, 1e-9);
  const scored = docs
    .map((d, i) => ({
      ...d,
      score:
        WEIGHTS.relevance * (raw[i] / max) +
        WEIGHTS.recency * recencyScore(d.ts) +
        WEIGHTS.importance * d.importance,
    }))
    .sort((a, b) => b.score - a.score);
  const profile = readProfile(workspace);
  return {
    query: queryText,
    samples: scored
      .filter((d) => d.kind === 'sample')
      .slice(0, maxSamples)
      .map((d) => ({
        text: truncateSample(d.text),
        score: Number(d.score.toFixed(2)),
        source: d.source,
      })),
    edits: scored
      .filter((d) => d.kind === 'edit')
      .slice(0, maxEdits)
      .map((d) => ({
        original: d.original,
        changed: d.changed,
        intent: d.intent,
        score: Number(d.score.toFixed(2)),
      })),
    associations: profile.associations.slice(0, 5),
    techniques: profile.techniques.slice(0, 5),
    negatives: NEGATIVE_EXAMPLES.slice(0, 4),
    empty: false,
  };
}

/** 供提示词注入的完整少样本块；无记忆时返回 null（写作照常进行）。 */
export function buildStyleShot(workspace, opts = {}) {
  const shot = queryStyleMemory(workspace, opts);
  if (shot.empty || (!shot.samples.length && !shot.edits.length)) return null;
  return shot;
}
