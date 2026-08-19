// 复阅-修订循环（v0.23，参考 Flower & Hayes 认知写作模型：规划→转译→复阅）。
// 初稿完成后做一次全文复查：偏题/衔接/素材用足/字数，P0 问题自动局部修订一轮（静默）。
// 同时提供确定性情绪曲线量化（叙事弧/冯内古特情绪曲线思路）。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { governanceBrief } from './governance.js';

export const REVISE_PROMPT = (ctx) => `你是严格的编辑。复查这篇初稿，找出必须修的问题：
1) 偏题：有没有节脱离了核心立意/论点；
2) 衔接：节与节之间是否断裂、无过渡；
3) 素材：用户已确认的素材有没有明显没用到；
4) 字数：有没有节明显注水或严重不足。
只报告有依据的问题，宁缺毋滥。

【核心立意】${ctx.theme || ''}
【论点】${ctx.arguments || ''}
【素材】${ctx.materials || ''}
【大纲】${ctx.outline || ''}
${ctx.governance ? `【作者长期意图与当前聚焦】（判断偏题时以此为锚）\n${ctx.governance}` : ''}
【全文】
${ctx.text}

输出严格 JSON：
{"score":0,"issues":[{"severity":"p0|p1","section":"","problem":""}],"direction":"若需修订，用一句话说清方向"}`;

/** LLM 全文复查；失败/无密钥 → 确定性空结果（不阻塞流程）。 */
export async function reviseScan(cfg, workspace) {
  const state = ws.readState(workspace);
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  } catch {
    return { score: 100, issues: [], direction: '' };
  }
  const outline = (state.outline?.sections || [])
    .map((s) => `- ${s.heading}（${s.function}）${s.thesis ? `：${s.thesis}` : ''}`)
    .join('\n');
  const ctx = {
    theme: state.confirmed?.theme || '',
    arguments: (state.confirmed?.arguments || []).join('；'),
    materials: (state.materials || []).slice(0, 12).join('；'),
    outline,
    governance: governanceBrief(workspace),
    text: text.slice(0, 9000),
  };
  if (!cfg?.apiKey) return { score: 100, issues: [], direction: '', skipped: true };
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是严格但克制的编辑。' },
        { role: 'user', content: REVISE_PROMPT(ctx) },
      ],
      { json: true, temperature: 0.3, maxTokens: 1200 },
    );
    const r = parseJsonContent(content, '复查');
    const issues = Array.isArray(r.issues) ? r.issues.filter((i) => i?.problem) : [];
    return {
      score: Number(r.score) || 100,
      issues,
      p0: issues.filter((i) => String(i.severity || '').toLowerCase() === 'p0'),
      direction: String(r.direction || '').trim(),
    };
  } catch {
    return { score: 100, issues: [], direction: '', skipped: true };
  }
}

// ── 情绪曲线（确定性）：按节统计情绪词强度，输出 0-1 曲线 ──
const MOOD_LEXICON = {
  平静: ['平静', '安宁', '安静', '平淡', '从容', '缓缓', '呼吸', '沉默'],
  喜悦: ['笑', '喜', '亮', '暖', '希望', '甜', '雀跃', '舒展'],
  哀伤: ['泪', '哭', '悲', '痛', '冷', '灰', '暗', '空', '失去', '告别', '遗憾'],
  愤怒: ['怒', '恨', '愤', '拳头', '咬', '凭什么', '不甘'],
  张力: ['突然', '猛地', '颤抖', '屏住', '危险', '逼近', '反光', '脚步声', '倒吸'],
};

/** 把全文按 ## 分节，输出每节情绪强度（0-1）与主导情绪。 */
export function emotionCurve(text) {
  const blocks = String(text || '')
    .split(/\n(?=## )/)
    .map((b) => {
      const heading = (b.match(/^##\s+(.+)$/m) || [])[1]?.trim() || '（正文）';
      return { heading, body: b.replace(/^##\s+.+$/m, '') };
    });
  return blocks.map((b) => {
    const counts = {};
    let total = 0;
    for (const [mood, words] of Object.entries(MOOD_LEXICON)) {
      const n = words.reduce((s, w) => s + (b.body.match(new RegExp(w, 'g')) || []).length, 0);
      counts[mood] = n;
      total += n;
    }
    const dominant = Object.entries(counts).sort((a, c) => c[1] - a[1])[0] || ['平静', 0];
    return {
      section: b.heading,
      intensity: Math.min(1, Number((total / Math.max(1, b.body.length / 60)).toFixed(2))),
      dominant: dominant[1] > 0 ? dominant[0] : '平静',
      mood: counts,
    };
  });
}

/** 情绪曲线人类可读渲染。 */
export function renderEmotionCurve(curve) {
  if (!curve?.length) return '（无可分节文本）';
  const rows = curve.map(
    (c) =>
      `  ${c.section}：${'▂▄▆█'[Math.min(3, Math.round(c.intensity * 3))]} 强度 ${c.intensity} · ${c.dominant}`,
  );
  return ['情绪曲线（确定性量化，供参考）:', ...rows].join('\n');
}
