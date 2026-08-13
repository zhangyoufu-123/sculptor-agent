// v0.68 盲评与显著性统计测试（D1）：精确二项、Wilson CI、效应量、CSV 解析。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { exactBinomialP, wilsonCI, cohensH, blindStatsReport, parseBlindCsv, permutationTestPaired } = await import(
  path.join(HERE, '..', 'src', 'stats.js')
);

// 1) 精确二项：n=12, k=9, H0:0.5 → 双侧 p ≈ 0.146（手工核对）
{
  const p = exactBinomialP(9, 12, 0.5);
  assert(p > 0.1 && p < 0.2, `精确二项 p 落在已知区间（${p.toFixed(4)}）`);
  assert(exactBinomialP(12, 12, 0.5) < 0.01, '全命中显著');
  assert(exactBinomialP(0, 12, 0.5) < 0.01, '全不中也显著（方向性）');
  assert(exactBinomialP(6, 12, 0.5) > 0.9, '恰好随机不显著');
  console.log('PASS 精确二项检验');
}

// 2) Wilson CI：命中率 10/12 的 95% 区间应包含 0.833 且不越界
{
  const ci = wilsonCI(10, 12);
  assert(ci[0] >= 0 && ci[0] <= 0.833 && ci[1] >= 0.833 && ci[1] <= 1, `CI 合理（${ci}）`);
  assert(wilsonCI(0, 0)[0] === 0 && wilsonCI(0, 0)[1] === 1, 'n=0 兜底');
  console.log('PASS Wilson 置信区间');
}

// 3) 效应量：高于随机的命中率应给正效应
{
  assert(cohensH(0.75, 0.5) > 0.5, '大比例差 → 大效应量');
  assert(Math.abs(cohensH(0.5, 0.5)) < 1e-9, '相等 → 零效应');
  console.log('PASS Cohen\'s h 效应量');
}

// 4) 盲评报告：none 排除、显著判定
{
  const r = blindStatsReport([
    { pairIndex: 0, choice: 'A', correct: true },
    { pairIndex: 1, choice: 'B', correct: true },
    { pairIndex: 2, choice: 'A', correct: true },
    { pairIndex: 3, choice: 'B', correct: true },
    { pairIndex: 4, choice: 'A', correct: true },
    { pairIndex: 5, choice: 'A', correct: true },
    { pairIndex: 6, choice: 'B', correct: true },
    { pairIndex: 7, choice: 'A', correct: true },
    { pairIndex: 8, choice: 'B', correct: true },
    { pairIndex: 9, choice: 'A', correct: true },
    { pairIndex: 10, choice: 'B', correct: false },
    { pairIndex: 11, choice: 'none', correct: null },
    { pairIndex: 12, choice: 'none', correct: null },
  ]);
  assert(r.valid === 11, `有效作答排除 none（${r.valid}）`);
  assert(r.hits === 10, '命中计数正确');
  assert(r.significant === true, '10/11 显著高于随机');
  assert(Array.isArray(r.table) && r.table.some(([k]) => k.includes('精确二项')), '报告含显著性行');
  console.log('PASS 盲评统计报告（none 排除/显著判定/表格）');
}

// 5) CSV 解析：表头 pairIndex,choice,correct
{
  const csv = 'pairIndex,choice,correct\n1,A,true\n2,B,false\n3,none,\n4,A,1\n';
  const rows = parseBlindCsv(csv);
  assert(rows.length === 4, '解析 4 行');
  assert(rows[0].choice === 'A' && rows[0].correct === true, 'A/true 解析');
  assert(rows[1].correct === false, 'B/false 解析');
  assert(rows[2].choice === 'NONE', 'none 归一化');
  assert(rows[3].correct === true, '1 → true');
  assert(parseBlindCsv('无表头\n').length === 0, '空/无表头兜底');
  console.log('PASS 盲评 CSV 解析');
}

// 6) 配对置换检验：方法 A 明显更好 → p 小；完全一致 → p=1
{
  const truth = ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'];
  const good = [...truth];
  const bad = truth.map((x) => (x === 'a' ? 'b' : 'a'));
  const r = permutationTestPaired(good, bad, truth);
  assert(r.accA === 1 && r.accB === 0, `准确率正确（${r.accA}/${r.accB}）`);
  assert(r.pValue < 0.01, '明显差异显著');
  const same = permutationTestPaired(good, good, truth);
  assert(same.pValue === 1 && same.diff === 0, '一致 → p=1、差 0');
  const half = permutationTestPaired(['a', 'b', 'a', 'b'], ['a', 'b', 'b', 'a'], ['a', 'b', 'a', 'b']);
  assert(half.discordant === 2 && half.pValue >= 0.5, `2/2 不一致但样本过小 → p 不显著（${half.pValue}）`);
  console.log('PASS 配对置换检验');
}

console.log('\n✓ stats.test.mjs 全部通过');
