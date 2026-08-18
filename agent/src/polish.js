// polish.js — 质量自动循环（吸纳 Reflection/Critic 模式 + Humanizer"检测即修复"）
//
// 成稿后自动跑质量门：humanizationScore（AI 味评分）+ 红队硬伤，
// 不达标 → 按作者风格整篇人性化重写 → 复检，最多 N 轮。
// 这是"对抗检测作为质量指标 → 自动触发修复"的落地：分数说了算，循环自动收敛。
//
// 设计：
//   1) 确定性审计（audit）先打分——0 成本、可复现；
//   2) LLM 可用时整篇 humanize（带个人风格档案，非通用去 AI 味）；
//   3) LLM 不可用时不空转——报告分数与剩余问题，绝不崩；
//   4) 退让协议：draft 被外部修改过则停下让路（除非 force）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ws from './workspace.js';
import { audit } from './redteam.js';
import { chatWithRetry } from './llm.js';
import { snapshot } from './history.js';

/** 循环收敛阈值：humanizationScore 低于此值即继续重写。 */
const DEFAULT_THRESHOLD = 60;

const HUMANIZE_PROMPT = (ctx) => `你是 Stylotrace 的"人性化修订官"。把下面的文稿整篇去 AI 味，
目标是让它"像这个作者本人写的"，而不是通用范文。

做法（Humanizer 策略，但按作者风格收束）：
1. 打破套话与模板：删"在当今社会/总而言之/众所周知/值得注意的是"等，换自然的进入方式；
2. 句长故意错落：长句拆开、碎句合并，制造节奏起伏（burstiness）；
3. 拆掉排比/对仗/路标式转折的套路（"首先…其次…最后…"、"是…是…是…"）；
4. 连接词自然化：把"因此/然而/此外"换成作者会用的过渡；
5. 在合适处注入具体、个人化的细节与口语质感（不虚构事实）；
6. 最终按作者的写作风格档案收束（句式/语气/用词习惯）。
${ctx.writeStyle ? `\n【作者写作风格档案】\n${ctx.writeStyle}` : ''}
${ctx.styleShot ? `\n【风格记忆】\n${ctx.styleShot}` : ''}

硬性要求：
- 保留立意、论点、素材与关键事实/引文，不增删事实；
- 黑名单禁用：在当今社会/随着/近年来/众所周知/值得注意的是/总而言之/赋能 等一律不用；
- 同一比喻只出现一次；
- 只输出改写后的全文，不要标题、不要解释、不要前言。

【原文】
${ctx.text}`;

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** 读风格简报（与 write.js 同源）。 */
function styleBrief(workspace) {
  const writeFile = path.join(workspace, 'vault', 'write-style.json');
  try {
    const d = JSON.parse(fs.readFileSync(writeFile, 'utf8'));
    const dims = d.dimensions || d;
    const entries = Array.isArray(dims)
      ? dims
      : Object.entries(dims || {}).map(([k, v]) => ({ key: k, ...(typeof v === 'object' ? v : { value: v }) }));
    const lines = entries
      .filter((x) => x && (x.confidence || 0) >= 0.3)
      .slice(0, 10)
      .map((x) => `- ${x.key}: ${x.value ?? x.label ?? ''}${x.confidence ? `（置信 ${Math.round(x.confidence * 100)}%）` : ''}`);
    return lines.length ? lines.join('\n') : '';
  } catch {
    return '';
  }
}

/** 整篇人性化（LLM 主路径）。 */
async function humanizeFull(cfg, text, workspace) {
  const writeStyle = styleBrief(workspace);
  const r = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是写作风格执行器：先读懂作者，再动手。' },
      { role: 'user', content: HUMANIZE_PROMPT({ text, writeStyle, styleShot: '' }) },
    ],
    { maxTokens: 6000, temperature: 0.7 },
  );
  return r.trim();
}

/**
 * 质量自动循环。
 * @param cfg 引擎配置（LLM）
 * @param wsDir 工作区
 * @param opts { maxRounds=3, threshold=60, force=false }
 * @returns { rounds, converged, log:[{round,score,blacklist,structural}], final, llmUsed }
 */
export async function polishLoop(cfg, wsDir, opts = {}) {
  const { maxRounds = 3, threshold = DEFAULT_THRESHOLD, force = false } = opts;
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) throw new Error('没有 draft.md，先运行 stylotrace write');

  const state = ws.readState(workspace);
  let text = fs.readFileSync(draftFile, 'utf8');
  // 退让协议：draft 被外部改过 → 停下让路
  if (state.lastDraftHash && fileHash(text) !== state.lastDraftHash && !force) {
    throw new Error('draft.md 在最后一次写作后被外部修改过，Stylotrace 已退让、不覆盖。确认要重写请用 --force');
  }

  const log = [];
  let report = audit(text);
  log.push({ round: 0, score: report.humanizationScore, blacklist: report.blacklistHits.length, structural: (report.structuralSignals || []).length });

  let round = 0;
  let llmUsed = false;
  const need = () => report.humanizationScore < threshold || report.blacklistHits.length > 0;

  while (round < maxRounds && need()) {
    if (!cfg.apiKey) break; // 无 LLM：只报告，不空转
    round++;
    llmUsed = true;
    snapshot(workspace, `polish-r${round}`);
    text = await humanizeFull(cfg, text, workspace);
    if (!text) break;
    fs.writeFileSync(draftFile, text, 'utf8');
    // 写回后更新 state 哈希，避免下次误判"外部修改"
    state.lastDraftHash = fileHash(text);
    ws.writeState(workspace, state);
    report = audit(text);
    log.push({ round, score: report.humanizationScore, blacklist: report.blacklistHits.length, structural: (report.structuralSignals || []).length });
  }

  return {
    rounds: round,
    converged: !need(),
    log,
    final: {
      score: report.humanizationScore,
      blacklist: report.blacklistHits.length,
      structural: (report.structuralSignals || []).length,
      passed: report.passed,
    },
    llmUsed,
    draftFile,
  };
}

export const POLISH_RENDER = (r) => {
  const lines = [
    `质量自动循环: ${r.rounds} 轮${r.llmUsed ? '（LLM 人性化重写）' : '（无 LLM,仅报告）'}${r.converged ? ' ✓ 收敛' : ' ⚠ 未完全收敛'}`,
    ...r.log.map((l) => `  第 ${l.round} 轮: 人类化指数 ${l.score}/100 · 黑名单 ${l.blacklist} · 结构痕迹 ${l.structural}`),
    `最终: 人类化指数 ${r.final.score}/100 · 黑名单 ${r.final.blacklist} · 结构痕迹 ${r.final.structural}`,
    `产物: ${r.draftFile}`,
  ];
  return lines.join('\n');
};
