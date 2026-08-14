// 具体化拟改（v1.7，2.1 的最后一块）：用作者亲手的"抽象→具体"编辑对做 few-shot，
// 让 LLM 按作者自己的具体化习惯改写候选。这是"改迹"的正方向（加什么），
// 与 applyAuthorEdits 的负方向（删什么）合成完整的"复现作者改法"。
import { chatWithRetry } from './llm.js';

const IMAGERY = [
  '风', '雨', '门', '窗', '楼', '石', '路', '灯', '树', '花', '灰', '光', '影',
  '雪', '河', '山', '桥', '街', '墙', '木', '火', '水', '云', '月', '夜', '烟',
  '钟', '鸟', '纸', '墨', '舟', '巷',
];
const SENSORY = [
  '看', '听', '闻', '摸', '站', '走', '推', '拉', '响', '亮', '暗', '冷', '热',
  '湿', '干', '念', '擦', '踩', '说', '动', '搁', '坐', '躺', '等', '笑', '哭',
  '喊', '抬', '低',
];
const ABSTRACT = [
  '重视', '意义', '道理', '方向', '情绪', '感受', '决定', '事情', '价值', '作用',
  '趋势', '发展', '思考', '理解', '明白', '复杂', '难忘', '特殊', '莫名', '重要',
  '深刻', '深远', '怀念', '忘记', '充满', '涌现', '应当', '应该',
];

function hits(text, words) {
  const t = String(text || '');
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

function concreteScore(text) {
  return hits(text, IMAGERY) + hits(text, SENSORY) - hits(text, ABSTRACT);
}

/**
 * 从编辑对里挑出"具体化"方向的对：改后比原文更具体（意象/感官增、抽象词减）。
 */
export function detectConcretizationPairs(pairs) {
  const out = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const orig = String(p?.original || '').trim();
    const chg = String(p?.changed || '').trim();
    if (orig.length < 4 || chg.length < 4 || orig === chg) continue;
    if (concreteScore(chg) > concreteScore(orig)) out.push({ original: orig, changed: chg });
  }
  return out;
}

/** 组装 few-shot 拟改提示词。 */
export function buildConcretizationPrompt(pairs, target) {
  const examples = pairs
    .slice(0, 3)
    .map((p) => `原文：${p.original}\n改后：${p.changed}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你是作者的写作拟改助手。下面这组"原文→改后"是作者亲手做过的修改，' +
        '体现了作者"把抽象表达改得更具体、更有画面感"的习惯。请严格模仿这种改法：' +
        '只把抽象、概括的地方改成具体、可感的画面或动作，保留原意与整体节奏，不新增观点，不解释。',
    },
    {
      role: 'user',
      content: `作者亲手修改示例：\n\n${examples}\n\n请按上面的改法，把下面这段改得更具体、更有画面感，只输出改后文本：\n\n${target}`,
    },
  ];
}

/**
 * 具体化拟改：调用 LLM，返回 { ok, text }。失败/过短时原样退回（软性降级，不硬拦）。
 */
export async function concretize(cfg, pairs, target, generate = null) {
  const gen = generate || ((msgs, opts) => chatWithRetry(cfg, msgs, opts));
  const msgs = buildConcretizationPrompt(pairs, target);
  try {
    const text = String(await gen(msgs, { temperature: 0.7, maxTokens: 2000 })).trim();
    if (text.length < 4) return { ok: false, text: target, reason: '拟改输出过短' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: target, reason: String(e?.message || e).slice(0, 120) };
  }
}
