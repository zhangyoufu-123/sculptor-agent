// 意图理解层（v0.25）：解决"澄清主次不清、扣细节、无法与用户达成共识"。
// 参考 ICA（Intent-Compression / clarify-first）与 alignment-first 对话设计：
//   1) 每轮先复述"我的理解"（grounding），让用户确认或纠正；
//   2) 只问"答案会改变文章走向"的高价值全局问题（主题/目的/读者/核心主张/结构）；
//   3) 细节（措辞、小场景、格式）不问——留到写作中自动处理或写后修改。
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';

export const INTENT_PROMPT = (ctx) => `你是写作意图分析师。基于用户全部发言，提炼"TA 到底要写什么、为什么写、最在意什么"。
要求：只写有依据的；没提到的写空；不要臆测细节偏好。

【用户全部发言】
${ctx.utterances || '（刚开始）'}
【已确认信息】
${ctx.confirmed || '（无）'}
【素材】
${ctx.materials || '（无）'}

输出严格 JSON：
{"summary":"用一两句话复述用户要写的东西和核心诉求（用用户自己的词）","coreNeed":"最核心的需求（目的/场合/读者/想达到的效果）","decided":"用户已经明确决定的（如文体/长度/风格方向/结构）","openHighValue":"还缺哪些会改变文章走向的高价值信息（最多 3 项；没有就空数组）","risks":"理解上可能存在的偏差或风险（最多 2 条；没有就空数组）"}`;

/** 确定性兜底：从已确认字段拼理解摘要（无 LLM 时保命）。 */
export function intentFallback(state) {
  const c = state?.confirmed || {};
  const parts = [];
  if (c.topic) parts.push(`想写《${c.topic}》`);
  if (c.genre) parts.push(`文体：${c.genre}`);
  if (c.stance) parts.push(`目的是：${c.stance}`);
  if (c.theme) parts.push(`核心立意：${c.theme}`);
  if (c.audience) parts.push(`给${c.audience}看`);
  if (c.targetWords) parts.push(`约 ${c.targetWords} 字`);
  return {
    summary: parts.join('；') || '（刚开始，还不清楚用户要写什么）',
    coreNeed: c.stance || c.theme || '',
    decided: [c.genre, c.targetWords ? `${c.targetWords} 字` : '', c.styleNote].filter(Boolean).join('；'),
    openHighValue: [],
    risks: [],
  };
}

/**
 * 更新意图理解（LLM；失败确定性兜底，绝不阻塞）。结果写入 state.intent。
 */
export async function understandIntent(cfg, workspace, state) {
  const c = state?.confirmed || {};
  const confirmed = Object.entries(c)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  const materials = (state?.materials || []).slice(0, 10).join('\n');
  const utterances = (state?.lastInput ? [state.lastInput] : []).join('\n');
  let intent = null;
  if (cfg?.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是写作意图分析师，只依据给出的发言提炼，不臆测。' },
          { role: 'user', content: INTENT_PROMPT({ utterances, confirmed, materials }) },
        ],
        { json: true, temperature: 0.3, maxTokens: 900 },
      );
      intent = parseJsonContent(content, '意图');
    } catch {
      intent = null;
    }
  }
  const next = intent && typeof intent === 'object' ? intent : intentFallback(state);
  next.updatedAt = ws.nowIso();
  state.intent = next;
  return next;
}

/** 注入问题生成器的"我的理解"文本。 */
export function intentBrief(state) {
  const i = state?.intent;
  if (!i) return '';
  const lines = [];
  if (i.summary) lines.push(`我的理解：${i.summary}`);
  if (i.coreNeed) lines.push(`核心诉求：${i.coreNeed}`);
  if (i.risks?.length) lines.push(`我担心理解偏了：${i.risks.join('；')}`);
  return lines.join('\n');
}
