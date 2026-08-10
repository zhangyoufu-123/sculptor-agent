// 自主导演（Director）：让 Sculptor 主导写作对话，而不是被动等"继续"。
// 每次收到用户消息后，导演自己决定下一步：该问就问、该生成大纲就生成、
// 该写就逐节写、该审计就审计、该请读者群像就群像——只有真正的用户决策点
// （主题/立场/素材/立意/论点/大纲确认/风格方向）才停下等用户。
// 用法：sculptor agent（交互）或 MCP agent_step（宿主逐条转发用户消息）。
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import * as ws from './workspace.js';
import { clarifyStep, missingNeed } from './clarify.js';
import { generateOutline } from './outline.js';
import { writeSection, detectDraftGaps } from './write.js';
import { redteam } from './redteam.js';
import { runAudience, renderAudience, runDebate, renderDebate } from './reader-gallery.js';
import { restyle } from './restyle.js';
import { applyStyleDirection, extractStyleFromConversation } from './style.js';
import { applyCorrectionFeedback } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';
import { distillStyleAdapter, adapterStale } from './style-adapter.js';
import { factScan } from './fact-check.js';
import { proofScan } from './proofread.js';
import { originalityScan } from './originality.js';
import { buildSearchQueries, requestHostSearch, autoReferences } from './rag.js';
import { buildPersona, personaToVector } from './persona.js';
import { understandIntent } from './intent.js';
import { distillBible } from './bible.js';
import { reviseScan } from './revise.js';
import { evaluateStyleFidelity } from './style-eval.js';
import { archiveDraft, distillCategory } from './library.js';
import { exportDocx } from './io.js';

const OUTLINE_CONFIRM_RE = /^(对|对的|可以|可以的|没问题|就是这样|好的?|同意|ok|嗯|是|就这样)$/i;
const OUTLINE_CORRECT_RE =
  /但|不过|改成|改为|换成|再加|删掉|不要|少点|多点|调整|修改|重来|结尾|开头|中间/;

function initDirector(state) {
  state.director = state.director || {
    stage: 'clarify', // clarify → outline → write → redteam → audience → deliver / restyle
    writeIndex: 0,
    outlineRegens: 0,
    fixAttempts: 0,
    qualityFixAttempts: 0,
    qualityFixDirection: '',
  };
  return state.director;
}

function classifyOutlineReply(a) {
  const norm = String(a || '')
    .trim()
    .replace(/[，。！？、,.！\s]/g, '');
  if (!norm) return 'confirm';
  if (OUTLINE_CONFIRM_RE.test(norm) || norm.includes('就是这样') || norm.includes('没问题')) {
    return 'confirm';
  }
  if (OUTLINE_CORRECT_RE.test(a) || [...norm].length > 10) return 'correct';
  if (/^(对|可以|好|ok)/i.test(norm)) return 'confirm';
  return 'correct';
}

function outlineView(outline) {
  return {
    title: outline.title,
    sections: (outline.sections || []).map((s) => ({
      heading: s.heading,
      function: s.function,
      thesis: s.thesis || '',
      words: s.words,
      keyPoints: s.keyPoints || [],
    })),
  };
}

async function advanceToOutline(cfg, workspace, state) {
  try {
    const r = await generateOutline(cfg, workspace);
    // 人物风格肖像（静默）：从知识库+写作库+修改记录侧写，并映射回风格向量。
    try {
      await buildPersona(cfg, workspace);
      await personaToVector(cfg, workspace);
    } catch {}
    state.outline = r.outline;
    state.outlineConfirmed = false;
    state.phase = 'plan';
    state.summary = `大纲已生成：${r.outline.sections.length} 节，等待用户确认`;
    state.nextStep = '确认大纲（可提出修改）';
    ws.writeState(workspace, state);
    const dataNote =
      r.dataRequests?.queued > 0
        ? `另有 ${r.dataRequests.queued} 条资料检索已排队（宿主/协作 agent 检索后回灌，我会自动补进对应节）。`
        : '';
    return {
      kind: 'confirm_outline',
      outline: outlineView(r.outline),
      message: `需求已齐，这是我设计的整篇大纲——请确认，或直接告诉我要改哪里。${dataNote}`,
      dataRequests: r.dataRequests || { queued: 0 },
    };
  } catch (err) {
    state.summary = '素材不足，暂不能生成大纲';
    state.nextStep = '继续回答澄清问题';
    ws.writeState(workspace, state);
    return {
      kind: 'ask',
      question: `还差一点信息才能把整篇文章立起来：${String(err.message).replace(/^[^:]*:\s*/, '')}`,
      recommendation: '补齐缺失项后我会直接生成大纲，不需要你催。',
      options: [],
      phase: state.phase,
    };
  }
}

