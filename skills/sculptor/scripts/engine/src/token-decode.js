// 统一 Token 对比解码 · V1.5（v0.64）：候选对比解码 + 外层调制器。
// 写作每节并行生成 n 个候选，用调制器评分选优：
//   S(x|c,t) = w₀ + Σᵢ wᵢ·fᵢ(x,c,t) + w_personal·log p_personal(x)
// 有编辑对时权重由作者偏好对学习（小数据微调，见 modulator.js），
// 无编辑对时回退经验默认（等价 v0.62 五路权重）。
// 基础信号（β1·log p_base）隐含在候选生成中（由 LLM 采样）；显式 β1 需 logprobs（V2）。
// 每路分数可追溯输出（得分分解），这是"可解释的风格注入"的第二版。
import { chatWithRetry } from './llm.js';
import { getPersonalModel, personalCorpusSize } from './personal-model.js';
import { modulate, collectModulatorData } from './modulator.js';
import { authorPrototype, embedText } from './embedding.js';

// 向后兼容导出（V1 的测试与调用方仍按原名取用）
export { defectScore, impedanceScore, knowledgeScore } from './modulator.js';

/** 调制器评分（有学习权重用学习权重，否则经验默认）。 */
export function contrastiveScore(model, workspace, text, { t = 0.5, prototype = null, candidateEmbedding = null } = {}) {
  const m = modulate(workspace, text, { t, prototype, candidateEmbedding });
  return {
    score: m.score,
    personal: m.features.personal,
    defect: m.features.defect,
    knowledge: m.features.knowledge,
    impedance: m.features.impedance,
    surface: m.features.surface,
    discourse: m.features.discourse,
    stance: m.features.stance,
    vector: m.features.vector,
    embedding: m.features.embedding,
    fineread: m.features.fineread,
    posture: m.features.posture,
    avoidance: m.features.avoidance,
    transform: m.features.transform,
    rationale: m.rationale,
    weights: m.weights,
    trained: m.trained,
    mode: m.mode,
  };
}

function decodeN(workspace) {
  const env = Number(process.env.SCULPTOR_DECODE_N || 0);
  if (env >= 1) return env;
  const corpus = personalCorpusSize(workspace);
  if (corpus >= 200) return 2;
  // 小样本冷启动（v1.6）：存在 ≥1 条作者亲手编辑对即启用对比解码——
  // 其余 11 维可解释特征仍然有效，不依赖个人 n-gram 模型。
  try {
    const data = collectModulatorData(workspace);
    if (data.pairs.length >= 1) return 2;
  } catch {}
  return 1;
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
  if (n < 2) {
    const body = await gen(messages, { temperature, maxTokens });
    return {
      text: String(body || '').trim(),
      mode: 'direct',
      reason: '未启用对比（无个人语料且无编辑对；可设 SCULPTOR_DECODE_N 强制开启）',
      n: 1,
      breakdown: null,
    };
  }
  const prototype = await authorPrototype(cfg, workspace).catch(() => ({ ok: false }));
  const temps = Array.from({ length: n }, (_, k) => Math.min(1.15, temperature + (k - (n - 1) / 2) * 0.12));
  const candidates = await Promise.all(
    temps.map((tp) =>
      gen(messages, { temperature: tp, maxTokens }).catch((e) => ({
        __err: String(e?.message || e).slice(0, 120),
      })),
    ),
  );
  const scored = [];
  const embeds = await Promise.all(
    candidates.map((c) =>
      typeof c === 'string' && !c.__err ? embedText(cfg, String(c).trim()).catch(() => null) : Promise.resolve(null),
    ),
  );
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (typeof c !== 'string' || c.__err) continue;
    const text = String(c || '').trim();
    if (text.length < 10) continue;
    const s = contrastiveScore(model, workspace, text, {
      t,
      prototype: prototype.ok ? prototype : null,
      candidateEmbedding: embeds[i],
    });
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
      surface: Number(s.surface.toFixed(3)),
      discourse: Number(s.discourse.toFixed(3)),
      stance: Number(s.stance.toFixed(3)),
      vector: Number(s.vector.toFixed(3)),
      embedding: Number(s.embedding.toFixed(3)),
      fineread: Number(s.fineread.toFixed(3)),
      posture: Number(s.posture.toFixed(3)),
      avoidance: Number(s.avoidance.toFixed(3)),
      transform: Number(s.transform.toFixed(3)),
      rationale: s.rationale || '',
      trained: Boolean(s.trained),
      mode: s.mode,
    })),
  };
}
