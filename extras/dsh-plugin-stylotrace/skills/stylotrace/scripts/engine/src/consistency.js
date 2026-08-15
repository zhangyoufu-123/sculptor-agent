// 伏笔记账 + 跨章回收校验（v0.41，对标行业"一致性"尺子）。
// 写每节小说时自动记账（registerClues），全文完成后跨章校验伏笔是否回收（checkConsistency）。
// 设计纪律：LLM 优先、确定性兜底、绝不阻塞流程；只记录、只提示，不擅自改写正文。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';

const CLUE_PROMPT = (ctx) => `你是小说结构编辑。阅读这一节正文，找出作者埋下的、需要在后文回收的伏笔/钩子/长线意象
（某句话、某个物件、某个细节、某句台词、某种预感、某个未解之谜）。只挑真正像伏笔的，宁缺毋滥，最多 5 条。
已有伏笔不要重复记。

【本节标题】${ctx.heading || '（无）'}
【已有伏笔】${ctx.existing || '（无）'}
【本节正文】
${String(ctx.text || '').slice(0, 6000)}

输出严格 JSON：{"clues":["伏笔1（一句话，可检索）","伏笔2"]}`;

const CHECK_PROMPT = (ctx) => `你是小说一致性编辑。下面是一部小说的伏笔清单与全文。
逐条判断每条伏笔是否在【埋设章节之后】被回收/呼应/兑现（直接呼应、反转兑现、意象再现、疑问解开都算；
仅在自己出现的章节出现不算回收）。

【伏笔清单】
${ctx.clues}
【全文】
${String(ctx.text || '').slice(0, 14000)}

输出严格 JSON：{"items":[{"clue":"伏笔原文","recovered":true,"section":"回收章节标题或'未回收'","note":"一句话说明"}]}`;

// 确定性兜底：包含这些标记的长句视为"疑似伏笔"（无 LLM 时的安全网）。
const FALLBACK_MARKERS = [
  '却', '但', '似乎', '仿佛', '好像', '也许', '或许', '难道', '到底', '究竟',
  '总有一天', '再也没有', '总觉得', '忘不了', '不祥', '隐隐', '那个', '那把', '那扇', '信',
];

