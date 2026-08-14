// 学术实质能力（v0.21）：不依赖外部学术 agent 的行文思路。
// 1) 学术叙事弧（论证链）：known → gap → tension → insight → method → evidence → limitation
// 2) 论证完备性检查：每节的 claim/evidence/warrant 是否齐备（确定性信号扫描）
// 3) 学术表达库注入：转折/让步/限定等规范表达（与内置资产库 grammar 配合）

const ARC_STEPS = [
  { key: 'known', label: '已知共识/现状', ask: '学界或现实里已经确认了什么？' },
  { key: 'gap', label: '研究缺口', ask: '已知里缺什么？没人做或没做透的是什么？' },
  { key: 'tension', label: '核心张力', ask: '缺口背后藏着什么矛盾或两难？' },
  { key: 'insight', label: '洞见/贡献', ask: '本文给出什么新解释或新判断？' },
  { key: 'method', label: '方法与证据', ask: '用什么方法、什么证据支撑这个洞见？' },
  { key: 'limitation', label: '局限', ask: '结论的适用范围与边界在哪？' },
];

/** 学术叙事弧：从已确认信息里推导（缺的留空，写作者在写作时处理）。 */
export function academicNarrative(state) {
  const c = state?.confirmed || {};
  const outline = state?.outline || {};
  const arc = {
    known: c.known || '',
    gap: c.gap || '',
    tension: c.tension || outline.tension || '',
    insight: c.theme || outline.thesis || '',
    method: c.method || '',
    limitation: c.limitation || '',
    evidence: (c.materialsNote || '').trim(),
  };
  return ARC_STEPS.map((s) => {
    const v = arc[s.key];
    return v ? `${s.label}：${v}` : `${s.label}：${s.ask}（写作时补）`;
  }).join('\n');
}

/** 学术澄清是否已覆盖论证链关键项（缺口/张力/方法）——用于提示要不要补问。 */
export function academicGap(state) {
  const c = state?.confirmed || {};
  const missing = [];
  if (!c.gap) missing.push('研究缺口（gap）');
  if (!c.theme) missing.push('洞见/贡献（insight）');
  if (!c.method) missing.push('方法与证据（method）');
  return { ok: missing.length === 0, missing };
}

const CLAIM_RE = /^(我认为|本文(试图|认为|提出|主张)|研究表明|数据显示|由此|因此|这(说明|意味着))|(的)?判断|主张|观点|核心|结论/m;
const EVIDENCE_RE = /(\d[\d０-９.,，万%％亿]|\d{3,4}\s*年|《[^》]{2,40}》|来源|数据|调查|实验|文献|统计|引用|出处)/;
const WARRANT_RE = /(这说明|这意味着|之所以|因为|缘于|其逻辑是|换句话说|可见|由此)/;
const LIMIT_RE = /(局限|边界|不适用|限于|仅适用于|尚需|待验证|不足)/;

/**
 * 论证完备性扫描：对每节正文检查 claim→evidence→warrant→limitation。
 * 确定性信号匹配（中文），返回缺口清单，供写作提示与交付前静默检查用。
 */
export function argumentScan(text) {
  const blocks = String(text || '')
    .split(/\n(?=## )/)
    .map((b) => {
      const heading = (b.match(/^##\s+(.+)$/m) || [])[1]?.trim() || '（正文）';
      return { heading, body: b.replace(/^##\s+.+$/m, '') };
    });
  return blocks.map((b) => {
    const issues = [];
    if (!CLAIM_RE.test(b.body)) issues.push('缺明确论点句（claim）');
    if (!EVIDENCE_RE.test(b.body)) issues.push('缺可查证证据（数据/引文/来源）');
    if (!WARRANT_RE.test(b.body)) issues.push('缺论证桥（证据如何支撑论点）');
    // 局限/边界只在结论/讨论类节要求，不当作每节硬门槛
    if (/结论|讨论|结语|总结|反思|尾声/.test(b.heading) && !LIMIT_RE.test(b.body)) {
      issues.push('缺边界/局限说明（结论节应交代适用范围）');
    }
    return { heading: b.heading, ok: issues.length === 0, issues };
  });
}

/** 学术表达库（规范性，非模板腔）：给写作者的提示。 */
export function academicStyleNote() {
  return [
    '转折让步：先承认对方最强的论点，再限定边界反驳（concession → refute），不回避反例。',
    '限定词：避免"绝对/必然/显然"，用"在××条件下/就样本而言/就现有证据看"。',
    '证据纪律：每个判断要么带出处、要么带数据；数字精确到可查证；引文标注《书名》或 [来源]。',
    '推理可见：论据与结论之间要露出推理桥（"这说明/其逻辑是"），不让读者替你补。',
  ].join('\n');
}
