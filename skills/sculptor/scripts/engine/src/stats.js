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
  return {
    valid,
    hits,
    rate: Number(rate.toFixed(4)),
    pValue: Number(pValue.toFixed(4)),
    ci: ci.map((x) => Number(x.toFixed(4))),
    effect: Number(effect.toFixed(4)),
    significant: pValue < 0.05,
    table: [
      ['有效作答', String(valid)],
      ['命中（选对更像作者）', String(hits)],
      ['命中率', `${(rate * 100).toFixed(1)}%`],
      ['精确二项 p（H0: 50%）', pValue.toFixed(4)],
      ['95% Wilson CI', `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`],
      ['Cohen\'s h（vs 50%）', effect.toFixed(3)],
      ['结论', pValue < 0.05 ? '显著高于随机（p<0.05）' : '未达显著（样本或效果不足）'],
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
