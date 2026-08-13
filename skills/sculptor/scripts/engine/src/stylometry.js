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
