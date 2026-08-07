// 大纲评审-修订回路（CogWriter / WriteHERE 的"规划→评审→重规划"思路）：
// 大纲生成后不自满，先按六条硬标准评审——立意贯穿、论点-功能匹配、逻辑递进、
// 素材利用、篇幅分配、文体规范；低分且有 LLM 修订版时自动替换（用户仍需最终确认）。
// LLM 失败时用确定性检查兜底（只报告、不擅自改大纲），保证流程永不因评审而中断。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { genreBrief } from './genre.js';

const REVIEW_SCORE_OK = 0.75; // LLM 评分低于此且给出修订版 → 自动采用修订版

const GENRE_SECTION_RANGE = {
  演讲稿: [4, 6],
  散文: [3, 5],
  报告: [5, 8],
  议论文: [4, 6],
  记叙文: [3, 5],
  公文: [4, 7],
  合同: [8, 12],
};

/** 确定性评审：只报告问题，不改大纲。 */
function deterministicReview(outline, ctx) {
  const issues = [];
  const strengths = [];
  const sections = outline.sections || [];
  const target = Number(ctx.targetWords || 0);
  const total = sections.reduce((s, x) => s + Number(x.words || 0), 0);
  if (!sections.length) issues.push({ severity: 'high', target: '大纲', issue: '没有 sections' });
  if (!outline.title) issues.push({ severity: 'mid', target: '标题', issue: '缺少标题' });
  const range = GENRE_SECTION_RANGE[ctx.genre] || [3, 7];
  if (sections.length && (sections.length < range[0] || sections.length > range[1])) {
    issues.push({
      severity: 'mid',
      target: '节数',
      issue: `${ctx.genre || '该'}文体通常 ${range[0]}-${range[1]} 节，当前 ${sections.length} 节`,
    });
  }
  if (sections.length) {
    const noThesis = sections.filter((s) => !s.thesis).length;
    if (noThesis) {
      issues.push({
        severity: 'high',
        target: '论点挂载',
        issue: `${noThesis} 节没有挂论点（thesis）`,
      });
    }
    const noPoints = sections.filter((s) => !(s.keyPoints || []).length).length;
    if (noPoints)
      issues.push({ severity: 'mid', target: '要点', issue: `${noPoints} 节没有 keyPoints` });
    const dup = new Set();
    let dupHits = 0;
    for (const s of sections) {
      if (dup.has(s.heading)) dupHits += 1;
      dup.add(s.heading);
    }
    if (dupHits) issues.push({ severity: 'mid', target: '结构', issue: '存在重复的节标题' });
    const funcs = sections.map((s) => s.function || '').filter(Boolean);
    if (new Set(funcs).size < Math.max(2, sections.length * 0.5))
      issues.push({
        severity: 'mid',
        target: '功能',
        issue: '节的功能单一化，缺少铺垫/转折/升华等层次',
      });
  }
  if (target > 0 && total > 0 && Math.abs(total - target) / target > 0.25) {
    issues.push({
      severity: 'mid',
      target: '篇幅',
      issue: `各节字数合计 ${total}，与目标 ${target} 偏差超过 25%`,
    });
  }
  if (!issues.length) strengths.push('结构完整、论点挂载齐、篇幅分配合理');
  else strengths.push('骨架可用，按评审意见微调即可');
  const score = Math.max(
    0.15,
    1 - issues.reduce((s, x) => s + (x.severity === 'high' ? 0.28 : 0.12), 0),
  );
  return {
    score: Number(score.toFixed(2)),
    strengths,
    issues: issues.slice(0, 6),
    revisedOutline: null,
    mode: 'fallback',
  };
}

function reviewPromptArgs(ctx) {
  const argLines = (ctx.arguments || []).map((a, i) => `${i + 1}. ${a}`).join('\n') || '未明确';
  const materialLines = (ctx.materials || []).map((m) => `- ${m}`).join('\n');
  const corrections = ctx.corrections?.length ? `【用户修正意见】${ctx.corrections.join('；')}` : '';
  const gb = ctx.genreBrief ? `【文体范式】\n${ctx.genreBrief}` : '';
  return `你是 Sculptor 的大纲评审师（CogWriter 式规划-评审-重规划）。用户已确认主题、立意、论点与素材，下面是你评审对象——一份待确认的大纲。

【主题】${ctx.topic}
【核心立意】${ctx.theme || '未明确'}
【支撑论点】${argLines}
【素材】${materialLines}
${corrections}
${gb}
【目标字数】${ctx.targetWords} 字

【大纲】
${JSON.stringify(ctx.outline, null, 2)}

评审标准（按严重程度给分）：
1. 立意贯穿：每一节是否都在推进核心立意，有没有空转/跑题节。
2. 论点-功能匹配：每节挂的论点是否与节功能一致（铺垫节不能挂结论性论点）。
3. 逻辑递进：节与节是推进关系还是并列堆叠；转折与升华是否有着落。
4. 素材利用：用户给的素材是否被分配到具体节（materials 字段），有没有素材闲置。
5. 篇幅分配：各节 words 合计是否接近目标，重点节是否给了更大篇幅。
6. 文体规范：节数与行文是否符合该文体范式。

输出严格 JSON：
{"score":0.72,"strengths":[""],"issues":[{"severity":"high|mid|low","target":"第2节/结构/篇幅","issue":"具体问题"}],"revisedOutline":{"title":"","sections":[{"heading":"","function":"","thesis":"","words":200,"keyPoints":[""],"materials":[""]}]}}
score < 0.75 时必须给出 revisedOutline（完整版，不是只改一处）；score >= 0.75 时 revisedOutline 给 null。`;
}

