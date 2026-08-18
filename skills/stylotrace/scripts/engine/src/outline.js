// Phase 2 大纲：素材门槛未过不准生成；产出结构化大纲 + 玻璃面板。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { OUTLINE_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import { buildStyleShot } from './style-memory.js';
import { latestStyleDirection } from './style.js';
import { genreBrief, genreToCategory } from './genre.js';
import { contentBudget } from './budget.js';
import { loadPersonalSkill } from './library.js';
import { loadStyleAdapter } from './style-adapter.js';
import { unifiedBrief } from './rag.js';
import { reviewOutline } from './outline-review.js';
import { pulseAfterOutline, pushPulseToState } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';
import { buildSearchQueries, requestHostSearch, pendingDataNeeds, queueAssetSearch } from './rag.js';
import { academicNarrative } from './academic.js';
import { personaBrief } from './persona.js';
import { outlineProgress, nextOutlineGap } from './outline-state.js';
import { requiredMissing } from './clarify.js';
import { thinkingBrief } from './thinking.js';

/**
 * 风格档案摘要（token 轻量版，借鉴"精简版优先"原则）。
 *
 * 只输出置信度最高的 Top-N 维（默认 6），阈值 0.35，去掉置信度百分比——
 * 14+7 维全量注入会白白吃掉 token，而模型真正需要的是"最确定的几条
 * 偏好"（wjs-distilling-style：风格不是形容词，是指纹；几条高置信规则
 * 胜过一堆低置信描述）。无档案/空档案返回空串，不注入占位。
 *
 * @param file 档案 JSON 路径（write-style.json / read-style.json）
 * @param opts { max=6, minConfidence=0.35 }
 */
export function styleSummary(file, { max = 6, minConfidence = 0.35 } = {}) {
  try {
    const obj = ws.readJson(file);
    const dims = obj.dimensions || obj.structure || {};
    return Object.entries(dims)
      .filter(([, d]) => d && (d.confidence || 0) >= minConfidence)
      .sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0))
      .slice(0, max)
      .map(([k, d]) => `${k}: ${d.value}`)
      .join('\n');
  } catch {
    return '';
  }
}

export function gate(workspace) {
  const state = ws.readState(workspace);
  // 用户明确放弃继续追问（deferred）→ 只要求主题，其余缺口交给大纲标注与写作时补全，
  // 不硬卡门槛把用户困在澄清里。
  if (state.deferred) {
    const needTopic = !state.confirmed?.topic;
    return {
      ok: !needTopic,
      missing: needTopic ? ['主题'] : [],
      state,
    };
  }
  // v0.38：与澄清共用文体蓝图门槛（合同要事项/主送、小说要情节、论文要论点×N…），
  // 不再按文体手写一套可能错配的检查。
  const missing = requiredMissing(state);
  if (!state.confirmed?.topic) missing.push('主题');
  return { ok: missing.length === 0, missing, state };
}

/** 动态提示词预算（大纲版）：裁剪统一素材与侧写，保核心字段。 */
function clipOutlineCtx(ctx, budget = 1200) {
  const len = (s) => (s || '').length;
  const total = len(ctx.styleAdapter) + len(ctx.persona) + len(ctx.unifiedBrief);
  if (total <= budget) return ctx;
  const over = total - budget;
  ctx.persona = ctx.persona ? ctx.persona.slice(0, Math.max(0, 360 - over)) : '';
  ctx.unifiedBrief = ctx.unifiedBrief ? ctx.unifiedBrief.slice(0, Math.max(0, 520 - over)) : '';
  return ctx;
}

/**
 * 卷级分组规范化（v0.42）：parts 只是展示分组，不是写作真源。
 * - 只保留 heading 确实存在于 sections 的分组项；空卷丢弃；
 * - 未进任何卷的节归入"未分组"（保证展示完整、写作结构不被 parts 改动）。
 */
export function normalizeParts(outline) {
  const headings = new Set(
    (outline?.sections || [])
      .map((s) => String(s?.heading || '').trim())
      .filter(Boolean),
  );
  const raw = Array.isArray(outline?.parts) ? outline.parts : [];
  const parts = raw
    .map((p, i) => ({
      title: String(p?.title || `第 ${i + 1} 卷`).trim().slice(0, 40),
      sections: (Array.isArray(p?.sections) ? p.sections : [])
        .map((h) => String(h || '').trim())
        .filter((h) => headings.has(h)),
    }))
    .filter((p) => p.sections.length > 0)
    .slice(0, 8);
  const grouped = new Set(parts.flatMap((p) => p.sections));
  const ungrouped = (outline?.sections || [])
    .map((s) => String(s?.heading || '').trim())
    .filter((h) => h && !grouped.has(h));
  if (ungrouped.length) parts.push({ title: '未分组', sections: ungrouped });
  return parts.length ? parts : null;
}

