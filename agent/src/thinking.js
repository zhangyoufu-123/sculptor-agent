// 思想脉络（Thinking Thread，v0.43）：
// 用户抛出理论、因果推理或引用某本书的论述时，追踪"主张-前提-推理-来源"，
// 并顺着用户思路做一步概括，让追问从"收集素材"升级为"挖掘思想"。
// 设计依据：AI 只知道"1+1"，用户知道"为什么 1+1"——思想脉络就是把
// 用户头脑里的推理过程显影出来，与用户达成思想层面的共识，再让大纲从共识里生长。
// LLM 优先做理论概括；确定性只做信号识别与兜底（绝不替代 LLM 的判断）。
import { chatWithRetry, parseJsonContent } from './llm.js';

export const THINKING_PROMPT = (ctx) => `你是思想对话者。用户刚刚说了一段话，其中可能有主张、前提、推理或理论引用。
请提炼真正成形的思想（宁缺毋滥，不成形的字段留空）：
- claim：用户的主张（一句话，用用户原词）
- premise：他立论的前提/根据（可以是某本书的论述、某个经历、某个观察）
- inference：他自己做出的推理链（因为X，所以Y）
- source：引用的书/理论/人（如《乡土中国》）
- openQuestion：顺着他的思想往下，最值得他再想一步的一个问题（只 1 个，别贪多）

【用户刚说】
${ctx.text || ''}
【已有思想脉络】
${ctx.existing || '（无）'}

输出严格 JSON：{"claim":"","premise":"","inference":"","source":"","openQuestion":""}`;

const CAUSAL_RE = /因为|由于|所以|因此|于是|之所以|归根结底|本质|其实|说白了|可以顺着|顺着.{0,6}思路|推理|推论|反推|由此|这就意味着/;
const CLAIM_RE = /我认为|我觉得|我的理解|关键是|问题在于|根本是|重要的是|我想说|我的意思是/;
const BOOK_RE = /《([^》]{2,24})》/;

/** 确定性信号识别：这段发言里有没有"思想"（主张/推理/理论引用）。 */
export function extractThinkingSignals(text) {
  const t = String(text || '').trim();
  if (!t) return { hasThinking: false, signals: [] };
  const signals = [];
  if (CAUSAL_RE.test(t)) signals.push({ kind: 'inference', snippet: t.slice(0, 80) });
  if (CLAIM_RE.test(t)) signals.push({ kind: 'claim', snippet: t.slice(0, 80) });
  const book = t.match(BOOK_RE);
  if (book) signals.push({ kind: 'source', snippet: `《${book[1]}》` });
  return { hasThinking: signals.length > 0, signals };
}

/** 人类可读的思想脉络摘要（注入追问设计师与大纲生成器）。 */
export function thinkingBrief(state) {
  const th = Array.isArray(state?.thinking) ? state.thinking : [];
  if (!th.length) return '';
  return th
    .map((x, i) => {
      const parts = [];
      if (x.claim) parts.push(`主张：${x.claim}`);
      if (x.premise) parts.push(`前提：${x.premise}`);
      if (x.inference) parts.push(`推理：${x.inference}`);
      if (x.source) parts.push(`来源：${x.source}`);
      if (x.openQuestion) parts.push(`可深挖：${x.openQuestion}`);
      return `${i + 1}. ${parts.join('；')}`;
    })
    .join('\n');
}

/** LLM 提炼单条思想（失败返回 null，绝不阻塞澄清）。 */
export async function extractThinkingWithLLM(cfg, text, existing = '') {
  if (!cfg?.apiKey) return null;
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是思想对话者，只输出严格 JSON，不成形的字段留空。' },
        { role: 'user', content: THINKING_PROMPT({ text, existing }) },
      ],
      { json: true, temperature: 0.3, maxTokens: 500 },
    );
    const r = parseJsonContent(content, '思想');
    if (!r || typeof r !== 'object') return null;
    const has = ['claim', 'premise', 'inference', 'source', 'openQuestion'].some(
      (k) => String(r[k] || '').trim(),
    );
    return has ? r : null;
  } catch {
    return null;
  }
}

/** 把一条思想合并进 state.thinking（按来源/主张去重；最多保留 6 条）。 */
export function updateThinkingThread(state, text, llmEntry = null) {
  const th = Array.isArray(state?.thinking) ? state.thinking : [];
  const det = extractThinkingSignals(text);
  if (!det.hasThinking && !llmEntry) return { updated: 0 };
  const entry = { ...(llmEntry || {}) };
  if (!entry.claim && !entry.premise && !entry.inference && !entry.source) {
    entry.claim = det.signals.find((s) => s.kind === 'claim')?.snippet || '';
    entry.inference = det.signals.find((s) => s.kind === 'inference')?.snippet || '';
    entry.source = det.signals.find((s) => s.kind === 'source')?.snippet || '';
  }
  if (!entry.claim && !entry.premise && !entry.inference && !entry.source) return { updated: 0 };
  // 去重：同来源（书/理论）合并，同主张合并
  const norm = (s) => String(s || '').replace(/[，。！？、,.！\s]/g, '');
  const dup = th.find(
    (x) =>
      (entry.source && x.source && norm(entry.source) === norm(x.source)) ||
      (entry.claim && x.claim && norm(entry.claim) === norm(x.claim)),
  );
  if (dup) {
    for (const k of ['claim', 'premise', 'inference', 'source', 'openQuestion']) {
      if (entry[k] && !dup[k]) dup[k] = entry[k];
    }
    dup.ts = new Date().toISOString();
    return { updated: 1, merged: true };
  }
  th.push({ ...entry, ts: new Date().toISOString() });
  if (th.length > 6) th.shift();
  state.thinking = th;
  return { updated: 1 };
}
