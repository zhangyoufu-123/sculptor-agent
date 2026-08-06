// Phase 4 红队审计：确定性反 AI 检查（黑名单/重复比喻/重复句式/统计指标）+ 可选 LLM 修订。
import fs from 'node:fs';
import { chatWithRetry } from './llm.js';
import { REDTEAM_FIX_PROMPT } from './prompts.js';
import * as ws from './workspace.js';

export const BLACKLIST = [
  '在当今社会',
  '在当今时代',
  '在当今世界',
  '随着社会的发展',
  '随着时代的发展',
  '随着科技的发展',
  '近年来',
  '众所周知',
  '毋庸置疑',
  '不可否认',
  '我们生活在一个',
  '这是一个最好的时代',
  '想象一下',
  '让我们想象',
  '让我们来看',
  '值得注意的是',
  '值得关注的是',
  '需要指出的是',
  '值得一提的是',
  '不难看出',
  '不难发现',
  '显而易见',
  '由此可见',
  '我们可以发现',
  '我们可以看到',
  '事实上',
  '实际上',
  '与此同时',
  '综上所述',
  '总而言之',
  '总的来说',
  '无独有偶',
  '底层逻辑',
  '顶层设计',
  '赋能',
  '抓手',
  '闭环',
  '颗粒度',
  '组合拳',
  '护城河',
  '降维打击',
  '认知升维',
  '思维模型',
];

const SENT_SPLIT = /[。！？.!?]+/;

function sentences(text) {
  return text
    .split(SENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function paragraphs(text) {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function audit(text) {
  const report = {
    blacklistHits: [],
    repeatedMetaphors: [],
    repeatedPatterns: [],
    metrics: {},
    passed: true,
    suggestions: [],
  };
  const all = paragraphs(text).join('\n');

  for (const phrase of BLACKLIST) {
    let idx = 0;
    while ((idx = all.indexOf(phrase, idx)) !== -1) {
      report.blacklistHits.push({
        phrase,
        context: all.slice(Math.max(0, idx - 20), idx + phrase.length + 20),
      });
      idx += phrase.length;
    }
  }

  // 重复比喻：提取 像/如同/仿佛 X 的喻体，跨句重复即标记
  const vehicles = {};
  for (const s of sentences(all)) {
    for (const m of s.matchAll(/(?:像|如同|仿佛)([^，。；、！？]{2,14})/g)) {
      let v = m[1].trim().replace(/(一样|般|似的).*$/, '');
      if (v.length > 4) v = v.slice(0, 4); // 归一化"X一样…"与"X踏过…"为同一喻体
      if (!v) continue;
      vehicles[v] = vehicles[v] || { count: 0, sentences: [] };
      vehicles[v].count += 1;
      if (vehicles[v].sentences.length < 2) vehicles[v].sentences.push(s.slice(0, 40));
    }
  }
  for (const [v, info] of Object.entries(vehicles)) {
    if (info.count > 1)
      report.repeatedMetaphors.push({ vehicle: v, count: info.count, sentences: info.sentences });
  }

  // 重复句式
  for (const [name, re] of [
    ['虽然…但是…', /虽然[^。！？]{2,40}但是/g],
    ['不是…而是…', /不是[^。！？]{2,40}而是/g],
    ['因为…所以…', /因为[^。！？]{2,40}所以/g],
  ]) {
    const hits = all.match(re) || [];
    if (hits.length > 1) report.repeatedPatterns.push({ pattern: name, count: hits.length });
  }

  // 统计指标
  const ss = sentences(all);
  const lens = ss.map((s) => [...s].length);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const stddev = Math.sqrt(
    lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length),
  );
  const plens = paragraphs(all).map((p) => [...p].length);
  const pmean = plens.reduce((a, b) => a + b, 0) / Math.max(1, plens.length);
  const pcv =
    Math.sqrt(plens.reduce((a, b) => a + (b - pmean) ** 2, 0) / Math.max(1, plens.length)) /
    Math.max(1, pmean);
  const starts = new Set(ss.map((s) => s.slice(0, 2)));
  const startDedup = ss.length ? starts.size / ss.length : 1;
  const bigrams = new Map();
  const chars = all.replace(/[\s，。！？、；：""''（）]/g, '');
  for (let i = 0; i < chars.length - 1; i++) {
    const bg = chars.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  const ttr = bigrams.size / Math.max(1, chars.length - 1);
  const dashCount = (all.match(/——/g) || []).length;

  report.metrics = {
    sentenceLengthStddev: Number(stddev.toFixed(1)),
    paragraphCv: Number(pcv.toFixed(2)),
    sentenceStartDedup: Number((startDedup * 100).toFixed(0)),
    bigramTtr: Number(ttr.toFixed(2)),
    dashPerThousand: Number(((dashCount * 1000) / Math.max(1, chars.length)).toFixed(1)),
  };
  if (report.metrics.sentenceLengthStddev < 8)
    report.suggestions.push('句长标准差 < 8，节奏偏平，拆长句/合并碎句');
  if (report.metrics.paragraphCv < 0.35)
    report.suggestions.push('段落长度变异系数 < 0.35，段落等长，调整长短错落');
  if (report.metrics.sentenceStartDedup < 75)
    report.suggestions.push(`句首去重率 ${report.metrics.sentenceStartDedup}% < 75%，句首太重复`);
  if (report.metrics.bigramTtr < 0.7) report.suggestions.push('词汇二元 TTR < 0.7，用词重复偏高');

  report.passed =
    report.blacklistHits.length === 0 &&
    report.repeatedMetaphors.length === 0 &&
    report.repeatedPatterns.length === 0 &&
    report.suggestions.length === 0;
  return report;
}

function collectIssues(report) {
  const issues = [];
  for (const h of report.blacklistHits) issues.push(`黑名单「${h.phrase}」`);
  for (const m of report.repeatedMetaphors)
    issues.push(`重复比喻「像${m.vehicle}」（${m.count}次）`);
  for (const p of report.repeatedPatterns) issues.push(`重复句式「${p.pattern}」（${p.count}次）`);
  return issues.join('；');
}

export async function redteam(cfg, wsDir, { fix = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = `${workspace}/draft.md`;
  if (!fs.existsSync(draftFile)) throw new Error('没有 draft.md，先运行 sculptor write');
  const writeStyle = JSON.stringify(
    ws.readJson(`${workspace}/vault/write-style.json`).dimensions || {},
    null,
    0,
  ).slice(0, 800);
  let text = fs.readFileSync(draftFile, 'utf8');
  let report = audit(text);

  if (fix && !report.passed) {
    const issues = collectIssues(report);
    const fixed = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是修订者，用用户风格改写有 AI 痕迹的片段。' },
        { role: 'user', content: REDTEAM_FIX_PROMPT({ issues, text, writeStyle }) },
      ],
      { temperature: 0.7, maxTokens: 6000 },
    );
    fs.writeFileSync(draftFile, fixed.trim() + '\n');
    text = fs.readFileSync(draftFile, 'utf8');
    report = audit(text);
    report.fixedBy = 'llm';
  }
  ws.logContext(
    workspace,
    'redteam',
    `审计: 黑名单 ${report.blacklistHits.length}、重复比喻 ${report.repeatedMetaphors.length}、句式 ${report.repeatedPatterns.length}、通过=${report.passed}`,
  );
  return { report, draftFile };
}
