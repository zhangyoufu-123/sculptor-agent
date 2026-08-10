// v0.24 实验引擎单测：人类化指标 / 语料采集 / 对照实验 / 消融 / 问卷（离线 mock LLM）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import {
  humanMetrics,
  renderHumanMetrics,
  collectAuthorCorpus,
  corpusStats,
  baselineText,
  sculptorVariant,
  runPairExperiment,
  runAblation,
  userSurveyTemplate,
  buildExperimentReport,
  renderBlindSurvey,
  summarizeResults,
} from '../src/experiment.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

// 离线 mock LLM：按提示词区分对照组/实验组，返回固定但不同的文本
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const msg = (body.messages || []).map((m) => m.content || '').join('\n');
  const isBaseline = msg.includes('【题目】') && !msg.includes('作者语言风格档案');
  const content = isBaseline
    ? '在当今社会，AI 技术不断发展，我们应该重视这个问题。总而言之，人工智能带来了机遇和挑战。'
    : '石阶被磨亮了一百年，我蹲下来，手指按进砖缝。风从门里出来，带着木头的旧气。门卫多看了我两眼。'
  ;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
  };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-exp-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });
const cfg = { apiKey: 'mock', baseURL: 'http://mock', model: 'mock' };

// ── 人类化指标 ──────────────────────────────────────────
const aiText =
  '在当今社会，随着科技的发展，人们越来越重视这个问题。在当今社会，随着科技的发展，人们越来越重视这个问题。众所周知，人工智能赋能各行各业。总而言之，这是一个重要的话题。';
const humanText = '石阶被磨亮了一百年。我蹲下来，手指按进砖缝，砖缝里嵌着砂砾和一片干枯的槐叶。风从门里出来，带着木头的旧气。';
const mAI = humanMetrics(aiText);
const mHuman = humanMetrics(humanText);
check('指标可计算', mAI.bigramTtr > 0 && typeof mAI.perplexity === 'number');
check(
  'AI 腔文本被识别（黑名单命中 + 重复导致 TTR 低于真人）',
  mAI.blacklistHits >= 2 && mAI.bigramTtr < mHuman.bigramTtr,
  `AI黑名单=${mAI.blacklistHits} TTR=${mAI.bigramTtr} vs 人=${mHuman.bigramTtr}`,
);
check('指标可渲染', renderHumanMetrics(mHuman).includes('句长标准差'));

// ── 语料采集 ────────────────────────────────────────────
fs.mkdirSync(path.join(wsDir, 'vault', 'style-samples'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'vault', 'style-samples', 's1.md'), '我的旧稿样本，三百字以上才有效，这里先放一段代表风格。\n');
fs.appendFileSync(path.join(wsDir, 'vault', 'edits.jsonl'), JSON.stringify({ original: '总而言之', changed: '回头看', reason: '去AI腔' }) + '\n');
fs.appendFileSync(path.join(wsDir, 'protocol', 'context.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'user', summary: '我想写一篇关于红楼的散文 → 我在门口站了很久' }) + '\n');
const corpus = collectAuthorCorpus(wsDir);
const stats = corpusStats(corpus);
check('语料包采集（样本/修改/话语）', stats.samples >= 1 && stats.edits >= 1 && stats.utterances >= 1, JSON.stringify(stats));

// ── 对照组 / 实验组 ────────────────────────────────────
const b = await baselineText(cfg, { topic: '百年历久，北大红楼', targetWords: 200 });
check('对照组生成', b.ok === true && b.text.length > 0);
const v = await sculptorVariant(cfg, { topic: '百年历久，北大红楼', targetWords: 200, sample: humanText });
check('实验组（风格注入）生成', v.ok === true && v.text.length > 0);
const vNoKey = await sculptorVariant({ apiKey: '' }, { topic: 'x', sample: humanText });
check('无密钥确定性降级', vNoKey.ok === false && vNoKey.skipped === true);

// ── 对照实验批跑 ────────────────────────────────────────
const run = await runPairExperiment(cfg, {
  topic: '百年历久，北大红楼',
  genre: '散文',
  targetWords: 200,
  authors: [
    { name: '作者A', sample: humanText },
    { name: '作者B', sample: humanText },
  ],
  workspace: wsDir,
});
check('对照实验跑完 2 位作者', run.ok === true && run.results.length === 2);
check('盲评对已生成且 A/B 有顺序', run.blind.length === 2 && run.blind[0].A && run.blind[0].B);
check('报告含指标对比表', run.report.includes('| 指标 |') && run.report.includes('逐作者明细'));
check('结果文件落盘', fs.existsSync(path.join(run.dir, 'results.json')) && fs.existsSync(path.join(run.dir, 'blind.json')) && fs.existsSync(path.join(run.dir, 'report.md')));
check('报告可独立生成', buildExperimentReport(run.results).includes('样本数'));

// ── 消融实验 ────────────────────────────────────────────
const abl = await runAblation(cfg, { topic: '百年历久，北大红楼', sample: humanText, targetWords: 200, workspace: wsDir });
check('消融生成 5 个变体', abl.ok === true && abl.variants.length === 5);
check('消融各变体有指标', abl.variants.every((x) => x.metrics));

// ── 问卷模板 ────────────────────────────────────────────
const survey = userSurveyTemplate();
check('问卷含盲评与用户体验', survey.sections.length === 2 && survey.sections[1].items.some((i) => i.key === 'ai_feel'));

// ── 盲评问卷导出与结果汇总 ──────────────────────────────
const blindMd = renderBlindSurvey(run.blind);
check('盲评问卷一页导出', blindMd.includes('第 1 组') && blindMd.includes('更像作者本人') && blindMd.includes('盲评人'));
const answers = run.blind.map((p, i) => ({ pairIndex: i, choice: 'A' }));
const summary = summarizeResults(run.results, answers);
check('汇总含客观指标表', summary.includes('客观人类化指标') && summary.includes('baseline 均值'));
check('汇总含盲评统计', summary.includes('盲评结果') && summary.includes('二项检验'));
const summaryNoAnswers = summarizeResults(run.results);
check('无答案时给出占位说明', summaryNoAnswers.includes('尚未回填答案'));

delete globalThis.fetch;
console.log(`\n${failures === 0 ? '✓ 实验引擎测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