/**
 * 导演单步：应用一条用户消息（可为空），推进写作流程并返回下一步决策。
 */
export async function agentStep(cfg, wsDir, { lastInput = '' } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  // 子函数（clarifyStep/generateOutline/writeSection/redteam…）都会重写 state.json，
  // 所以每个阶段边界都重新加载，确保 director 状态不丢、不写脏。
  const load = () => {
    const state = ws.readState(workspace);
    const d = initDirector(state);
    return { state, d };
  };
  let { state, d } = load();

  // ── 澄清：问完所有该问的 ─────────────────────────────
  if (d.stage === 'clarify') {
    const r = await clarifyStep(cfg, workspace, { lastInput });
    ({ state, d } = load());
    if (r.question) {
      return {
        kind: 'ask',
        question: r.question,
        recommendation: r.recommendation,
        options: r.options,
        knowledgeSuggestion: r.knowledgeSuggestion || '',
        dataSuggestion: r.dataSuggestion || '',
        searchSuggestion: r.searchSuggestion || '',
        recommendSuggestion: r.recommendSuggestion || '',
        academicHint: r.academicHint || '',
        checklist: r.checklist || null,
        phase: state.phase,
        blueprint: state.blueprint,
        stylePulse: r.stylePulse || null,
      };
    }
    if (missingNeed(state) !== '') {
      return {
        kind: 'ask',
        question: '还需要补充一些关键信息才能继续，先回答上一条问题好吗？',
        recommendation: '我一次只问一件事；答完我会自动往下推进。',
        options: [],
        phase: state.phase,
      };
    }
    // 澄清收尾：把用户全部发言做一次"对话级整体风格提炼"（write/read 双风格），
    // 让没贴旧稿的用户也能在进入大纲前建立高层次风格档案；失败静默，不阻塞。
    try {
      await understandIntent(cfg, workspace, state);
      await extractStyleFromConversation(cfg, workspace);
      await refreshStyleVector(cfg, workspace, { kind: 'conversation', evidence: '澄清收尾整体提炼' });
    } catch {}
    d.stage = 'outline';
    ws.writeState(workspace, state);
    const res = await advanceToOutline(cfg, workspace, state);
    ({ state, d } = load());
    return res;
  }

  // ── 大纲：生成 → 用户确认/修改 → 确认后进入写作 ─────────
  if (d.stage === 'outline') {
    if (!state.outline) return advanceToOutline(cfg, workspace, state);
    if (!state.outlineConfirmed) {
      const reply = classifyOutlineReply(lastInput);
      if (!lastInput.trim()) {
        return {
          kind: 'confirm_outline',
          outline: outlineView(state.outline),
          message: '请确认这份大纲：回"可以"开始写；要改哪里直接说。',
        };
      }
      if (reply === 'confirm') {
        state.outlineConfirmed = true;
        d.stage = 'write';
        d.writeIndex = 0;
        state.phase = 'write';
        state.summary = '大纲已确认，开始逐节写作';
        state.nextStep = '导演自动推进写作';
        ws.writeState(workspace, state);
      } else {
        // 大纲修改意见也是风格反馈（如"结尾不要留白"→ 收束习惯调整）。
        applyCorrectionFeedback(workspace, String(lastInput));
        await refreshStyleVector(cfg, workspace, {
          text: String(lastInput),
          kind: 'correction',
          evidence: '大纲修改意见',
        });
        state.blueprint = state.blueprint || {};
        state.blueprint.corrections = state.blueprint.corrections || [];
        state.blueprint.corrections.push(String(lastInput).trim());
        d.outlineRegens = (d.outlineRegens || 0) + 1;
        if (d.outlineRegens >= 3) {
          state.outlineConfirmed = true;
          d.stage = 'write';
          d.writeIndex = 0;
          state.summary = '大纲已按修正重生成三轮，视为确认';
          ws.writeState(workspace, state);
        } else {
          const r = await generateOutline(cfg, workspace);
          ({ state, d } = load());
          state.outline = r.outline;
          state.outlineConfirmed = false;
          ws.writeState(workspace, state);
          return {
            kind: 'confirm_outline',
            outline: outlineView(r.outline),
            message: `已按你的意见「${lastInput.trim()}」调整大纲——这样对吗？`,
          };
        }
      }
    }
    // 确认后继续往下（写第一节）
  }

  // ── 写作：逐节推进，每步一节，用户看得见进度 ──────────
  if (d.stage === 'write') {
    const sections = state.outline?.sections || [];
    if (d.writeIndex < sections.length) {
      const idx = d.writeIndex;
      const r = await writeSection(cfg, workspace, { index: idx });
      ({ state, d } = load());
      d.writeIndex = idx + 1;
      ws.writeState(workspace, state);
      const sec = r.report[0];
      const remain = sections.length - d.writeIndex;
      const dataNote =
        sec.dataRequested?.length > 0
          ? ` 本节缺 ${sec.dataRequested.length} 项资料，已排队检索「${sec.dataRequested.join('、').slice(0, 80)}」`
          : '';
      return {
        kind: 'working',
        message: `已写第 ${idx + 1}/${sections.length} 节「${sec.heading}」（${sec.actual} 字，风格脉搏 ${(sec.pulse * 100).toFixed(0)} 分${
          sec.pulseNote ? `，${sec.pulseNote}` : ''
        }）${dataNote}${
          remain > 0 ? `，继续写下一节…` : '，开始反 AI 审计…'
        }`,
        progress: { done: d.writeIndex, total: sections.length },
        phase: 'write',
      };
    }
    // 初稿完成 → 先做复阅-修订（Flower & Hayes：规划→转译→复阅），再进红队
    d.stage = 'revise';
    d.reviseRounds = 0;
    ws.writeState(workspace, state);
  }

  // ── 复阅-修订：全文复查一轮，P0（偏题/素材未用/断裂）自动局部修订（静默）──
  if (d.stage === 'revise') {
    const sections = state.outline?.sections || [];
    if (d.reviseRounds >= 1 || sections.length < 3 || !cfg.apiKey) {
      d.stage = 'redteam';
      d.fixAttempts = 0;
      ws.writeState(workspace, state);
    } else {
      const rev = await reviseScan(cfg, workspace);
      state.revise = { score: rev.score, issues: (rev.issues || []).slice(0, 6), ts: ws.nowIso() };
      d.reviseRounds += 1;
      if (rev.p0?.length) {
        await restyle(cfg, workspace, { direction: rev.direction || '修复偏题与衔接，素材用足' });
        ({ state, d } = load());
        d.stage = 'redteam';
        d.fixAttempts = 0;
        ws.writeState(workspace, state);
        return {
          kind: 'working',
          message: `复阅发现 ${rev.p0.length} 处需修（${rev.p0
            .map((i) => i.section || '全文')
            .slice(0, 3)
            .join('、')}…），已按「${rev.direction || '修复'}」修订，重新反 AI 审计…`,
          phase: 'revise',
        };
      }
      d.stage = 'redteam';
      d.fixAttempts = 0;
      ws.writeState(workspace, state);
    }
  }

  // ── 回灌后自动续写：检索结果晚于最后写作，且稿中仍有【素材不足】节 → 用新素材重写 ──
  if (d.stage === 'rewrite_gaps') {
    const gaps = d.rewriteGaps || [];
    let rewritten = 0;
    const failed = [];
    for (const g of gaps) {
      if (g.index === null) continue;
      try {
        await writeSection(cfg, workspace, { index: g.index });
        rewritten += 1;
      } catch {
        failed.push(g.heading);
      }
    }
    ({ state, d } = load());
    // 多轮数据补给：重写后仍有缺口且未满 2 轮 → 等待再次回灌自动续写；满 2 轮交付带警告
    state.rewriteRounds = (state.rewriteRounds || 0) + 1;
    const residual = detectDraftGaps(workspace).filter((g) => g.index !== null);
    if (residual.length && state.rewriteRounds < 2) {
      const still = residual.map((g) => g.heading);
      const req = requestHostSearch(
        workspace,
        still.map((h) => `补充${h}所需资料`),
        { purpose: 'write-gap' },
      );
      d.stage = 'deliver';
      ws.writeState(workspace, state);
      return {
        kind: 'working',
        message: `已重写 ${rewritten} 个缺口节，但「${still.join('、')}」仍缺资料（第 ${state.rewriteRounds} 轮，已再次排队 ${req.queued} 条检索；最多补 2 轮）…`,
        phase: 'rewrite',
      };
    }
    if (residual.length) state.summary = '仍有素材缺口未补齐，交付带警告';
    d.stage = 'redteam';
    d.fixAttempts = 0;
    ws.writeState(workspace, state);
    return {
      kind: 'working',
      message: `已用回灌资料重写 ${rewritten} 个缺口节${
        failed.length ? `，${failed.length} 节未能重写（${failed.join('、')}，可能被外部改过）` : ''
      }${residual.length ? '；仍有缺口未补齐，交付时将提示' : ''}，重新反 AI 审计…`,
      phase: 'redteam',
    };
  }

  // ── 红队：审计 + 自动修订，最多 3 次 ──────────────────
  if (d.stage === 'redteam') {
    const rr = await redteam(cfg, workspace, { fix: d.fixAttempts < 3 });
    ({ state, d } = load());
    if (!rr.report.passed && d.fixAttempts < 3) {
      d.fixAttempts += 1;
      ws.writeState(workspace, state);
      return {
        kind: 'working',
        message: `反 AI 审计发现 ${rr.report.blacklistHits.length + rr.report.repeatedMetaphors.length + rr.report.repeatedPatterns.length} 处痕迹，正在按你的风格修订（第 ${d.fixAttempts} 次）…`,
        phase: 'redteam',
      };
    }
    if (!rr.report.passed) {
      state.summary = '红队审计仍有残留问题，交付带警告';
      ws.writeState(workspace, state);
    }
    d.stage = 'quality';
    d.qualityFixAttempts = 0;
    d.qualityFixDirection = '';
    ws.writeState(workspace, state);
  }

  // ── 静默内部质量门：风格保真/原创性/校对/事实核查真实触发，不向用户刷屏 ──
  // 低分自动微调（最多 2 轮），其余只记录进 state.quality + 触发 RAG 检索请求。
  if (d.stage === 'quality') {
    const draftText = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
    state.quality = state.quality || {};
    let needsStyleFix = false;
    if (d.qualityFixAttempts < 2 && cfg.apiKey) {
      try {
        const ev = await evaluateStyleFidelity(cfg, workspace);
        state.quality.styleScore = ev.score;
        if (ev.needsFix) {
          needsStyleFix = true;
          d.qualityFixAttempts += 1;
          d.qualityFixDirection = (ev.advice || []).join('；') || '更贴合作者风格';
        }
      } catch {}
    }
    const ori = originalityScan(draftText, workspace);
    const pr = proofScan(draftText);
    const fc = factScan(draftText, state.materials || []);
    state.quality.originality = ori;
    state.quality.proofread = pr.items.length;
    state.quality.factVerify = fc.items.filter((i) => i.supported === 'verify').length;
    state.quality.ts = ws.nowIso();
    const queries = buildSearchQueries(draftText, {
      factReport: fc,
      topic: state.confirmed?.topic || state.outline?.title || '',
    });
    const rag = requestHostSearch(workspace, queries, { purpose: 'fact-check' });
    state.quality.ragQueries = rag.queued;
    ws.writeState(workspace, state);
    if (needsStyleFix) {
      d.stage = 'style_fix';
      ws.writeState(workspace, state);
      return {
        kind: 'working',
        message: '正在做交付前的内部质量微调…',
        phase: 'quality',
      };
    }
    d.stage = 'audience';
    ws.writeState(workspace, state);
  }

  // ── 内部质量微调：按评估建议重写 → 回红队复查（静默，不展示评估面板） ──
  if (d.stage === 'style_fix') {
    await restyle(cfg, workspace, { direction: d.qualityFixDirection || '' });
    ({ state, d } = load());
    d.stage = 'redteam';
    d.fixAttempts = 0;
    ws.writeState(workspace, state);
    return {
      kind: 'working',
      message: '内部质量微调完成，重新反 AI 审计…',
      phase: 'quality',
    };
  }

  // ── 读者群像：交付前强制 ─────────────────────────────
  if (d.stage === 'audience') {
    const ar = await runAudience(cfg, workspace, { quick: Boolean(cfg.quick) });
    const rendered = renderAudience(ar);
    ({ state, d } = load());
    state.audience = { personas: ar.personas.map((p) => p.persona), file: ar.file };
    let debateRendered = '';
    if (!cfg.quick) {
      try {
        const db = await runDebate(cfg, workspace, { reactions: ar.personas });
        debateRendered = renderDebate(db);
        state.debate = {
          consensus: db.consensus.length,
          disputes: db.disputes.length,
          file: db.file,
        };
      } catch {}
    }
    // 归档进个人写作库（按文体自动分类），并尽力导出 docx
    const archived = archiveDraft(workspace, state);
    if (archived) state.confirmed.libraryCategory = archived.category; // 供后续同类写作注入个人 skill
    // 文章圣经（静默沉淀）：长文/小说交付时自动落一份跨篇一致性文档
    try {
      await distillBible(cfg, workspace);
    } catch {}
    let distilled = '';
    if (archived) {
      try {
        const dr = await distillCategory(workspace, archived.category, cfg);
        distilled = dr.distilled ? `已蒸馏「${dr.category}」个人写作 skill` : '';
      } catch {}
    }
    let docx = '';
    try {
      docx = exportDocx(
        fs.readFileSync(ar.file, 'utf8'),
        path.join(path.dirname(ar.file), 'draft.docx'),
      );
    } catch {}
    let adapterNote = '';
    try {
      if (!cfg.quick && adapterStale(workspace)) {
        const ad = await distillStyleAdapter(cfg, workspace);
        if (ad.distilled) {
          const n = ad.card.sources.samples + ad.card.sources.pieces + ad.card.sources.edits;
          adapterNote = `，已压缩风格适配卡（${n} 条素材，供持续微调）`;
        }
      }
    } catch {}
    const q = state.quality || {};
    const fcVerify = typeof q.factVerify === 'number' ? q.factVerify : 0;
    const prCount = typeof q.proofread === 'number' ? q.proofread : 0;
    state.factCheck = { total: fcVerify, verify: fcVerify, ts: ws.nowIso() };
    state.proofread = { total: prCount, ts: ws.nowIso() };
    // 学术论文交付：提示引文整理（确定性检测《书名》，格式由 sculptor citations 生成）
    let citeNote = '';
    let refFile = '';
    try {
      if (/学术论文/.test(state.confirmed?.genre || '')) {
        const draftText = fs.readFileSync(ar.file, 'utf8');
        const cited = (draftText.match(/《([^》]{2,40})》/g) || []).slice(0, 8);
        if (cited.length) {
          citeNote = `检测到 ${cited.length} 处引文（${cited.join('、').slice(0, 80)}…）。运行 \`sculptor citations --append refs.json\` 可生成 GB/T 7714 参考文献并追加到文末。`;
        }
        const ar = autoReferences(workspace, { style: 'gbt7714' });
        if (ar.file) refFile = ar.file;
      }
    } catch {}
    d.stage = 'deliver';
    state.phase = 'deliver';
    ws.writeState(workspace, state);
    return {
      kind: 'deliver',
      draftFile: ar.file,
      docx: docx || '',
      archived: archived ? `已归档到个人写作库（${archived.category}）` : '',
      distilled: distilled || '',
      audience: rendered,
      debate: debateRendered,
      message: `整篇文章已完成：逐节写作（每节风格脉搏已即时反馈）→ 反 AI 审计 → 读者群像 → 交锋。${archived ? '已归档进个人写作库' : ''}${distilled ? '，并已蒸馏出「' + archived.category + '」类别的个人写作 skill' : ''}${adapterNote}。${docx ? `已导出 ${docx}。` : ''}${refFile ? `已自动生成参考文献草稿 ${refFile}（基于检索回灌来源；运行 \`sculptor citations\` 可校对格式）。` : ''}${prCount ? `⚠ 校对：${prCount} 处提示（错别字/标点，运行 sculptor proofread 看明细）。` : ''}${fcVerify ? `⚠ 事实核查：${fcVerify} 处数字/年代/引文需核对（运行 sculptor fact-check 看明细）。` : ''}${citeNote ? `\n${citeNote}` : ''}要改某一句用 point-edit，要整体换风格或表达直接说（如"更克制一点"），我会吸收进风格档案并重写。`,
      next: 'sculptor redteam / sculptor audience / sculptor debate / sculptor fact-check / sculptor point-edit',
    };
  }

  // ── 交付后：用户的方向/修改建议都是评估反馈 → 吸收进档案后重写 ──
  if (d.stage === 'deliver') {
    // 回灌后自动续写：检索结果晚于最后一次写作，且稿中仍有【素材不足】节 → 先重写再重新审计交付
    const lastWrite = state.lastWriteAt || '';
    const lastIngest = state.ragIngestedAt || '';
    if (lastIngest && lastWrite && lastIngest > lastWrite) {
      const rewritable = detectDraftGaps(workspace).filter((g) => g.index !== null);
      if (rewritable.length) {
        d.stage = 'rewrite_gaps';
        d.rewriteGaps = rewritable;
        ws.writeState(workspace, state);
        return {
          kind: 'working',
          message: `检索资料已回灌，检测到 ${rewritable.length} 个缺口节（${rewritable
            .map((g) => g.heading)
            .join('、')}），正在用新素材重写…`,
          phase: 'rewrite',
        };
      }
    }
    const corr = applyCorrectionFeedback(workspace, lastInput);
    const dir = applyStyleDirection(workspace, lastInput);
    if (corr.applied || dir.applied) {
      await refreshStyleVector(cfg, workspace, {
        text: String(lastInput),
        kind: dir.applied ? 'direction' : 'correction',
        evidence: dir.applied ? dir.phrase : corr.phrase,
      });
    }
    ({ state, d } = load());
    if (dir.applied) {
      d.stage = 'restyle';
      d.fixAttempts = 0;
      state.needsRestyle = false;
      ws.writeState(workspace, state);
    } else if (corr.applied) {
      d.stage = 'restyle';
      d.fixAttempts = 0;
      state.needsRestyle = false;
      state.pendingRestyleDirection = corr.phrase;
      ws.writeState(workspace, state);
      return {
        kind: 'working',
        message: `已把你的修改建议「${corr.phrase}」吸收进风格档案，正在按它调整全文…`,
        phase: 'restyle',
      };
    } else if (lastInput.trim()) {
      return {
        kind: 'ask',
        question: '要改哪一处？',
        recommendation:
          '选中原句用 point-edit 精修；要整体换风格，说方向（"更豪迈/更克制/更口语…"）我就全文重写。',
        options: [],
        phase: 'deliver',
      };
    } else {
      return {
        kind: 'deliver',
        draftFile: state.audience?.file || path.join(workspace, 'draft.md'),
        audience: '',
        message: '文章已交付。要修改请直接说（方向或具体哪一句）。',
        next: 'point-edit / restyle / redteam',
      };
    }
  }

  // ── restyle：按新方向重写全文 → 再审计 → 再群像 → 再交付 ──
  if (d.stage === 'restyle') {
    const stored = ws
      .readJson(path.join(workspace, 'vault', 'write-style.json'))
      .styleDirections?.slice(-1)[0];
    const pending = state.pendingRestyleDirection || stored?.phrase || '';
    state.pendingRestyleDirection = '';
    ws.writeState(workspace, state);
    await restyle(cfg, workspace, { direction: pending });
    ({ state, d } = load());
    d.stage = 'redteam';
    d.fixAttempts = 0;
    ws.writeState(workspace, state);
    return {
      kind: 'working',
      message: `已按「${pending || '新方向'}」重写全文，开始反 AI 审计…`,
      phase: 'redteam',
    };
  }

  // 兜底：不应到达
  return { kind: 'blocked', message: '导演遇到未知状态，请运行 sculptor status 查看。' };
}

/** 交互式导演：主导全程对话，只在用户决策点停下等待。 */
export async function agentInteractive(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  let lastInput = '';
  console.log('Sculptor 导演模式：我主导流程，你只回答该你决定的问题（随时可打断）。\n');
  try {
    for (let i = 0; i < 200; i++) {
      const r = await agentStep(cfg, workspace, { lastInput });
      if (r.kind === 'ask') {
        let p = `\n${r.question}`;
        if (r.recommendation) p += `\n我的建议: ${r.recommendation}`;
        if (r.knowledgeSuggestion) p += `\n${r.knowledgeSuggestion}`;
        if (r.dataSuggestion) p += `\n${r.dataSuggestion}`;
        if (r.recommendSuggestion) p += `\n${r.recommendSuggestion}`;
        if (r.academicHint) p += `\n${r.academicHint}`;
        if (r.stylePulse?.suggestion) p += `\n风格脉搏: ${r.stylePulse.suggestion}`;
        if (r.options?.length)
          p += `\n选项: ${r.options.map((o, j) => `${'ABC'[j]}. ${o}`).join('  ')}`;
        lastInput = await ask(p + '\n> ');
      } else if (r.kind === 'confirm_outline') {
        console.log(`\n${r.message}`);
        console.log(`《${r.outline.title}》`);
        r.outline.sections.forEach((s, j) =>
          console.log(
            `${j + 1}. ${s.heading}（${s.function}${s.thesis ? '；' + s.thesis : ''}，约 ${s.words} 字）`,
          ),
        );
        lastInput = await ask('> 回"可以"开始写，或直接说修改意见：');
      } else if (r.kind === 'working') {
        console.log(`  ${r.message}`);
        lastInput = '';
      } else if (r.kind === 'deliver') {
        console.log(`\n✅ ${r.message}`);
        if (r.audience) console.log(r.audience.slice(0, 2200));
        if (r.debate) console.log(r.debate.slice(0, 1600));
        const again = await ask('\n要继续调整吗？（说方向 / 某一句 / 直接回车结束）\n> ');
        if (!again.trim()) break;
        lastInput = again;
      } else if (r.kind === 'blocked') {
        console.log(`[导演] ${r.message}`);
        break;
      }
    }
  } finally {
    rl.close();
  }
  console.log('\n' + ws.renderPanel(path.join(workspace, 'protocol', 'state.json')));
  return ws.readState(workspace);
}
