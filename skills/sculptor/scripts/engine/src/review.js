// 深度审阅（Review）：把"红队审计 + 校对 + 事实核查 + 原创性 + 风格保真 + 读者群像/交锋"
// 合成一份可执行的审阅报告（P0 硬伤 / P1 建议 / P2 争议 / 亮点），并支持 --fix 一键修复 P0。
// 定位：交付前的静默质量门是"自动兜底"，review 是用户主动触发的"深度体检 + 修复"。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';
import { audit, redteam } from './redteam.js';
import { proofScan } from './proofread.js';
import { factScan } from './fact-check.js';
import { originalityScan } from './originality.js';
import { evaluateStyleFidelity } from './style-eval.js';
import { runAudience, runDebate } from './reader-gallery.js';
import { restyle } from './restyle.js';
import { chatWithRetry } from './llm.js';
import { REDTEAM_FIX_PROMPT } from './prompts.js';

/**
 * 深度审阅主入口。
 * @param fix 自动修复 P0（红队 LLM 修订；风格保真低分时按建议 restyle 一轮），随后复检。
 * @param quick 跳过读者群像/交锋（只做确定性 + 风格保真）。
 */
export async function runReview(cfg, wsDir, { file = null, fix = false, quick = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) throw new Error(`找不到要审阅的文稿: ${draftFile}`);
  let state = {};
  try {
    state = ws.readState(workspace);
  } catch {}
  const readText = () => fs.readFileSync(draftFile, 'utf8');
  let text = readText();

  // 1) 确定性层
  let auditReport = audit(text);
  const proof = proofScan(text);
  const fact = factScan(text, state.materials || []);
  const ori = originalityScan(text, workspace);

  // 2) 风格保真（LLM，apiKey 守卫）
  let styleEval = null;
  if (cfg.apiKey) {
    try {
      styleEval = await evaluateStyleFidelity(cfg, workspace, { file: draftFile });
    } catch {}
  }

  // 3) 读者群像 + 交锋（LLM，apiKey 守卫；--quick 跳过）
  let debate = null;
  let audience = null;
  if (!quick && cfg.apiKey) {
    try {
      audience = await runAudience(cfg, workspace, { file: draftFile });
      debate = await runDebate(cfg, workspace, { file: draftFile, reactions: audience.personas });
    } catch {}
  }

  // 4) 自动修复 P0（可选）
  let fixed = false;
  if (fix) {
    const before = auditReport;
    const hasHard = before.blacklistHits.length + before.repeatedMetaphors.length + before.repeatedPatterns.length > 0;
    if (hasHard && cfg.apiKey) {
      if (file) {
        // 外部文件：直接按问题 LLM 修订并写回目标文件（文件感知）。
        const issues = [
          ...before.blacklistHits.map((h) => `黑名单「${h.phrase}」`),
          ...before.repeatedMetaphors.map((m) => `重复比喻「${m.vehicle}」`),
          ...before.repeatedPatterns.map((p) => `重复句式「${p.pattern}」`),
        ].join('；');
        const fixedText = await chatWithRetry(
          cfg,
          [
            { role: 'system', content: '你是修订者，用用户风格改写有 AI 痕迹的片段。' },
            { role: 'user', content: REDTEAM_FIX_PROMPT({ issues, text, writeStyle: '', styleShot: null }) },
          ],
          { temperature: 0.7, maxTokens: 6000 },
        );
        fs.writeFileSync(draftFile, fixedText.trim() + '\n');
        auditReport = audit(fs.readFileSync(draftFile, 'utf8'));
      } else {
        const rr = await redteam(cfg, workspace, { fix: true });
        auditReport = rr.report;
      }
      fixed = true;
      text = readText();
    }
    if (styleEval?.needsFix && cfg.apiKey) {
      const dir = (styleEval.advice || []).join('；') || '更贴合作者风格';
      try {
        await restyle(cfg, workspace, { direction: dir });
        fixed = true;
        text = readText();
        auditReport = audit(text);
      } catch {}
    }
    if (fixed) {
      // 复检确定性层
      proof.items = proofScan(text).items;
      fact.items = factScan(text, state.materials || []).items;
      const o2 = originalityScan(text, workspace);
      ori.selfDuplicates = o2.selfDuplicates;
      ori.libraryOverlaps = o2.libraryOverlaps;
      ori.templateHits = o2.templateHits;
      ori.total = o2.total;
      ori.risk = o2.risk;
    }
  }

  const p0 = [
    ...auditReport.blacklistHits.map((h) => ({ type: 'AI 套话', at: h.phrase, issue: `黑名单「${h.phrase}」` })),
    ...auditReport.repeatedMetaphors.map((m) => ({ type: '重复比喻', at: m.vehicle, issue: `「${m.vehicle}」出现 ${m.count} 次` })),
    ...auditReport.repeatedPatterns.map((p) => ({ type: '重复句式', at: p.pattern, issue: `「${p.pattern}」出现 ${p.count} 次` })),
    ...(styleEval?.needsFix ? [{ type: '风格保真', at: '', issue: `保真度低于阈值（${(styleEval.score * 100).toFixed(0)} 分）` }] : []),
  ];
  const p1 = [
    ...proof.items.slice(0, 6).map((i) => ({ type: '校对', at: i.text, issue: i.issue })),
    ...fact.items
      .filter((i) => i.supported === 'verify')
      .slice(0, 4)
      .map((i) => ({ type: '事实核查', at: i.text, issue: '交付前需核对' })),
    ...ori.selfDuplicates.map((s) => ({ type: '文内重复', at: s.slice(0, 20), issue: '句子重复出现' })),
    ...ori.templateHits.map((t) => ({ type: '模板句', at: t, issue: '疑似通用范文句' })),
    ...(debate?.consensus || []).map((c) => ({ type: '读者共识', at: c.quote || '', issue: c.point })),
  ].slice(0, 12);
  const p2 = (debate?.disputes || []).slice(0, 4).map((d) => ({ type: '读者争议', at: d.topic, issue: d.views?.join(' / ') }));
  const highlights = [
    ...(debate?.exchanges || []).map((e) => `${e.persona}：${e.reply}`),
    ...(audience?.personas || [])
      .map((p) => `${p.persona}：${p.impression || ''}`)
      .filter((s) => s.length > 4)
      .slice(0, 3),
  ].slice(0, 6);
  const report = {
    file: draftFile,
    ts: ws.nowIso(),
    passed: p0.length === 0,
    fixed,
    styleScore: styleEval?.score ?? null,
    p0,
    p1,
    p2,
    highlights,
    metrics: auditReport.metrics,
    mode: {
      audience: Boolean(audience),
      debate: Boolean(debate),
      styleEval: Boolean(styleEval),
    },
  };
  const outFile = path.join(workspace, 'vault', 'project-memory', `review-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  ws.logContext(
    workspace,
    'review',
    `深度审阅：P0 ${p0.length} / P1 ${p1.length} / P2 ${p2.length}${fixed ? '，已自动修复' : ''}`,
  );
  return { report, outFile };
}

/** 人类可读审阅面板。 */
export function renderReview(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 深度审阅 · 红队 + 读者 + 风格 + 事实', line);
  out.push(
    `结论: ${report.passed ? '✓ 通过（无 P0 硬伤）' : `✗ ${report.p0.length} 项 P0 硬伤`}${report.fixed ? '（已自动修复）' : ''}`,
  );
  if (report.styleScore !== null) out.push(`风格保真: ${(report.styleScore * 100).toFixed(0)} 分`);
  const push = (label, items) => {
    if (!items?.length) return;
    out.push(label);
    for (const i of items.slice(0, 8))
      out.push(`  · [${i.type}]${i.at ? `「${i.at}」` : ''} ${i.issue}`);
  };
  push('P0 · 必须处理:', report.p0);
  push('P1 · 建议:', report.p1);
  push('P2 · 作者拍板:', report.p2);
  if (report.highlights?.length) {
    out.push('读者亮点:');
    for (const h of report.highlights.slice(0, 4)) out.push(`  · ${h}`);
  }
  if (report.metrics) {
    out.push(
      `指标: 句长σ ${report.metrics.sentenceLengthStddev} · 段落CV ${report.metrics.paragraphCv} · 句首去重 ${report.metrics.sentenceStartDedup}% · TTR ${report.metrics.bigramTtr}`,
    );
  }
  out.push(line);
  return out.join('\n');
}
