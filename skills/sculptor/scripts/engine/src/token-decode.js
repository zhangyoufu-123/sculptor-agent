// 统一 Token 对比解码 · V1（v0.62）：候选对比解码。
// 写作每节并行生成 n 个候选，用五路信号评分选优：
//   S = β2·log p_personal + λK·S_knowledge + λD·S_defect + R(t)·S_impedance
// 基础信号（β1·log p_base）隐含在候选生成中（由 LLM 采样）；显式 β1 需 logprobs（V2）。
// 每路分数可追溯输出（得分分解），这是"可解释的风格注入"的第一版。
import { chatWithRetry } from './llm.js';
import { getPersonalModel, personalLogProb, personalCorpusSize } from './personal-model.js';
import { listEntries } from './knowledge.js';

// S_defect：作者的系统性回避词表（AI 连接词/套话/空洞表述）
const AI_LEXICON = [
  '在当今', '随着', '与此同时', '因此', '所以', '然而', '但是', '而且', '不仅',
  '总而言之', '综上所述', '值得注意的是', '首先', '其次', '最后', '众所周知',
  '不可否认', '深刻', '前所未有', '充分发挥', '积极作用', '必然趋势', '我们应当',
  '我们应该', '让我们', '赋能', '助力', '点亮', '共赴', '新篇章', '开启', '更加美好的',
];

function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(w, 'g');
    const m = String(text || '').match(re);
    if (m) n += m.length;
  }
  return n;
}

/** S_defect：命中 AI 腔词表越多，分数越低（负偏置）。 */
export function defectScore(text) {
  const hits = countHits(text, AI_LEXICON);
  const chars = Math.max(1, String(text || '').replace(/\s/g, '').length);
  return -Math.min(3, hits * 0.35 + (hits / chars) * 30);
}

/** S_knowledge：候选文本与个人知识库/检索来源的术语重合度（弱正偏，0~+1）。 */
export function knowledgeScore(workspace, text) {
  const t = String(text || '');
  if (!t) return 0;
  let hits = 0;
  try {
    for (const e of listEntries(workspace)) {
      const title = String(e.title || '').replace(/《|》/g, '');
      if (title.length >= 2 && t.includes(title)) hits += 1;
    }
  } catch {}
  return Math.min(1, hits * 0.35);
}

/** S_impedance(w,t)：随写作进度 t∈(0,1] 调制——后期奖励短句、加重惩罚平滑连接词。 */
export function impedanceScore(text, t) {
  const ratio = Math.max(0.05, Math.min(1, Number(t) || 0));
  const sents = String(text || '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const shortRatio = sents.length ? sents.filter((s) => [...s].length <= 8).length / sents.length : 0;
  const connectors = countHits(text, ['因此', '所以', '然而', '而且', '综上所述', '总而言之']);
  return shortRatio * 1.2 * ratio - Math.min(1.2, connectors * 0.25 * ratio);
}

/** 五路信号合成（β2/λK/λD/R 当前为经验默认，消融标定列为后续工作）。 */
export function contrastiveScore(model, workspace, text, { t = 0.5 } = {}) {
  const personal = model && model.ok ? personalLogProb(model, text) : 0;
  const defect = defectScore(text);
  const knowledge = knowledgeScore(workspace, text);
  const impedance = impedanceScore(text, t);
  const score = 2.0 * personal + 0.5 * knowledge + 1.0 * defect + 0.8 * impedance;
  return { score, personal, defect, knowledge, impedance };
}

function decodeN(workspace) {
  const env = Number(process.env.SCULPTOR_DECODE_N || 0);
  if (env >= 1) return env;
  return personalCorpusSize(workspace) >= 200 ? 2 : 1; // 有个人语料才启用对比解码
}

/**
 * V1 候选对比解码：并行生成 n 个候选 → 五路评分 → 选优 → 返回得分分解。
 * @param messages LLM 消息数组（system+user）
 */
export async function decodeSection(
  cfg,
  workspace,
  { messages, temperature = 0.85, maxTokens = 3000, t = 0.5, generate = null },
) {
  const n = decodeN(workspace);
  const model = getPersonalModel(workspace);
  const gen = generate || ((msgs, opts) => chatWithRetry(cfg, msgs, opts));
  if (n < 2 || !model.ok) {
    const body = await gen(messages, { temperature, maxTokens });
    return {
      text: String(body || '').trim(),
      mode: 'direct',
      reason: model.ok ? '未启用对比（SCULPTOR_DECODE_N 或语料 <200 字符）' : '无个人语料（p_personal 缺失）',
      n: 1,
      breakdown: null,
    };
  }
  const temps = Array.from({ length: n }, (_, k) => Math.min(1.15, temperature + (k - (n - 1) / 2) * 0.12));
  const candidates = await Promise.all(
    temps.map((tp) =>
      gen(messages, { temperature: tp, maxTokens }).catch((e) => ({
        __err: String(e?.message || e).slice(0, 120),
      })),
    ),
  );
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (typeof c !== 'string' || c.__err) continue;
    const text = String(c || '').trim();
    if (text.length < 10) continue;
    const s = contrastiveScore(model, workspace, text, { t });
    scored.push({ i, text, ...s });
  }
  if (!scored.length) {
    const body = candidates.find((c) => typeof c === 'string') || '';
    return { text: String(body || '').trim(), mode: 'fallback', reason: '候选生成失败', n, breakdown: null };
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    text: best.text,
    mode: 'contrastive',
    reason: `从 ${scored.length} 个候选中按五路信号选优`,
    n: scored.length,
    breakdown: scored.map((s) => ({
      rank: scored.indexOf(s) + 1,
      chars: s.text.replace(/\s/g, '').length,
      score: Number(s.score.toFixed(3)),
      personal: Number(s.personal.toFixed(3)),
      defect: Number(s.defect.toFixed(3)),
      knowledge: Number(s.knowledge.toFixed(3)),
      impedance: Number(s.impedance.toFixed(3)),
    })),
  };
}