export async function generateOutline(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const { ok, missing, state } = gate(workspace);
  if (!ok) {
    throw new Error(`素材门槛未过，缺少: ${missing.join('、')}。请先运行 stylotrace clarify。`);
  }
  // 内置资产命中不足时，联网补资产（once/会话、非阻塞；结果回灌后由 unifiedBrief 自动采用）
  if (!state.assetSearchAsked && state.confirmed?.topic) {
    state.assetSearchAsked = true;
    queueAssetSearch(workspace, `${state.confirmed.topic} ${state.confirmed.genre || ''}`, {
      purpose: 'asset-search',
    });
    ws.writeState(workspace, state);
  }
  const ctx = {
    genre: state.confirmed.genre || '',
    topic: state.confirmed.topic,
    theme: state.confirmed.theme,
    stance: state.confirmed.stance,
    thinking: thinkingBrief(state),
    arguments: state.confirmed.arguments || [],
    audience: state.confirmed.audience,
    targetWords: Number(state.confirmed?.targetWords) || cfg.targetWords,
    budget: contentBudget({
      genre: state.confirmed?.genre || '',
      targetWords: Number(state.confirmed?.targetWords) || cfg.targetWords,
    }),
    materials: state.materials,
    writeStyle: styleSummary(path.join(workspace, 'vault', 'write-style.json')),
    readStyle: styleSummary(path.join(workspace, 'vault', 'read-style.json')),
    styleShot: buildStyleShot(workspace, {
      topic: state.confirmed.topic,
      genre: state.confirmed.genre || '',
    }),
    corrections: state.blueprint?.corrections || [],
    seeds: (state.seeds || [])
      .map((s) => `- [${s.type}${s.confirmed ? '✓' : '·待确认'}] ${s.text}`)
      .join('\n'),
    constraints: (state.constraints || []).map((c, i) => `${i + 1}. ${c}`).join('\n'),
    liveOutline: state.liveOutline?.sections?.length
      ? `《${state.liveOutline.title || ''}》\n${state.liveOutline.sections
          .map((s, i) => `${i + 1}. ${s.heading}（${s.function || ''}${s.words ? `，约${s.words}字` : ''}）${s.thesis ? `｜${s.thesis}` : ''}`)
          .join('\n')}`
      : '',
    styleDirection: latestStyleDirection(workspace)?.phrase || '',
    genreBrief: genreBrief(state.confirmed?.genre || ''),
    personalSkill: loadPersonalSkill(workspace, {
      category: state.confirmed?.libraryCategory || genreToCategory(state.confirmed?.genre || ''),
    }),
    styleAdapter: loadStyleAdapter(workspace, 600),
    unifiedBrief: unifiedBrief(
      workspace,
      [
        state.confirmed.topic,
        state.confirmed.genre || '',
        state.confirmed.theme,
        state.confirmed.gap || '',
        (state.confirmed.arguments || []).join(' '),
      ]
        .filter(Boolean)
        .join(' '),
    ),
    academicArc: /学术论文/.test(state.confirmed?.genre || '')
      ? academicNarrative(state)
      : '',
    persona: personaBrief(workspace),
  };
  // v0.49：长文大纲（含卷级 parts）token 预算 3000→6000，避免推理模型
  // 把 token 花在思考上导致 JSON 截断；解析失败时追加"补全"提示重试一次。
  const prompt = OUTLINE_PROMPT(clipOutlineCtx(ctx));
  let outline = null;
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是提纲设计师。输出严格 JSON，不要输出任何多余文字。' },
        {
          role: 'user',
          content:
            prompt +
            (attempt === 1
              ? '\n\n【注意】上一次输出不完整或被截断。请重新输出**完整的大纲 JSON**（含全部 sections，务必闭合所有括号）。'
              : ''),
        },
      ],
      { json: true, temperature: 0.5, maxTokens: 6000 },
    );
    try {
      outline = parseJsonContent(content, '大纲');
    } catch {
      outline = null; // 重试一次
    }
  }
  if (!outline) throw new Error('大纲生成失败：模型输出不是合法 JSON（已重试一次）');
  if (!outline.sections?.length) throw new Error('大纲缺少 sections');
  const total = outline.sections.reduce((s, x) => s + Number(x.words || 0), 0);
  let targetWords = total > 0 ? total : cfg.targetWords;
  const userTarget = Number(state.confirmed?.targetWords) || 0;
  // LLM 大纲字数分配明显不足用户目标（如 2000 字只分 900）→ 按比例重标定，
  // 保证写作预算贴合用户需求，而不是跟着模型偷懒走。
  if (userTarget > 0 && total > 0 && total < userTarget * 0.7) {
    const ratio = userTarget / total;
    for (const s of outline.sections) {
      s.words = Math.max(150, Math.round(Number(s.words || 0) * ratio));
    }
    targetWords = userTarget;
  }
  const perSection = Math.round(targetWords / outline.sections.length);
  for (const s of outline.sections) {
    s.words = Number(s.words) > 0 ? Number(s.words) : perSection;
    if (!s.thesis) {
      const args = state.confirmed?.arguments || [];
      s.thesis = args.length ? args[outline.sections.indexOf(s) % args.length] : s.function;
    }
  }

  // 大纲评审-修订回路：低分且有 LLM 修订版时自动替换（用户仍需最终确认）。
  // 确定性兜底时 revised=false，大纲保持原样，流程永不因评审而中断。
  const review = await reviewOutline(cfg, workspace, { outline });
  if (review.revised) {
    outline.sections = review.outline.sections;
    outline.title = review.outline.title || outline.title;
    outline.reviewed = true;
  }
  // 卷级分组（v0.42，长文展示用）：sections 不变，parts 只做分组视图
  outline.parts = normalizeParts(outline);
  state.outlineReviews = state.outlineReviews || [];
  state.outlineReviews.push({
    ts: ws.nowIso(),
    score: review.report.score,
    mode: review.report.mode,
    issues: (review.report.issues || []).map((i) => i.issue).slice(0, 4),
    revised: review.revised,
  });
  if (state.outlineReviews.length > 5) state.outlineReviews = state.outlineReviews.slice(-5);

  state.phase = 'plan';
  state.summary = `大纲已生成：${outline.parts?.length ? `${outline.parts.length} 卷 · ` : ''}${outline.sections.length} 节（立意+论点已挂载），目标 ${targetWords} 字`;
  if (review.revised) state.summary += '（已按内部评审自动微调）';
  const pulse = pulseAfterOutline(workspace, outline);
  pushPulseToState(state, pulse);
  await refreshStyleVector(cfg, workspace, {
    text: outline.sections
      .map((s) => `${s.heading || ''} ${s.thesis || ''} ${(s.keyPoints || []).join(' ')}`)
      .join(' '),
    kind: 'outline',
    evidence: '大纲生成',
  });
  if (pulse.suggestion) state.summary += `（大纲脉搏建议：${pulse.suggestion}）`;
  state.targetWords = targetWords;
  state.nextStep = '确认大纲后运行 stylotrace write';
  state.outline = outline;
  // v0.30：大纲只是结构视图——确定性完成度只用于呈现与确认节奏，
  // 写作真源仍是 state（立意/素材/风格/知识库/修正记录）。
  const progress = outlineProgress({ title: outline.title, sections: outline.sections }, state);
  outline.sections.forEach((s, i) => {
    const p = progress.perSection[i];
    if (p) {
      s.status = p.status;
      s.missing = p.missing || [];
    }
  });
  state.liveOutline = {
    title: outline.title,
    sections: outline.sections,
    parts: outline.parts,
    complete: progress.complete,
    progress,
    nextGap: progress.complete ? null : nextOutlineGap(progress),
    updatedAt: ws.nowIso(),
  };
  // 修正已吸收进大纲，清空避免后续重写重复应用
  if (state.blueprint) state.blueprint.corrections = [];

  // 实时取数：大纲里没有挂素材/标注"需补充素材"的节 → 自动排队检索（宿主代检，非阻塞）。
  const queries = [];
  for (const s of outline.sections) {
    const mats = s.materials || [];
    const gap = !mats.length || mats.some((m) => /需补充素材|补充素材/.test(String(m)));
    if (!gap) continue;
    for (const q of buildSearchQueries(
      `${outline.title || ''} ${s.heading || ''} ${s.thesis || ''}`,
      { topic: state.confirmed?.topic || '', limit: 3 },
    )) {
      if (queries.length < 6 && !queries.includes(q)) queries.push(q);
    }
  }
  const dataRequests = { queued: 0 };
  if (queries.length) {
    const existing = pendingDataNeeds(workspace);
    const fresh = queries.filter((q) => !existing.some((p) => p.queries?.includes(q)));
    if (fresh.length) {
      const req = requestHostSearch(workspace, fresh, { purpose: 'outline-gap' });
      dataRequests.queued = req.queued;
      dataRequests.queries = fresh;
      state.summary += `（有 ${req.queued} 条资料请求待宿主检索，回灌后我会补进对应节）`;
    }
  }
  ws.writeState(workspace, state);
  const memoryFile = path.join(workspace, 'vault', 'project-memory', `outline-${Date.now()}.json`);
  fs.writeFileSync(
    memoryFile,
    JSON.stringify({ ...outline, generatedAt: ws.nowIso() }, null, 2) + '\n',
  );
  return { outline, state, memoryFile, dataRequests, progress };
}
