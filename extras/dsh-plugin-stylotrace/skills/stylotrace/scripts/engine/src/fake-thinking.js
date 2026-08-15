// 假思考细读诊断（v0.52 确定性 → v0.53 LLM 主导 + RAG 作者对照）。
// 背景：v0.52 用正则（金句排比/路标转折/点题顿悟）检测"表演思考"，但这是硬编码；
// 真实问题（《语言匮乏》六层细读：声音分裂/过渡机械/修辞空转/引用挂靠/翻译体/收尾表演）
// 需要 LLM 逐句判断，且要"知道作者是谁"才有参照。
// 本模块：LLM 按六层细读 + 注入 persona/个人写作 skill/RAG 检索作对照；无 key 或失败
// 时降级为确定性正则（离线兜底，不再是主路径）。
import { chatWithRetry, parseJsonContent } from './llm.js';
import { personaBrief } from './persona.js';
import { loadPersonalSkill } from './library.js';
import { unifiedBrief } from './rag.js';

export const DIAGNOSE_PROMPT = (ctx) => `你是文本细读编辑。用"逐句细读"的方式诊断这段文本的
"假思考/失语"问题——不是文学赏析，是找病灶。宁缺毋滥，没有依据就不报。

【作者设定（第一人称叙事时，用它判断"这个声音像不像设定里的人"）】
${ctx.authorContext || '（无，跳过声音一致性维度）'}

【同类真实文本参考（RAG：作者旧作 / 个人写作 skill / 检索来源）】
${ctx.refs || '（无）'}

【原文】
${String(ctx.text || '').slice(0, 9000)}

逐层细读，只报有依据的问题（每层 0-3 条）：
- voice（声音）：叙述者语言能力与设定矛盾（角色嘴和作者手分离）、用熟练语言讲述失语
- transition（过渡）：过渡句公式化（"后来我想/先把××说清楚/但这里头有个悖论"）、
  元叙述跳出报进度（"到这里，我已经把××批判过一轮了"）
- rhetoric（修辞）：排比/对仗/重复语义空洞、修辞代替论证
- citation（引用）：引用/数据过于整齐精确（检索式写作痕迹，不像真实记忆的错位与冗余）
- translate（翻译体）："翻译过来就是/说白了就是/意思是说"高频，解释代替呈现
- ending（收尾）：金句排比同义反复、落点太轻逃避难度、形式高潮内容悬空

输出严格 JSON：
{"score":0,"issues":[{"layer":"voice","quote":"原文摘录","problem":"一句话说清病灶","fix":"按作者设定该怎么改（一句话）"}]}
score 为"假思考程度"0-100，30 以下为健康；无问题则 issues 为空数组。`;

/** 确定性兜底（v0.52 规则，离线/无 key 时使用）：金句排比 / 路标转折 / 点题顿悟。 */
export function deterministicFakeThinking(text) {
  const all = String(text || '');
  const issues = [];
  const goldenClosers = all.match(/(，是[\u4e00-\u9fff]{1,10}){2,}[。！？]/g) || [];
  for (const g of goldenClosers) {
    issues.push({
      layer: 'ending',
      quote: g.slice(0, 28),
      problem: '金句排比收束：同义反复做形式高潮',
      fix: '拆成一句笨拙、具体、说一半的话，不要排比递进点题',
    });
  }
  const signposts =
    (all.match(/后来我想|然后我就想|但这里头有个悖论|我绕了很久才绕出来|想了很久，|让我重新想/g) || [])
      .length;
  if (signposts >= 3) {
    issues.push({
      layer: 'transition',
      quote: '（多处）',
      problem: `路标式转折 ${signposts} 次：作者在走流程，不在思考`,
      fix: '删掉路标，把转折藏在动作/细节/沉默里',
    });
  }
  const epiphanies = (all.match(/我终于明白|原来[^。！？]{0,14}才是|其实[^。！？]{0,10}就是/g) || []).length;
  if (epiphanies >= 2) {
    issues.push({
      layer: 'ending',
      quote: '（多处）',
      problem: `点题式顿悟 ${epiphanies} 处：思考被提前宣告完成`,
      fix: '让结论留一半，不要"我终于明白"式收束',
    });
  }
  return {
    score: issues.length ? Math.min(90, 35 + issues.length * 18) : 0,
    issues: issues.slice(0, 12),
    layers: [...new Set(issues.map((i) => i.layer))],
  };
}

/**
 * 假思考细读诊断（v0.53，LLM 主导 + RAG 作者对照）。
 * @returns {score, issues, layers, mode: 'llm'|'deterministic'|'skip'}
 */
export async function diagnoseFakeThinking(
  cfg,
  workspace,
  { text, genre = '', topic = '' } = {},
) {
  const src = String(text || '').trim();
  if (!src) return { score: 0, issues: [], layers: [], mode: 'skip' };
  const det = deterministicFakeThinking(src);
  if (!cfg?.apiKey) return { ...det, mode: 'deterministic' };
  try {
    const authorContext = [
      personaBrief(workspace, { limit: 2 }),
      loadPersonalSkill(workspace, { category: genre }),
    ]
      .filter(Boolean)
      .join('\n');
    const refs = unifiedBrief(workspace, `${topic} ${genre || ''}`, { limit: 3 });
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是文本细读编辑，只输出严格 JSON，无依据不报。' },
        { role: 'user', content: DIAGNOSE_PROMPT({ authorContext, refs, text: src }) },
      ],
      { json: true, temperature: 0.2, maxTokens: 2200 },
    );
    const r = parseJsonContent(content, '细读');
    const issues = (Array.isArray(r.issues) ? r.issues : [])
      .filter((i) => i?.problem && typeof i.problem === 'string')
      .slice(0, 12);
    const score = Math.max(0, Math.min(100, Number(r.score) || 0));
    return { score, issues, layers: [...new Set(issues.map((i) => i.layer))], mode: 'llm' };
  } catch {
    return { ...det, mode: 'deterministic' };
  }
}

/** 人类可读渲染（CLI/审计报告用）。 */
export function renderFakeThinking(r) {
  const lines = [];
  if (r?.mode === 'skip') return '（无文本可诊断）';
  lines.push(
    `假思考细读：${r.mode === 'llm' ? 'LLM 六层细读（RAG 作者对照）' : '确定性兜底'} · 得分 ${r.score}/100${r.score >= 60 ? '（高，需修订）' : r.score >= 30 ? '（中，建议改）' : '（健康）'}`,
  );
  for (const i of r.issues || []) {
    lines.push(
      `  [${i.layer}] ${i.problem}${i.quote ? `｜「${String(i.quote).slice(0, 30)}${String(i.quote).length > 30 ? '…' : ''}」` : ''}${i.fix ? ` → ${i.fix}` : ''}`,
    );
  }
  if (!(r.issues || []).length) lines.push('  （未发现假思考痕迹）');
  return lines.join('\n');
}
