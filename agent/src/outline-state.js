// 大纲完成度（v0.30）：确定性结算，不靠模型口头宣称"完整"。
// 设计依据：OpenWrite"完成态来自文件状态"、LLM-as-judge 加权清单（Completeness 20% 等）、
// 每节状态机（idea → needs → ready → drafted → revised）。
// 每节按可解释的清单打分：功能定位 / 要点 / 素材 / 核心句；再叠加结构加成。

/**
 * 单节状态：idea（还没定位功能）→ needs（缺要点/素材/核心句）→ ready（可写）。
 */
export function sectionStatus(section, { globalMaterials = 0 } = {}) {
  const s = section || {};
  const waived = Array.isArray(s.waived) ? s.waived : [];
  if (!String(s.function || '').trim() && !waived.includes('功能定位')) {
    return { status: 'idea', missing: ['功能定位'] };
  }
  const missing = [];
  if (!(s.keyPoints || []).length && !waived.includes('要点')) missing.push('要点');
  if (!(s.materials || []).length && globalMaterials < 2 && !waived.includes('素材')) missing.push('素材');
  if (!String(s.thesis || '').trim() && !waived.includes('核心句')) missing.push('核心句');
  return { status: missing.length ? 'needs' : 'ready', missing };
}

/**
 * 大纲整体完成度：百分制 + 每节状态 + 全局缺失清单。
 * percent = 节就绪率 + 结构加成（≥3 节、有收束节、立意已确认、结尾姿态已确认）。
 */
export function outlineProgress(liveOutline, state = {}) {
  const secs = (liveOutline?.sections || []).filter((s) => s && String(s.heading || '').trim());
  const globalMaterials = (state.materials || []).length;
  const perSection = secs.map((s, i) => {
    const { status, missing } = sectionStatus(s, { globalMaterials });
    return {
      index: i,
      heading: String(s.heading || '').trim(),
      function: String(s.function || '').trim(),
      status,
      missing,
      words: Number(s.words) > 0 ? Number(s.words) : 0,
    };
  });
  const ready = perSection.filter((x) => x.status === 'ready').length;
  const needs = perSection.filter((x) => x.status === 'needs').length;
  const idea = perSection.filter((x) => x.status === 'idea').length;
  let percent = secs.length ? Math.round((ready / secs.length) * 100) : 0;
  let bonus = 0;
  if (secs.length >= 3) bonus += 5;
  if (secs.some((s) => /收束|结尾/.test(String(s.function || '')))) bonus += 5;
  if (String(state.confirmed?.theme || '').trim()) bonus += 5;
  if (String(state.confirmed?.endingTaste || '').trim()) bonus += 5;
  percent = Math.min(100, percent + bonus);
  // 字数覆盖（软信号，不卡完成）：目标字数已知时，看各节分配是否撑得起篇幅。
  const targetWords = Number(state.confirmed?.targetWords) || 0;
  const sumWords = perSection.reduce((s, x) => s + Number(x.words || 0), 0);
  const wordCoverage = targetWords > 0 ? Math.min(100, Math.round((sumWords / targetWords) * 100)) : 0;
  const missingGlobal = [];
  if (secs.length < 3) missingGlobal.push('至少 3 节结构');
  if (secs.length && !secs.some((s) => /开头|引入|铺垫/.test(String(s.function || '')))) missingGlobal.push('开头节');
  if (secs.length && !secs.some((s) => /收束|结尾/.test(String(s.function || '')))) missingGlobal.push('收束节');
  if (!String(state.confirmed?.theme || '').trim()) missingGlobal.push('核心立意');
  if (targetWords > 0 && sumWords < targetWords * 0.6)
    missingGlobal.push(`字数分配不足（${sumWords}/${targetWords}）`);
  return {
    percent,
    total: secs.length,
    ready,
    needs,
    idea,
    perSection,
    missingGlobal,
    targetWords,
    sumWords,
    wordCoverage,
    complete: percent >= 80 && needs === 0,
  };
}

/** 当前最该补的一节缺口（v0.30）：问题由大纲状态驱动——先补最早未就绪的节。 */
export function nextOutlineGap(progress) {
  for (const s of progress?.perSection || []) {
    if (s.status !== 'ready') {
      return { index: s.index, heading: s.heading, missing: s.missing || [] };
    }
  }
  return null;
}
