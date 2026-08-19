// 盲评与显著性统计（v0.68，D1）：把"哪篇更像作者"的盲评回答变成可发表的硬指标。
// 提供：精确二项检验（H0: p=0.5）、Wilson 95% 置信区间、Cohen's h 效应量。
// 零依赖、确定性、可单测。

function binomialProb(k, n, p) {
  if (k < 0 || k > n) return 0;
  let c = 1;
  const kk = Math.min(k, n - k);
  for (let i = 0; i < kk; i++) c = (c * (n - i)) / (i + 1);
  return c * p ** k * (1 - p) ** (n - k);
}

/** 精确二项检验（双侧，累计所有不高于观测概率的结果）。 */
export function exactBinomialP(k, n, p0 = 0.5) {
  if (!n) return 1;
  const obs = binomialProb(k, n, p0);
  let p = 0;
  for (let i = 0; i <= n; i++) {
    if (binomialProb(i, n, p0) <= obs + 1e-12) p += binomialProb(i, n, p0);
  }
  return Math.min(1, p);
}

/** Wilson 比分区间（默认 95%）。 */
export function wilsonCI(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Cohen's h 效应量（比例差异的反正弦变换）。 */
export function cohensH(p1, p2) {
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p1)))) - 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p2))));
}

/**
 * 盲评统计报告。
 * @param answers [{pairIndex, choice, correct}] correct=true 表示选对了"更像作者本人"的那篇；
 *        choice 为 'A'|'B'|'none'（none 计入无效作答）。
 * @returns {valid, hits, rate, pValue, ci, effect, table}
 */
export function blindStatsReport(answers) {
  const rows = (Array.isArray(answers) ? answers : []).filter((a) => a && a.choice !== 'none');
  const valid = rows.length;
  const hits = rows.filter((a) => Boolean(a.correct)).length;
  const rate = valid ? hits / valid : 0;
  const pValue = exactBinomialP(hits, valid, 0.5);
  const ci = wilsonCI(hits, valid);
  const effect = cohensH(rate, 0.5);
  const direction = rate > 0.5 ? 'above' : rate < 0.5 ? 'below' : 'equal';
  return {
    valid,
    hits,
    rate: Number(rate.toFixed(4)),
    pValue: Number(pValue.toFixed(4)),
    ci: ci.map((x) => Number(x.toFixed(4))),
    effect: Number(effect.toFixed(4)),
    significant: pValue < 0.05,
    direction,
    table: [
      ['有效作答', String(valid)],
      ['命中（选对更像作者）', String(hits)],
      ['命中率', `${(rate * 100).toFixed(1)}%`],
      ['精确二项 p（H0: 50%）', pValue.toFixed(4)],
      ['95% Wilson CI', `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`],
      ['Cohen\'s h（vs 50%）', effect.toFixed(3)],
      ['结论', pValue < 0.05 ? (rate > 0.5 ? '显著高于随机（p<0.05）' : '显著低于随机（p<0.05）') : '未达显著（样本或效果不足）'],
    ],
  };
}

/** 解析盲评 CSV：表头 pairIndex,choice,correct（correct 为 true/false 或 1/0）。 */
export function parseBlindCsv(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const idx = {
    pair: header.findIndex((h) => /pair|index|对/i.test(h)),
    choice: header.findIndex((h) => /choice|选/i.test(h)),
    correct: header.findIndex((h) => /correct|对错|命中/i.test(h)),
  };
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const choice = String(c[idx.choice] || '').trim().toUpperCase();
    if (!['A', 'B', 'NONE'].includes(choice)) continue;
    let correct = null;
    if (idx.correct >= 0) {
      const v = String(c[idx.correct] || '').trim().toLowerCase();
      correct = v === 'true' || v === '1' || v === '正确' || v === '对';
    }
    out.push({
      pairIndex: idx.pair >= 0 ? Number(c[idx.pair]) || null : null,
      choice,
      correct,
    });
  }
  return out;
}

/**
 * 配对置换检验（两方法在同一批样本上的准确率差异是否显著）。
 * H0：两方法等价——在判定不一致的样本上，"哪个方法判对"是可交换的。
 * 该情形下不一致样本数 m 固定，方法 A 判对的数量 d 服从 Binomial(m, 0.5)，
 * 因此精确 p 值 = 对 d 做双侧二项检验（即 McNemar/置换分布的精确形式，零蒙特卡洛噪声）。
 * @param predA 方法 A 预测的标签数组
 * @param predB 方法 B 预测的标签数组
 * @param truth 真实标签数组
 * @returns {accA, accB, diff, pValue, discordant}
 */