/**
 * 评审（并可选修订）当前大纲。
 * @param outline 缺省读 state.outline。
 * @returns { outline, revised, report } — outline 为评审后的（可能修订版），report 为评审报告。
 * 不写 state：由调用方决定如何落地，避免与 generateOutline 的写盘冲突。
 */
export async function reviewOutline(cfg, wsDir, { outline = null } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const state = ws.readState(workspace);
  const current = outline || state.outline;
  if (!current?.sections?.length) {
    return {
      outline: current,
      revised: false,
      report: { score: 0, issues: [{ severity: 'high', target: '大纲', issue: '还没有大纲' }], mode: 'none' },
    };
  }
  const ctx = {
    topic: state.confirmed?.topic || current.title || '',
    theme: state.confirmed?.theme || '',
    arguments: state.confirmed?.arguments || [],
    materials: state.materials || [],
    corrections: state.blueprint?.corrections || [],
    genre: state.confirmed?.genre || '',
    genreBrief: genreBrief(state.confirmed?.genre || ''),
    targetWords: state.targetWords || 1000,
    outline: current,
  };
  let report;
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是大纲评审师，输出严格 JSON。' },
        { role: 'user', content: reviewPromptArgs(ctx) },
      ],
      { json: true, temperature: 0.3, maxTokens: 3500 },
    );
    const r = parseJsonContent(content, '大纲评审');
    const score = Number(r.score);
    report = {
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 3) : [],
      issues: Array.isArray(r.issues) ? r.issues.slice(0, 6) : [],
      revisedOutline:
        r.revisedOutline && Array.isArray(r.revisedOutline.sections) && r.revisedOutline.sections.length
          ? r.revisedOutline
          : null,
      mode: 'llm',
    };
  } catch {
    report = deterministicReview(current, ctx);
  }
  const revised = Boolean(report.revisedOutline && report.score < REVIEW_SCORE_OK);
  const outlineOut = revised ? report.revisedOutline : current;
  if (revised) {
    outlineOut.sections.forEach((s) => {
      if (Number(s.words) > 0) return;
      s.words = Math.round(ctx.targetWords / Math.max(1, outlineOut.sections.length));
    });
    const memoryFile = path.join(
      workspace,
      'vault',
      'project-memory',
      `outline-review-${Date.now()}.json`,
    );
    fs.writeFileSync(
      memoryFile,
      JSON.stringify(
        { ...outlineOut, reviewedAt: ws.nowIso(), report: { score: report.score, issues: report.issues } },
        null,
        2,
      ) + '\n',
    );
    ws.logContext(
      workspace,
      'outline-review',
      `评审 ${report.score} 分，自动修订 ${report.issues.length} 处问题 → ${memoryFile}`,
    );
  } else {
    ws.logContext(workspace, 'outline-review', `评审 ${report.score} 分（${report.mode}），保持大纲不变`);
  }
  return { outline: outlineOut, revised, report };
}

/** 人类可读的评审报告。 */
export function renderOutlineReview(report, { revised = false } = {}) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 大纲评审', line);
  out.push(
    `评分: ${(report.score * 100).toFixed(0)} 分（${report.mode === 'llm' ? 'LLM 评审' : '确定性兜底'}）`,
  );
  if (revised) out.push('已按评审意见自动修订，修订版见大纲（仍需你确认）');
  if (report.strengths?.length) {
    out.push('做得好的:');
    for (const s of report.strengths) out.push(`  · ${s}`);
  }
  if (report.issues?.length) {
    out.push('评审意见:');
    for (const i of report.issues.slice(0, 6))
      out.push(`  · [${i.severity || 'mid'}] ${i.target ? `${i.target}：` : ''}${i.issue}`);
  }
  if (!report.issues?.length) out.push('没有需要改的问题。');
  out.push(line);
  return out.join('\n');
}
