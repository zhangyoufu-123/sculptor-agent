// 词级文体计量（stylometry · v1.7）：作者身份最稳的信号不是内容实词，而是
// "功能词 + 标点节奏" 的选择模式（Burrows' Delta 的现代变体）。
// 零依赖、确定性、可解释——把 char n-gram 抓不到的风格差异补上。

// 单字功能词/虚词/语气词（高频、与内容弱相关）
const SINGLE = new Set([
  '的', '了', '着', '过', '是', '在', '有', '就', '都', '也', '还', '又', '才', '只',
  '会', '能', '要', '想', '被', '把', '让', '给', '对', '向', '从', '到', '与', '和',
  '或', '而', '但', '却', '则', '便', '即', '因', '所', '之', '其', '这', '那', '哪',
  '谁', '很', '太', '更', '最', '越', '不', '没', '别', '无', '非', '未', '呢', '啊',
  '吧', '吗', '嘛', '呀', '哦', '哈', '一', '个', '上', '下', '里', '中',
]);

// 多字连接词/话语标记（2–4 字，话语风格强信号）
const MULTI = [
  '因为', '所以', '因此', '然而', '但是', '不过', '虽然', '尽管', '而且', '并且',
  '于是', '然后', '接着', '同时', '此外', '另外', '总之', '其实', '甚至', '尤其',
  '特别', '反而', '倒是', '毕竟', '到底', '究竟', '罢了', '而已', '来着', '什么',
  '怎么', '如何', '多么', '我们', '他们', '自己', '一样', '只是', '只要', '就是',
];
const MULTI_RE = new RegExp(MULTI.join('|'), 'g');

// 标点（节奏信号）
const PUNCT = ['，', '。', '！', '？', '；', '：', '、', '——', '……', '“', '”', '《', '》'];

function countOccurrences(text, needle) {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 提取文体计量向量：{ "w:的":0.021, "p:。":0.008, ... }，值为每字频率。
 * 只保留出现过的键（稀疏向量）。
 */
export function stylometricVector(text) {
  const t = String(text || '');
  const n = Math.max(1, t.length);
  const vec = {};
  const single = {};
  for (const ch of t) {
    if (SINGLE.has(ch)) single[ch] = (single[ch] || 0) + 1;
  }
  for (const [ch, c] of Object.entries(single)) vec[`w:${ch}`] = c / n;
  const multi = t.match(MULTI_RE);
  const multiCounts = {};
  if (multi) for (const w of multi) multiCounts[w] = (multiCounts[w] || 0) + 1;
  for (const [w, c] of Object.entries(multiCounts)) vec[`w:${w}`] = c / n;
  for (const p of PUNCT) {
    const c = countOccurrences(t, p);
    if (c) vec[`p:${p}`] = c / n;
  }
  return vec;
}

/** 稀疏向量余弦（文体相似度，0~1）。 */
export function stylometricCosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (const [k, v] of Object.entries(a)) if (b[k] !== undefined) dot += v * b[k];
  let na = 0;
  for (const v of Object.values(a)) na += v * v;
  let nb = 0;
  for (const v of Object.values(b)) nb += v * v;
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** 多个向量的平均质心（按频率取均值）。 */
export function stylometricCentroid(vecs) {
  const sum = {};
  const count = {};
  for (const v of vecs) {
    for (const [k, val] of Object.entries(v)) {
      sum[k] = (sum[k] || 0) + val;
      count[k] = (count[k] || 0) + 1;
    }
  }
  const out = {};
  for (const [k, s] of Object.entries(sum)) out[k] = s / count[k];
  return out;
}

// ── 表层节奏（句长/短句占比/意象密度）——相对作者语料，而非绝对"好"──

const IMAGERY = [
  '风', '雨', '门', '窗', '楼', '石', '路', '灯', '树', '花', '灰', '光', '影',
  '雪', '河', '山', '桥', '街', '墙', '木', '火', '水', '云', '月', '夜', '烟',
  '钟', '鸟', '纸', '墨', '舟', '巷',
];

/** 表层节奏的四个可观测分量。 */
export function surfaceMetrics(text) {
  const t = String(text || '');
  const sents = t.split(/[。！？.!?；;]+/).map((s) => s.trim()).filter(Boolean);
  const lens = sents.map((s) => [...s].length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) : 0;
  const short = lens.length ? lens.filter((l) => l <= 8).length / lens.length : 0;
  const chars = t.replace(/\s/g, '');
  const img = chars ? Math.min(1, IMAGERY.filter((w) => chars.includes(w)).length / 8) : 0;
  return { mean, sd, short, img };
}

/** 作者表层节奏质心（多文本均值）。 */
export function surfaceProfile(texts) {
  const ms = texts.map((t) => surfaceMetrics(t));
  const avg = (k) => ms.reduce((s, m) => s + m[k], 0) / Math.max(1, ms.length);
  return { mean: avg('mean'), sd: avg('sd'), short: avg('short'), img: avg('img') };
}

/**
 * 表层节奏贴合度（0~1）：候选的句长/波动/短句占比/意象密度
 * 与作者质心的归一化 L1 距离取反——越大越像作者的节奏。
 */
export function surfaceMatch(profile, text) {
  if (!profile) return 0.5;
  const m = surfaceMetrics(text);
  const meanD = Math.abs(m.mean - profile.mean) / Math.max(10, profile.mean, m.mean);
  const sdD = Math.abs(m.sd - profile.sd) / Math.max(5, profile.sd, m.sd);
  const shortD = Math.abs(m.short - profile.short);
  const imgD = Math.abs(m.img - profile.img);
  return Math.max(0, Math.min(1, 1 - (meanD + sdD + shortD + imgD) / 4));
}