export function permutationTestPaired(predA, predB, truth) {
  const n = Math.min(predA.length, predB.length, truth.length);
  if (!n) return { accA: 0, accB: 0, diff: 0, pValue: 1, discordant: 0 };
  let accA = 0;
  let accB = 0;
  let d = 0; // A 对 B 错
  let e = 0; // A 错 B 对
  for (let i = 0; i < n; i++) {
    const a = predA[i] === truth[i];
    const b = predB[i] === truth[i];
    if (a) accA += 1;
    if (b) accB += 1;
    if (a && !b) d += 1;
    else if (!a && b) e += 1;
  }
  accA /= n;
  accB /= n;
  const m = d + e;
  const pValue = m ? exactBinomialP(d, m, 0.5) : 1;
  return {
    accA: Number(accA.toFixed(4)),
    accB: Number(accB.toFixed(4)),
    diff: Number((accA - accB).toFixed(4)),
    pValue: Number(pValue.toFixed(4)),
    discordant: m,
  };
}

// ============================================================================
// 以下为盲评任务 2（单段打分）与多模型一致性（Fleiss' κ）所需补充统计。
// 零依赖、确定性、可单测。
// ============================================================================

/** 标准正态 CDF（Abramowitz-Stegun erf 近似）。 */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  let p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function sd(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}

/** 均值±SD 报告。 */
export function meanSd(arr) {
  return { mean: Number(mean(arr).toFixed(4)), sd: Number(sd(arr).toFixed(4)), n: arr.length };
}

/**
 * Wilcoxon 符号秩检验（配对）。返回 n、W（较小一侧秩和）、z、双侧 p、是否精确。
 * n<=20 用秩分配的精确枚举；否则正态近似（含结校正）。
 */
export function wilcoxonSignedRank(a, b) {
  const diffs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i];
    if (d !== 0) diffs.push(d);
  }
  const n = diffs.length;
  if (n === 0) return { n: 0, W: 0, z: 0, p: 1, exact: false };
  const abs = diffs.map(Math.abs);
  const ranks = rankWithTies(abs);
  let Wpos = 0;
  let Wneg = 0;
  diffs.forEach((d, i) => {
    if (d > 0) Wpos += ranks[i];
    else Wneg += ranks[i];
  });
  const W = Math.min(Wpos, Wneg);
  if (n <= 20) {
    // 精确枚举 2^n 个符号分配，统计秩和 <= W 的个数。
    let count = 0;
    const total = 1 << n;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? ranks[i] : 0;
      if (s <= W) count++;
    }
    const p = (2 * Math.min(count, total - count)) / total;
    return { n, W: Number(W.toFixed(3)), z: null, p: Number(Math.min(1, p).toFixed(4)), exact: true };
  }
  // 正态近似（结校正）。
  const tie = tieCorrection(ranks);
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 6 - tie);
  const z = (W - 0.5) / sigma;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n, W: Number(W.toFixed(3)), z: Number(z.toFixed(3)), p: Number(Math.min(1, p).toFixed(4)), exact: false };
}

/**
 * Mann-Whitney U（独立两样本）。
 * n1*n2<=50000 用精确枚举（小样本、离散评分、强结都可靠）；否则正态近似（含结校正）。
 */