function splitSections(text) {
  return String(text || '')
    .split(/\n(?=## )/)
    .filter(Boolean)
    .map((b) => {
      const heading = (b.match(/^##\s+(.+)$/m) || [])[1]?.trim() || '（正文）';
      return { heading, body: b.replace(/^##\s+.+$/m, '') };
    });
}

export function normClue(s) {
  return String(s || '').replace(/[，。！？、,.!?\s"'“”‘’《》]/g, '');
}

/** 确定性兜底：从正文里挑"疑似伏笔"的长句（含转折/悬念/未解标记）。 */
export function extractClueCandidates(text) {
  const sents = String(text || '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 8);
  const out = [];
  for (const s of sents) {
    if (FALLBACK_MARKERS.some((m) => s.includes(m))) out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

function dedupeClues(extracted, existing) {
  const seen = new Set((existing || []).map((c) => normClue(c.clue)));
  const fresh = [];
  for (const raw of extracted || []) {
    const clue = String(raw?.clue ?? raw ?? '').trim();
    if (!clue || clue.length < 4) continue;
    const key = normClue(clue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(clue);
  }
  return fresh;
}

/**
 * 伏笔记账：从刚写完的一节提炼伏笔，与已有伏笔合并后返回（不落盘，由调用方写 state）。
 * 无 API key 或 LLM 失败时走确定性兜底，绝不让写作流程被卡住。
 */
export async function registerClues(cfg, workspace, { text, heading = '', sectionIndex = 0 } = {}) {
  const state = ws.readState(workspace);
  const existing = state.mystery?.clues || [];
  let extracted = [];
  if (cfg?.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是小说结构编辑，只输出严格 JSON。' },
          {
            role: 'user',
            content: CLUE_PROMPT({
              heading,
              existing: existing.map((c) => c.clue).slice(-5).join('；'),
              text,
            }),
          },
        ],
        { json: true, temperature: 0.2, maxTokens: 800 },
      );
      const r = parseJsonContent(content, '伏笔');
      extracted = Array.isArray(r.clues) ? r.clues : [];
    } catch {
      extracted = [];
    }
  }
  if (!extracted.length) extracted = extractClueCandidates(text);
  const fresh = dedupeClues(extracted, existing);
  if (!fresh.length) return { added: 0, clues: existing };
  const withMeta = fresh.map((clue, i) => ({
    id: `clue-${Date.now().toString(36)}-${i}`,
    clue,
    plantedSection: heading,
    index: Number(sectionIndex) || 0,
    plantedAt: ws.nowIso(),
    recovered: false,
  }));
  const merged = [...existing, ...withMeta].slice(-40);
  return { added: withMeta.length, clues: merged };
}

/** 确定性兜底：伏笔的关键二元组是否出现在"埋设节之后"的正文里。 */
function deterministicRecovery(clues, sections) {
  return (clues || []).map((c) => {
    // 去掉常见虚词后取内容二元组，避免"再也/那把"这类通用词误判；命中任一内容词即算候选回收
    // （LLM 可用时由其精判，确定性结果只是安全网，宁多报回收、不误报悬空）。
    const STOP = new Set('的了吗呢吧啊哦却但那这再也就都还又很太不没有是在把被和与或于而把将向为着');
    const chars = [...normClue(c.clue)].filter(
      (ch) => /[\u4e00-\u9fff]/.test(ch) && !STOP.has(ch),
    );
    const grams = [];
    for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i] + chars[i + 1]);
    if (grams.length < 2) {
      // 内容词太少（如只剩一个双字词）时退回原文二元组
      const rawChars = [...normClue(c.clue)].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
      for (let i = 0; i + 1 < rawChars.length; i++) grams.push(rawChars[i] + rawChars[i + 1]);
    }
    const later = sections.slice((c.index ?? 0) + 1);
    let best = 0;
    let hitSection = '';
    for (const sec of later) {
      let hit = 0;
      for (const g of grams) if (sec.body.includes(g)) hit += 1;
      if (hit > best) {
        best = hit;
        hitSection = sec.heading;
      }
    }
    return {
      clue: c.clue,
      planted: c.plantedSection || '',
      recovered: best >= 1,
      section: best >= 1 ? hitSection : '',
      note: '',
    };
  });
}

/**
 * 跨章回收校验：读成稿 + 已记账伏笔，判定每条是否在后文回收。
 * LLM 判定优先、确定性兜底；结果落 vault/consistency.md 并写回 state.quality.consistency。
 */
export async function checkConsistency(cfg, workspace, { file } = {}) {
  const state = ws.readState(workspace);
  const clues = state.mystery?.clues || [];
  const draftFile = file || path.join(workspace, 'draft.md');
  let text = '';
  try {
    text = fs.readFileSync(draftFile, 'utf8');
  } catch {
    return { score: 100, total: 0, recovered: [], unrecovered: [], file: '', note: '（还没有成稿）' };
  }
  if (!clues.length) {
    return {
      score: 100,
      total: 0,
      recovered: [],
      unrecovered: [],
      file: '',
      note: '（没有已记账的伏笔——小说/推理写作每节会自动记账）',
    };
  }
  const sections = splitSections(text);
  let items = deterministicRecovery(clues, sections);
  if (cfg?.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是小说一致性编辑，只输出严格 JSON。' },
          {
            role: 'user',
            content: CHECK_PROMPT({
              clues: clues.map((c, i) => `${i + 1}. ${c.clue}（埋设于「${c.plantedSection || '?'}」）`).join('\n'),
              text,
            }),
          },
        ],
        { json: true, temperature: 0.2, maxTokens: 1800 },
      );
      const r = parseJsonContent(content, '一致性');
      if (Array.isArray(r.items)) {
        const byClue = new Map(r.items.map((i) => [normClue(i.clue), i]));
        items = items.map((d) => {
          const llm = byClue.get(normClue(d.clue));
          if (llm && typeof llm.recovered === 'boolean') {
            return {
              ...d,
              recovered: llm.recovered,
              section: String(llm.section || d.section || '').trim(),
              note: String(llm.note || '').trim(),
            };
          }
          return d;
        });
      }
    } catch {
      // 确定性结果已足够，静默降级
    }
  }
  const recovered = items.filter((i) => i.recovered);
  const unrecovered = items.filter((i) => !i.recovered);
  const score = items.length ? Math.round((recovered.length / items.length) * 100) : 100;
  const out = { score, total: items.length, recovered, unrecovered, note: '' };
  const filePath = path.join(workspace, 'vault', 'consistency.md');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderConsistency(out) + '\n');
    out.file = filePath;
  } catch {
    out.file = '';
  }
  // 回写：伏笔回收标记 + quality.consistency（供交付消息与 Web 查询）
  const byKey = new Map(items.map((i) => [normClue(i.clue), i]));
  state.mystery = state.mystery || {};
  state.mystery.clues = clues.map((c) => ({
    ...c,
    recovered: Boolean(byKey.get(normClue(c.clue))?.recovered),
  }));
  state.quality = state.quality || {};
  state.quality.consistency = {
    score,
    total: items.length,
    recovered: recovered.length,
    unrecovered: unrecovered.length,
    ts: ws.nowIso(),
  };
  ws.writeState(workspace, state);
  return out;
}

/** 一致性报告人类可读渲染。 */
export function renderConsistency(r) {
  const lines = ['# 伏笔回收校验', ''];
  if (r.note) {
    lines.push(r.note, '');
    return lines.join('\n');
  }
  lines.push(`一致性得分 ${r.score}/100（${r.recovered.length}/${r.total} 条伏笔已回收）`, '');
  if (r.recovered.length) {
    lines.push('## 已回收');
    for (const i of r.recovered) {
      lines.push(`- ${i.clue}${i.section ? ` → 于「${i.section}」` : ''}${i.note ? `（${i.note}）` : ''}`);
    }
    lines.push('');
  }
  if (r.unrecovered.length) {
    lines.push('## 未回收 / 疑似悬空（P1 提示，作者拍板是否补）');
    for (const i of r.unrecovered) {
      lines.push(
        `- ${i.clue}（埋设于「${i.planted || '?'}」）${i.note ? ` — ${i.note}` : ' — 后文没有明显呼应'}`,
      );
    }
    lines.push('');
    lines.push('提示：悬空伏笔可以是留白设计，也可以在后文补一次呼应；本报告不擅自改动正文。');
  }
  return lines.join('\n');
}
