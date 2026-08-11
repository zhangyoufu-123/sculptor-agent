// v0.41 单测：三线节奏曲线 + 伏笔记账/跨章回收 + 隐式风格信号流水。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import { rhythmCurve, renderRhythmCurve } from '../src/style-pulse.js';
import {
  registerClues,
  checkConsistency,
  renderConsistency,
  extractClueCandidates,
} from '../src/consistency.js';
import { recordImplicitSignals, implicitSignalLog } from '../src/style.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-v41-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });
const state = ws.readState(wsDir);
state.confirmed = { topic: '雾镇疑云', genre: '小说' };
state.outline = {
  title: '雾镇疑云',
  sections: [
    { heading: '一、雨夜', function: '铺垫', words: 400 },
    { heading: '二、旧宅', function: '转折', words: 400 },
    { heading: '三、真相', function: '收束', words: 400 },
  ],
};
ws.writeState(wsDir, state);

// ── 三线节奏曲线 ────────────────────────────────────────
fs.writeFileSync(
  path.join(wsDir, 'draft.md'),
  '## 一、雨夜\n雨把小镇洗得很干净。她突然停住，脚步声在身后逼近，那把生锈的钥匙却再也找不到。\n' +
    '## 二、旧宅\n旧宅的门吱呀打开，钥匙竟插在锁孔里。她笑了，窗外的光暖起来。\n' +
    '## 三、真相\n钥匙转动的瞬间，她终于明白，那场雨早就埋下了答案。\n',
);
const cv = rhythmCurve(wsDir);
check('节奏曲线按节输出', cv.sections.length === 3);
check(
  '节奏曲线四维 0-100',
  cv.sections.every(
    (s) =>
      s.tension >= 0 && s.tension <= 100 &&
      s.density >= 0 && s.density <= 100 &&
      s.emotion >= 0 && s.emotion <= 100 &&
      s.pacing >= 0 && s.pacing <= 100,
  ),
  JSON.stringify(cv.sections),
);
check('张力首节高于末节（悬念铺垫 > 收束）', cv.sections[0].tension >= cv.sections[2].tension);
check('曲线落盘 vault/curve.md', cv.file && fs.existsSync(cv.file));
check('曲线可渲染', renderRhythmCurve(cv).includes('一、雨夜') && renderRhythmCurve(cv).includes('张力'));

// ── 伏笔记账（无密钥 → 确定性兜底）────────────────────
const det = extractClueCandidates('她突然停住，那把生锈的钥匙却再也找不到。雨声还在继续。');
check('确定性伏笔候选命中长句', det.some((s) => s.includes('钥匙')));
const rc1 = await registerClues({ apiKey: '' }, wsDir, {
  text: '她突然停住，那把生锈的钥匙却再也找不到。',
  heading: '一、雨夜',
  sectionIndex: 0,
});
check('伏笔记账新增', rc1.added >= 1 && rc1.clues.length >= 1);
// 模拟 write.js 的落盘行为：调用方把合并结果写回 state
const st1 = ws.readState(wsDir);
st1.mystery = st1.mystery || {};
st1.mystery.clues = rc1.clues;
ws.writeState(wsDir, st1);
const rc2 = await registerClues({ apiKey: '' }, wsDir, {
  text: '她突然停住，那把生锈的钥匙却再也找不到。',
  heading: '一、雨夜',
  sectionIndex: 0,
});
check('伏笔去重不重复记账', rc2.added === 0 && rc2.clues.length === rc1.clues.length);
const st2 = ws.readState(wsDir);
check('伏笔已并入 state', (st2.mystery?.clues || []).length === rc1.clues.length);

// ── 跨章回收校验 ────────────────────────────────────────
const cc = await checkConsistency({ apiKey: '' }, wsDir);
check('一致性校验跑通（确定性）', cc.total >= 1 && cc.file);
check(
  '已回收伏笔被识别',
  cc.recovered.some((i) => i.clue.includes('钥匙')),
  renderConsistency(cc),
);
// 加一条明显未回收的伏笔
const st3 = ws.readState(wsDir);
st3.mystery = st3.mystery || {};
st3.mystery.clues = [
  ...(st3.mystery.clues || []),
  { id: 'clue-ghost', clue: '阁楼里的那封信却一直没有寄出去', plantedSection: '一、雨夜', index: 0, plantedAt: ws.nowIso(), recovered: false },
];
ws.writeState(wsDir, st3);
const cc2 = await checkConsistency({ apiKey: '' }, wsDir);
check('悬空伏笔被标出', cc2.unrecovered.some((i) => i.clue.includes('那封信')));
check('一致性得分下降', cc2.score < 100, `score=${cc2.score}`);
check('quality.consistency 已写入', ws.readState(wsDir).quality?.consistency?.total >= 1);

// ── 隐式风格信号流水 ────────────────────────────────────
const sig = recordImplicitSignals(wsDir, '其实我觉得特别难过，那天银杏落了一地，像在告别。');
check('隐式信号记录返回', sig && sig.dims.length >= 1, JSON.stringify(sig));
const log = implicitSignalLog(wsDir);
check('隐式信号可回看', log.length === 1 && log[0].round === 1);
check('隐式信号卡片落盘', fs.existsSync(path.join(wsDir, 'vault', 'style-signals.md')));
check(
  '隐式信号卡片可读',
  fs.readFileSync(path.join(wsDir, 'vault', 'style-signals.md'), 'utf8').includes('银杏'),
);

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\nconsistency.test.mjs 全部通过');