export function wilcoxonRankSum(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { U: 0, z: 0, p: 1 };
  const merged = [...a.map((x) => ({ v: x, g: 0 })), ...b.map((x) => ({ v: x, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = rankWithTies(merged.map((m) => m.v));
  let r1 = 0;
  merged.forEach((m, i) => {
    if (m.g === 0) r1 += ranks[i];
  });
  const U1act = r1 - (n1 * (n1 + 1)) / 2;
  const total = n1 * n2;
  const Uobs = Math.min(U1act, total - U1act);
  const N = n1 + n2;
  const ncomb = combCount(N, n1);
  if (ncomb <= 50000) {
    let count = 0;
    const combo = [];
    const rec = (start, depth) => {
      if (depth === n1) {
        let s = 0;
        for (const i of combo) s += ranks[i];
        const U1 = s - (n1 * (n1 + 1)) / 2;
        const U = Math.min(U1, total - U1);
        if (U <= Uobs + 1e-9) count++;
        return;
      }
      for (let i = start; i <= N - (n1 - depth); i++) {
        combo.push(i);
        rec(i + 1, depth + 1);
        combo.pop();
      }
    };
    rec(0, 0);
    const p = (2 * Math.min(count, ncomb - count)) / ncomb;
    return { U: Number(Uobs.toFixed(3)), z: null, p: Number(Math.min(1, p).toFixed(4)), exact: true };
  }
  // 正态近似（结校正）
  const tie = tieCorrection(ranks);
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12 - (n1 * n2 * tie) / (12 * (n1 + n2 - 1)));
  const z = sigma > 0 ? (Uobs - 0.5) / sigma : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { U: Number(Uobs.toFixed(3)), z: Number(z.toFixed(3)), p: Number(Math.min(1, p).toFixed(4)), exact: false };
}

/** Cohen's d（独立，合并 SD）。 */
export function cohensD(a, b) {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const va = sd(a) ** 2;
  const vb = sd(b) ** 2;
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (pooled === 0) return 0;
  return Number(((mean(a) - mean(b)) / pooled).toFixed(3));
}

/** Cohen's d_z（配对，diff 的标准差）。 */
export function cohensDz(diff) {
  const s = sd(diff);
  if (s === 0) return 0;
  return Number((mean(diff) / s).toFixed(3));
}

/**
 * Fleiss' κ（多评分者一致性）。
 * @param ratings 数组，每个元素是一道题的评分者类别数组（类别可取值 0..k-1 或字符串）。
 * @returns {kappa, nItems, nRaters, pe} pe 为偶然一致率。
 */
export function fleissKappa(ratings) {
  const N = ratings.length;
  if (N === 0) return { kappa: 0, nItems: 0, nRaters: 0, pe: 0 };
  // 收集类别集合（支持每题评分者数不同）
  const cats = new Set();
  ratings.forEach((r) => r.forEach((c) => cats.add(String(c))));
  const catList = [...cats];
  const k = catList.length;
  if (k < 2) return { kappa: 1, nItems: N, nRaters: ratings.reduce((s, r) => s + r.length, 0), pe: 1 };
  let Pbar = 0;
  const catCount = new Array(k).fill(0);
  let total = 0;
  for (const r of ratings) {
    const ni = r.length;
    total += ni;
    const nij = new Array(k).fill(0);
    for (const c of r) nij[catList.indexOf(String(c))] += 1;
    let sumSq = 0;
    for (let j = 0; j < k; j++) {
      sumSq += (nij[j] / ni) ** 2;
      catCount[j] += nij[j];
    }
    Pbar += sumSq / N;
  }
  let Pe = 0;
  for (let j = 0; j < k; j++) {
    const pj = catCount[j] / total;
    Pe += pj * pj;
  }
  if (Pe >= 1) return { kappa: 0, nItems: N, nRaters: total, pe: Number(Pe.toFixed(4)) };
  const kappa = (Pbar - Pe) / (1 - Pe);
  return { kappa: Number(kappa.toFixed(4)), nItems: N, nRaters: total, pe: Number(Pe.toFixed(4)) };
}

/**
 * 单段打分报告（配对比较两候选的打分分布）。
 * @param a 候选 A 的打分（同题、跨模型/评审对齐）
 * @param b 候选 B 的打分
 * @returns mean±SD、配对 Wilcoxon、Cohen's d_z
 */
export function scoringReport(a, b) {
  const diffs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) diffs.push(a[i] - b[i]);
  const wx = wilcoxonSignedRank(a, b);
  return {
    a: meanSd(a),
    b: meanSd(b),
    meanDiff: Number(mean(diffs).toFixed(4)),
    wilcoxon: wx,
    cohensDz: cohensDz(diffs),
  };
}

/** 带结的平均秩。 */
function rankWithTies(values) {
  const n = values.length;
  const order = [...values.keys()].sort((i, j) => values[i] - values[j]);
  const ranks = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let t = i; t <= j; t++) ranks[order[t]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** 结校正项 = sum (t^3 - t) / 12。 */
function tieCorrection(ranks) {
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  let tie = 0;
  for (const c of Object.values(counts)) if (c > 1) tie += (c ** 3 - c) / 12;
  return tie;
}

/** 组合数 C(n, k)（小整数，防溢出用 BigInt 再转回）。 */
function combCount(n, k) {
  k = Math.min(k, n - k);
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
  return Number(r);
}
