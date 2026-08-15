// Phase 1 澄清：一次一问、带建议、从用户原话生长；连续两次低意愿即终止。
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { QUESTIONER_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import {
  applyStyleSignals,
  applyStyleDirection,
  styleProgress,
  extractStyleFromSamples,
  recordImplicitSignals,
} from './style.js';
import { pulseAfterClarify, pushPulseToState } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';
import { detectGenre, genreBlueprint, isOfficialGenre } from './genre.js';
import { parseTargetWords, guessTargetWords } from './budget.js';
import { extractInput } from './io.js';
import { understandIntent, intentBrief } from './intent.js';
import {
  extractThinkingWithLLM,
  extractThinkingSignals,
  updateThinkingThread,
  thinkingBrief,
} from './thinking.js';
import {
  knowledgeSuggestion,
  captureKbMentions,
  captureKnowledgeAI,
  confirmLowConfidenceEntries,
  recommendReadings,
  listEntries,
  normTitle,
  markAsked,
  wasAsked,
} from './knowledge.js';
import {
  dataSuggestion,
  queueAssetSearch,
  webRecommendation,
  explicitSearchSuggestion,
  unifiedBrief,
} from './rag.js';
import { academicGap } from './academic.js';
import { outlineProgress } from './outline-state.js';

const LOW_WILL = /没(有|什么)?更多|你决定|你自己决定|就这样|先这样|可以了|够了|你看着办/;

/** LLM 声明的"这个问题在收集哪个维度"（v0.57）：优先于正则分类，兜底才用 classifyAnswer。 */
const VALID_INTENTS = new Set([
  'topic',
  'stance',
  'audience',
  'materials',
  'theme',
  'argument',
  'emotion',
  'ending',
  'style',
  'trigger',
  'connection',
  'borrow',
  'externalInput',
  'recipient',
  'basis',
  'items',
  'plot',
  'character',
  'known',
  'gap',
  'method',
  'limitation',
  'blueprint',
  'outlineConfirm',
]);
const INTENT_NORM = { material: 'materials' };
function normalizeIntent(raw) {
  const v = String(raw || '').trim();
  if (INTENT_NORM[v]) return INTENT_NORM[v];
  return VALID_INTENTS.has(v) ? v : null;
}

/** 外溢种子（v0.59）：用户主动给出、系统没准备问的高价值信息。
 *  分类与深挖由 LLM 动态决定（overflow 字段），这里只做清洗与兜底。 */
const OVERFLOW_TYPES = new Set(['reference', 'personal', 'constraint', 'reasoning']);
function normalizeOverflow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = OVERFLOW_TYPES.has(raw.type) ? raw.type : null;
  const seedText = String(raw.seedText || '').trim().slice(0, 300);
  const constraint = String(raw.constraint || '').trim().slice(0, 300);
  const coreThesis = String(raw.coreThesis || '').trim().slice(0, 200);
  if (!type || (!seedText && !constraint && !coreThesis)) return null;
  return { type, seedText, constraint, coreThesis };
}

/** 低意愿精确判定（v0.57 修复）：只有整句就是"够了/你决定/就这样"等短句才算低意愿，
 *  绝不因为句子中恰好出现"够了"两个字（如"站一会儿就够了"）就把用户的回答吞掉。 */
function isLowWill(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const n = t.replace(/[，。！？、,.！~～\s]+$/g, '').replace(/[，。！？、,.！~～\s]/g, '');
  if (!n) return true;
  if (n.length > 8) return false;
  return /^(没(有|什么)?更多|你决定(继续)?|你自己决定|就这样|先这样|可以了|够了|你看着办|没别的|没有了|先到这里|就到这里)(吧|的)?$/.test(n);
}
const NEED_LABELS = {
  topic: '主题',
  stance: '立场/目的',
  audience: '读者',
  materials: '具体素材',
  theme: '核心立意',
  argument: '支撑论点',
  emotion: '情感曲线',
  ending: '结尾姿态',
  trigger: '写作触发点',
  connection: '私人连线',
  borrow: '可借用讲述',
  externalInput: '外部意见',
  styleSample: '风格底稿',
  blueprintConfirm: '整篇文章蓝图确认',
  outlineConfirm: '大纲确认',
  outlineRefine: '大纲打磨',
  items: '事项要点',
  recipient: '主送/对象',
  basis: '依据/缘由',
  plot: '情节架构',
  character: '角色设计',
  known: '已知共识/现状',
  gap: '研究缺口',
  method: '方法与证据',
  limitation: '局限/边界',
};

const FALLBACK_QUESTIONS = [
  {
    need: 'topic',
    ask: '用一句话说说，这篇文章你想写什么？',
    recommendation: '先给个最接近你心里的说法，哪怕是口语',
  },
  {
    need: 'stance',
    ask: '写完这篇文章，你希望读者心里留下什么？',
    recommendation: '比如"相信教育要转向能力培养"，或"感到历史的现场感"',
  },
  {
    need: 'audience',
    ask: '这篇文章主要给谁看？',
    recommendation: '老师、同学、家长、还是陌生读者？这决定信息密度',
  },
  {
    need: 'targetWords',
    ask: '这篇打算写多长？大概多少字？',
    recommendation:
      '比如"大约一千字"或"三千字左右"。篇幅决定素材要备多少条、大纲要拆几节——说个大概就行，写前会再和你对齐',
  },
  {
    need: 'materials',
    ask: '有没有具体的事、画面、数据或引文可以用进去？',
    recommendation: '哪怕一个小场景也行，细节比观点更难得',
  },
  {
    need: 'theme',
    ask: '这篇文章的"立意"是什么？用一句话说清你最想表达的那个核心意思。',
    recommendation: '立意是全文的心脏，比如"历史不是展品，而是可以站进去的现场"',
  },
  {
    need: 'argument',
    ask: '围绕这个立意，你有哪些支撑论点？（先列一个）',
    recommendation: '论点要能展开成一段，比如"现场感来自具体的人，而非抽象的时间"',
  },
  {
    need: 'emotion',
    ask: '读者读完，情绪上应该经历怎样的曲线？',
    recommendation: '比如"先好奇，再触动，最后安宁"——这决定节奏与收束',
  },
  {
    need: 'ending',
    ask: '结尾你想停在什么姿态上？',
    recommendation: '比如"必胜的决心/赴死的意志/心安则上/留白"——按你的价值取向定调',
  },
  {
    need: 'styleSample',
    ask: '你以前写过类似这样的文章吗？有同文体的旧稿或片段的话，发我一段，我把它记成你的风格底稿。',
    recommendation: '300 字以上的旧稿最理想；实在没有，说一句"没有"也行，我边写边从你的修改里学',
    options: ['没有，先写吧'],
  },
  {
    need: 'items',
    ask: '需要具体写哪些事项或要点？',
    recommendation: '一条一条给，我帮你组织成条理（如"一、二、三"分条）',
  },
  {
    need: 'recipient',
    ask: '这份文书的主送对象是谁？',
    recommendation: '例如"全体教职工""××公司"或"各有关单位"',
  },
  {
    need: 'basis',
    ask: '发文/写作的依据或缘由是什么？',
    recommendation: '例如"根据上级文件要求"或"为加强安全生产管理"',
  },
  {
    need: 'plot',
    ask: '故事的情节架构想怎么走？有没有想要的伏笔或反转？',
    recommendation: '比如"欧亨利式：结尾反转，但前文有伏笔可回收"',
  },
  {
    need: 'trigger',
    ask: '是什么让你想写这个？哪句话、哪部作品、哪个人？',
    recommendation:
      '触发点往往就是全文的入口——比如某本书、某期播客、某个视频系列、某个人的一句话。说出来，我把它记成素材',
  },
  {
    need: 'connection',
    ask: '你和这个主题之间，有没有家人、师长或朋友提供的间接连线？',
    recommendation:
      '比如父母是相关领域的、老师讲过相关的事、某个长辈亲身经历过——这种"关系"比资料更私人，写出来最有辨识度',
  },
  {
    need: 'borrow',
    ask: '有没有你听过、看过的现成讲述，想借用它的内容或口吻？',
    recommendation:
      '比如某期播客对某段历史的讲述、某个视频系列的叙述方式。说出来，我去核对原样，借内容不借错',
  },
  {
    need: 'externalInput',
    ask: '有没有别人给过你意见？哪些你认同、哪些不认同？',
    recommendation:
      '老师、朋友、评委的话都算；认同的入库当最高优先级修改信号，不认同的我也记住，免得改回你不喜欢的方向',
  },
];

export function contextOf(state) {
  const lines = [];
  if (state.projectId) lines.push(`主题线索: ${state.projectId}`);
  for (const [k, v] of Object.entries(state.confirmed || {})) {
    if (k === 'arguments') continue;
    lines.push(`${k}: ${v}`);
  }
  for (const a of state.confirmed?.arguments || []) lines.push(`argument: ${a}`);
  for (const m of state.materials || []) lines.push(`素材: ${m}`);
  return lines.join('\n');
}

/** 把目前理解的整篇文章渲染成白话蓝图（grilling 式"共同理解"的可见化）。 */
export function renderBlueprint(state) {
  const c = state.confirmed || {};
  const b = state.blueprint || {};
  const lines = [];
  lines.push(`《${c.topic || '（主题未定）'}》`);
  if (c.theme) lines.push(`核心立意：${c.theme}`);
  if (c.stance) lines.push(`立场/目的：${c.stance}`);
  if (b.article) lines.push(`整篇文章是什么：${b.article}`);
  if (b.whyNow) lines.push(`为什么现在写：${b.whyNow}`);
  if (b.tension) lines.push(`核心张力：${b.tension}`);
  if (b.readerTakeaway) lines.push(`读者读完带走：${b.readerTakeaway}`);
  if ((c.arguments || []).length)
    lines.push(`支撑论点：${c.arguments.map((a, i) => `${i + 1}. ${a}`).join('；')}`);
  if ((state.materials || []).length) lines.push(`素材：${state.materials.join('；')}`);
  if (c.emotionalCurve) lines.push(`情感曲线：${c.emotionalCurve}`);
  if (c.endingTaste) lines.push(`结尾姿态：${c.endingTaste}`);
  if ((b.skeleton || []).length) lines.push(`结构顺序：${b.skeleton.join(' → ')}`);
  if ((b.corrections || []).length) lines.push(`待吸收的修正：${b.corrections.join('；')}`);
  return lines.join('\n');
}

const AUTO_OUTLINE_HEADS = new Set([
  '核心立意与立场',
  '素材与事实',
  '支撑论点',
  '情感曲线',
  '结尾落点',
  '读者与发布对象',
  '核心内容（AI 归纳中）',
]);

/** LLM 未给出大纲节（或只给空节）时，用"已确认内容"生成内容节，保证右侧大纲面板每轮都在生长。
 *  节由用户实际给的内容驱动（立意/素材/论点/结尾…），不是硬套文体骨架；
 *  用户可编辑；LLM 一旦给出真正的结构节，就整体接管、本函数不再覆盖。 */
function growOutlineFromState(state) {
  const lo = ensureLiveOutline(state);
  const c = state.confirmed || {};
  // 已存在 LLM 生成的真实结构节 → 不再用内容节覆盖。
  if (
    Array.isArray(lo.sections) &&
    lo.sections.length &&
    !lo.sections.every((s) => AUTO_OUTLINE_HEADS.has(String(s.heading || '').trim()))
  ) {
    return lo;
  }
  const sections = [];
  const add = (heading, fn, { thesis = '', keyPoints = [] } = {}) => {
    sections.push({
      heading,
      function: fn,
      thesis: String(thesis || '').trim().slice(0, 120),
      words: 0,
      keyPoints: keyPoints.filter(Boolean).map((x) => String(x).trim().slice(0, 60)).slice(0, 6),
    });
  };
  if (c.theme || c.stance) {
    add('核心立意与立场', '立意', {
      thesis: c.theme || c.stance,
      keyPoints: [c.theme, c.stance],
    });
  }
  if ((state.materials || []).length) {
    add('素材与事实', '素材', { keyPoints: state.materials.slice(0, 6) });
  }
  if (Array.isArray(c.arguments) && c.arguments.length) {
    add('支撑论点', '论点', { keyPoints: c.arguments.slice(0, 6) });
  }
  if (c.emotionalCurve) add('情感曲线', '情绪', { thesis: c.emotionalCurve });
  if (c.endingTaste) add('结尾落点', '收束', { thesis: c.endingTaste });
  if (c.audience || c.recipient) {
    add('读者与发布对象', '定位', { thesis: c.audience || c.recipient });
  }
  if (!sections.length && (c.topic || c.theme)) {
    add('核心内容（AI 归纳中）', '内容汇聚', {
      thesis: c.topic || c.theme,
      keyPoints: [c.topic, c.theme],
    });
  }
  if (!sections.length) return lo;
  lo.title = lo.title || String(c.topic || '').trim().slice(0, 40);
  lo.sections = sections;
  lo.updatedAt = ws.nowIso();
  refreshOutlineProgress(state);
  return lo;
}

/* ── 实时大纲（v0.29）：讨论中持续生长、大纲状态驱动提问 ────────── */
function sanitizeOutlineSections(secs) {
  if (!Array.isArray(secs)) return [];
  return secs
    .slice(0, 12)
    .map((s) => ({
      heading: String(s?.heading || '').trim().slice(0, 40) || '未命名节',
      ...(String(s?.function || '').trim() ? { function: String(s.function).trim().slice(0, 16) } : {}),
      thesis: String(s?.thesis || '').trim().slice(0, 120),
      words: Number(s?.words) > 0 ? Math.min(Number(s.words), 2000) : 0,
      keyPoints: Array.isArray(s?.keyPoints)
        ? s.keyPoints.map((k) => String(k).trim().slice(0, 80)).filter(Boolean).slice(0, 6)
        : [],
      materials: Array.isArray(s?.materials)
        ? s.materials.map((m) => String(m).trim().slice(0, 80)).filter(Boolean).slice(0, 4)
        : [],
      ...(String(s?.notes || '').trim() ? { notes: String(s.notes).trim().slice(0, 160) } : {}),
      // 用户对某缺口的"放弃项"必须保留，否则下一轮 sanitize 会把它冲掉导致死循环。
      ...(Array.isArray(s?.waived)
        ? { waived: s.waived.filter((w) => typeof w === 'string').slice(0, 4) }
        : {}),
    }))
    .filter((s) => s.heading);
}

/** 实时大纲必然存在：无则从空开始——由 LLM 随对话总结成形，代码不预造骨架。 */
export function ensureLiveOutline(state) {
  if (state.liveOutline && Array.isArray(state.liveOutline.sections)) {
    state.liveOutline.sections = sanitizeOutlineSections(state.liveOutline.sections);
    refreshOutlineProgress(state);
    return state.liveOutline;
  }
  state.liveOutline = {
    title: '',
    sections: [],
    complete: false,
    updatedAt: ws.nowIso(),
  };
  refreshOutlineProgress(state);
  return state.liveOutline;
}

/** 把确定性完成度结算挂到实时大纲上（仅供呈现；完成与否由 LLM/用户判断，不覆盖 complete）。 */
function refreshOutlineProgress(state) {
  const lo = state.liveOutline;
  if (!lo) return lo;
  const progress = outlineProgress(lo, state);
  lo.progress = progress;
  if (Array.isArray(lo.sections)) {
    lo.sections.forEach((s, i) => {
      const p = progress.perSection[i];
      if (p) {
        s.status = p.status;
        s.missing = p.missing || [];
      }
    });
  }
  return lo;
}

/** 合并 LLM 的 outlineUpdate（每轮让大纲长大；保留用户已编辑的节）。 */
function mergeLiveOutline(state, update) {
  const lo = ensureLiveOutline(state);
  const secs = sanitizeOutlineSections(update?.sections);
  if (secs.length) {
    // 同标题节合并时保留用户已填内容（要点/素材/核心句/字数/放弃项），
    // 防止模型每轮 outlineUpdate 把刚补上的信息冲掉，进度来回跳。
    const prevMap = new Map(lo.sections.map((s) => [String(s.heading || '').trim(), s]));
    for (const s of secs) {
      const prev = prevMap.get(String(s.heading || '').trim());
      if (prev) {
        s.keyPoints = s.keyPoints?.length ? s.keyPoints : prev.keyPoints || [];
        s.materials = s.materials?.length ? s.materials : prev.materials || [];
        s.thesis = s.thesis || prev.thesis || '';
        s.words = s.words || prev.words || 0;
        s.waived = s.waived?.length ? s.waived : prev.waived || [];
      }
    }
    lo.sections = secs;
  }
  if (typeof update?.title === 'string' && update.title.trim()) {
    lo.title = update.title.trim().slice(0, 40);
  }
  lo.updatedAt = ws.nowIso();
  refreshOutlineProgress(state);
  return lo;
}

/** 渲染实时大纲给提示词/面板/确认题。 */
export function liveOutlineText(state) {
  const lo = ensureLiveOutline(state);
  const lines = [`《${lo.title || '（标题待定）'}》`];
  lo.sections.forEach((s, i) => {
    lines.push(
      `${i + 1}. ${s.heading}${s.thesis ? `｜${s.thesis}` : ''}${s.words ? `（约${s.words}字）` : ''}`,
    );
    if (s.keyPoints?.length) lines.push(`   要点：${s.keyPoints.join('；')}`);
    if (s.notes) lines.push(`   说明：${s.notes}`);
  });
  if (!lo.sections.length) lines.push('（大纲会在讨论中由 AI 逐步总结成形）');
  return lines.join('\n');
}

function classifyAnswer(question, _answer) {
  const q = question || '';
  // 蓝图回显优先识别：问题以"整篇文章"开头，不能被里面的"支撑论点"字样带偏。
  if (/整篇文章|蓝图确认|我理解的整篇/.test(q)) return { field: 'blueprint' };
  // 打磨问题优先识别：问题文本里含"大纲/结尾"字样，否则会被误判成 outlineConfirm。
  if (/打磨|按你的大纲|大纲重新呈现/.test(q)) return { field: 'outlineRefine' };
  // 实时大纲确认/打磨：问题里带"大纲/开始写作"
  if (/大纲|开始写作/.test(q)) return { field: 'outlineConfirm' };
  if (/论点|支撑|理由|论证|观点/.test(q)) return { field: 'argument' };
  if (/情节|伏笔|反转|三幕|故事架构/.test(q)) return { field: 'plot' };
  if (/立意|中心意思|核心意思|想表达的最核心/.test(q)) return { field: 'theme' };
  if (/情绪|情感|曲线|氛围/.test(q)) return { field: 'emotion' };
  if (/结尾|收尾|收束|姿态/.test(q)) return { field: 'ending' };
  if (/角色|人物|主角|配角|想要什么|怕什么/.test(q)) return { field: 'character' };
  if (/缺口|没人做|没做透|张力|矛盾/.test(q)) return { field: 'gap' };
  if (/方法|证据|数据支撑|用什么证据|研究方法/.test(q)) return { field: 'method' };
  if (/局限|边界|不适用|适用范围/.test(q)) return { field: 'limitation' };
  if (/已知|现状|学界共识|已有研究/.test(q)) return { field: 'known' };
  if (/立场|目的|想让人|希望读者|相信什么/.test(q)) return { field: 'stance' };
  if (/依据|缘由|出台背景|必要性/.test(q)) return { field: 'basis' };
  if (/主送|对象|收件人|当事人|甲方|乙方/.test(q)) return { field: 'recipient' };
  if (/读者|给谁|听众/.test(q)) return { field: 'audience' };
  if (/字数|多长|篇幅|多少字|写多长|长文|短文|长一点|短一点/.test(q)) return { field: 'targetWords' };
  if (/主题|写什么|什么事|想写/.test(q)) return { field: 'topic' };
  if (/风格|写过|类似|文体|文风|旧稿|底稿/.test(q)) return { field: 'style' };
  if (/事项|要点|条款|具体安排|内容要求/.test(q)) return { field: 'items' };
  if (/素材|经历|案例|数据|画面|照片|手稿|细节/.test(q)) return { field: 'material' };
  return { field: 'material' };
}

/** 列表类回答拆分：顿号/逗号/分号/换行 → 多条。 */
function splitList(text) {
  return String(text || '')
    .split(/[、，,；;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function applyAnswer(state, field, answer) {
  state.confirmed = state.confirmed || {};
  const a = answer.trim();
  // 用户对风格题答"没有/不用" → 也算问过，标记完成，绝不反复追问。
  if (
    field === 'style' &&
    /^(没有|不知道|算了|跳过|none|na|不用|没写过|没有旧稿)$/i.test(a)
  ) {
    state.confirmed.styleSample = true;
    state.confirmed.styleNote = '（无同文体旧稿，边写边学）';
    return state;
  }
  // 可选维度"跳过"即标记完成（按文体蓝图判断是否可选，绝不反复追问）。
  const bpField = activeBlueprint(state).find((f) => f.key === field);
  if (
    bpField &&
    !bpField.required &&
    /^(没有|不知道|跳过|算了|none|na|不确定|没想好|不清楚)$/i.test(a)
  ) {
    const valueKey =
      field === 'emotion' ? 'emotionalCurve' : field === 'ending' ? 'endingTaste' : field;
    state.confirmed[valueKey] = '（跳过）';
    return state;
  }
  // 打磨问题：内容意见进修正档案；确认话术直接定稿。
  if (field === 'outlineRefine') {
    state.blueprint = state.blueprint || {};
    state.blueprint.corrections = state.blueprint.corrections || [];
    const norm = a.replace(/[，。！？、,.！\s]/g, '');
    const confirm =
      !a ||
      isLowWill(a) ||
      /^(对|对的|可以|可以的|同意|没问题|就是这样|是|是的|好的|好|嗯|没错|ok|开始|开始写作|写吧|确认|定稿|不用改了|不用了)/i.test(
        norm,
      );
    if (confirm) {
      state.confirmed.outlineConfirmed = true;
      state.confirmed.blueprintConfirmed = true;
      if (state.liveOutline) state.liveOutline.complete = true;
    } else if (a) {
      state.blueprint.corrections.push(a);
      state.justRefined = true;
    }
    return state;
  }
  // 实时大纲确认：说"开始写作/可以" → 大纲完成，进大纲生成；说"再打磨/改某节" → 记下修正继续问
  if (field === 'outlineConfirm') {
    state.blueprint = state.blueprint || {};
    state.blueprint.corrections = state.blueprint.corrections || [];
    const norm = a.replace(/[，。！？、,.！\s]/g, '');
    const confirm =
      !a ||
      isLowWill(a) ||
      /^(对|对的|可以|可以的|同意|没问题|就是这样|是|是的|好的|好|嗯|没错|ok|开始|开始写作|写吧|确认|定稿|可以了)/i.test(
        norm,
      ) ||
      norm.includes('大纲完成') ||
      norm.includes('就这样');
    if (confirm) {
      state.confirmed.outlineConfirmed = true;
      state.confirmed.blueprintConfirmed = true;
      if (state.liveOutline) state.liveOutline.complete = true;
    } else if (a) {
      state.blueprint.corrections.push(a);
      state.justRefined = true;
      if (state.liveOutline) state.liveOutline.complete = false;
    }
    return state;
  }
  // 蓝图确认在低意愿早退之前处理：用户说"可以/你决定"都算确认，防死循环。
  if (field === 'blueprint') {
    state.blueprint = state.blueprint || {};
    state.blueprintRounds = (state.blueprintRounds || 0) + 1;
    const norm = a.replace(/[，。！？、,.！\s]/g, '');
    const confirm =
      !a ||
      isLowWill(a) ||
      /^(对|对的|可以|可以的|同意|没问题|就是这样|是|是的|好的|好|嗯|没错|ok|不用改|不用了)$/i.test(
        norm,
      ) ||
      norm.includes('就是这样') ||
      norm.includes('没问题');
    if (!confirm && a) {
      // 用户给出具体修正 → 记进蓝图（大纲生成时吸收），不重复回显
      state.blueprint.corrections = state.blueprint.corrections || [];
      state.blueprint.corrections.push(a);
    }
    state.confirmed.blueprintConfirmed = true;
    return state;
  }
  if (!a || isLowWill(a) || /^(没有|不知道|跳过|算了|none|na)$/i.test(a)) return state;
  if (field === 'topic') state.confirmed.topic = a;
  else if (field === 'stance') state.confirmed.stance = a;
  else if (field === 'audience') {
    state.confirmed.audience = a;
    // 非公文文体里"读者/受众"与"发布对象/主送"是同一件事：
    // 用户答了"给谁看"，就不再回头追问"主送对象/发布对象"，杜绝主次不分。
    if (!isOfficialGenre(String(state.confirmed.genre || ''))) state.confirmed.recipient = a;
  }
  else if (field === 'style') state.confirmed.styleNote = a;
  else if (field === 'theme') state.confirmed.theme = a;
  else if (field === 'character') {
    state.confirmed.characters = state.confirmed.characters || [];
    if (!state.confirmed.characters.includes(a)) state.confirmed.characters.push(a);
  } else if (field === 'known') state.confirmed.known = a;
  else if (field === 'gap') state.confirmed.gap = a;
  else if (field === 'method') state.confirmed.method = a;
  else if (field === 'limitation') state.confirmed.limitation = a;
  else if (field === 'argument') {
    state.confirmed.arguments = state.confirmed.arguments || [];
    // 一条回答可能含多个论点（顿号/逗号/分号分隔）→ 拆分入列，避免整条当一项。
    let addedAny = false;
    for (const part of splitList(a)) {
      if (!state.confirmed.arguments.includes(part)) {
        state.confirmed.arguments.push(part);
        addedAny = true;
      }
    }
    state.listRepeat = !addedAny;
  } else if (field === 'emotion') state.confirmed.emotionalCurve = a;
  else if (field === 'ending') state.confirmed.endingTaste = a;
  else if (field === 'items') {
    state.confirmed.items = state.confirmed.items || [];
    // 公文/合同要点常用顿号分隔，拆成多条满足"事项 ≥N"门槛。
    let addedAny = false;
    for (const part of splitList(a)) {
      if (!state.confirmed.items.includes(part)) {
        state.confirmed.items.push(part);
        addedAny = true;
      }
    }
    state.listRepeat = !addedAny;
  } else if (field === 'recipient') state.confirmed.recipient = a;
  else if (field === 'basis') state.confirmed.basis = a;
  else if (field === 'plot') state.confirmed.plot = a;
  else if (field === 'targetWords') {
    const n = parseTargetWords(a) || guessTargetWords(a);
    if (n > 0) state.confirmed.targetWords = n;
    else state.confirmed.targetWordsNote = a; // 解析不到也记录，避免丢用户意图
  }
  else {
    state.materials = state.materials || [];
    if (state.materials.includes(a)) state.listRepeat = true;
    else {
      state.materials.push(a);
      state.listRepeat = false;
    }
  }
  if (field === 'style') state.confirmed.styleSample = true;
  return state;
}

// ── 文体驱动的动态蓝图 ────────────────────────────────
// 每类文体有自己的澄清维度（genreBlueprint），散文不再要求"论点×2"，
// 公文问"事项/主送/依据"，小说问"伏笔/反转"，论文才要论点×N。

/** 当前文体对应的澄清蓝图（默认散文型）。 */
export function activeBlueprint(state) {
  return genreBlueprint(state?.confirmed?.genre || '', {
    targetWords: state?.confirmed?.targetWords || 0,
  });
}

function fieldDone(state, f) {
  const c = state.confirmed || {};
  if (f.list === 'materials') return (state.materials || []).length >= (f.count || 1);
  if (f.list === 'arguments') return (c.arguments || []).length >= (f.count || 1);
  if (f.list === 'items') return (c.items || []).length >= (f.count || 1);
  if (f.key === 'styleSample') return Boolean(c.styleSample);
  if (f.key === 'targetWords') return Boolean(c.targetWords);
  // 非公文文体：读者/受众 与 发布对象/当事人/主送 视为同一维度（答其一即满足）。
  if (f.key === 'recipient' && !isOfficialGenre(String(state?.confirmed?.genre || ''))) {
    return Boolean(c.recipient || c.audience);
  }
  // 蓝图 key 与状态存储的别名映射（emotion→emotionalCurve, ending→endingTaste）
  const valueKey =
    f.key === 'emotion' ? 'emotionalCurve' : f.key === 'ending' ? 'endingTaste' : f.key;
  return Boolean(c[valueKey]);
}

/** 第一个未满足的蓝图字段（含收尾的蓝图确认）。 */
function blueprintNeed(state) {
  // 用户已明确放弃继续追问 → 不再问任何字段，直接进大纲（缺的写作时补）。
  if (state.deferred) return '';
  // 对话性探测字段（表达欲望四件套）：可选中的可选，由 LLM 顺其自然地问，
  // 绝不在确定性路径上强制追问（否则与"LLM 无缺口即停"配合会死循环）。
  const PROBE_FIELDS = new Set(['trigger', 'connection', 'borrow', 'externalInput']);
  for (const f of activeBlueprint(state)) {
    if (PROBE_FIELDS.has(f.key)) continue;
    if (!fieldDone(state, f)) return f.key;
  }
  // 用户刚说"再打磨"→ 先补一个打磨问题，确认题延后
  if (state.justRefined) return 'outlineRefine';
  if (state.confirmed?.outlineConfirmed) return '';
  // v0.37：大纲是 LLM 从对话里总结出来的呈现物——由 LLM 判定"成形"（outlineComplete）
  // 才进入确认；未成形就继续自由追问，代码不拿节数/完成度框住 LLM。
  if (ensureLiveOutline(state).complete) return 'outlineConfirm';
  return '';
}

/** 本轮输入是否值得重新提炼意图（v0.57）：短确认/敷衍回答跳过，
 *  只对"有新信息或修正信号"的轮次调用 LLM，减少每轮 API 串行等待。 */
function isMeaningfulTurn(input) {
  const t = String(input || '').trim();
  if (t.length >= 16) return true;
  return /不不不|不是|改成|换成|不要|为什么|读者|主题|立意|素材|结尾|风格|字数|多少字|谁看|发布|对象|角度|目的/.test(t);
}

/** 核心（必填、非风格底稿）维度是否齐了——齐了就能进大纲。 */
function materialGate(state) {
  for (const f of activeBlueprint(state)) {
    if (!f.required || f.key === 'styleSample') continue;
    if (!fieldDone(state, f)) return false;
  }
  return true;
}

/** 按文体蓝图返回缺失的必填项（大纲 gate 与澄清门槛共用同一套规则，避免文体错配）。 */
export function requiredMissing(state) {
  const missing = [];
  for (const f of activeBlueprint(state)) {
    if (!f.required || f.key === 'styleSample') continue;
    if (!fieldDone(state, f)) missing.push(f.label);
  }
  return missing;
}

/** 用户明确想结束时：标记"用户放弃"，后续大纲按现有信息生成（缺的写作时标注），绝不困住用户。 */
function markDeferred(state) {
  state.deferred = true;
  const c = state.confirmed || (state.confirmed = {});
  for (const f of activeBlueprint(state)) {
    if (!f.required || f.key === 'styleSample' || fieldDone(state, f)) continue;
    if (!f.list) c[f.key] = c[f.key] || '（待定，写作时再补）';
  }
}

function missingNeed(state) {
  return blueprintNeed(state);
}

/** 引导质量自检（内置，不打扰用户）：把每轮回答按 L0–L5 分级，供数据采集与复盘。
 *  L0 空答 / L1 方向型 / L2 素材型 / L3 结构隐喻型 / L4 修正型 / L5 精准指令型。
 *  规则参考 docs/DIALOGUE-GUIDE.md 第一节。 */
export function classifyAnswerLevel(input) {
  const t = String(input || '').trim();
  if (!t) return 0;
  if (/^(没有|不知道|随便|算了|跳过|none|na|你看着办)$/i.test(t) || isLowWill(t)) return 0;
  // L5 精准指令：具体到词/句/写法（引号、改词、句式、留白节奏）
  if (/["「『“”]|改为|改成|换成|删掉|加个|不要用|不用|替代|双引号|标点|句号|逗号|留白|口语/.test(t)) return 5;
  // L4 修正型：否定开头＋给出新需求
  if (/^(不不不|不是|不对|不要|别[，。]?)/.test(t) && t.length >= 6) return 4;
  // L3 结构/隐喻型：自发递进、比喻、结构词
  if (/就是|像|仿佛|如同|比喻|递进|结构|伏笔|反转|首尾|收束|结尾|开头|曲线/.test(t)) return 3;
  // L2 素材型：有成句的画面/事件/原话
  if (t.length >= 12 && /[，。！？；]/.test(t)) return 2;
  // L1 方向型：短句决策或字母选项
  return 1;
}

/** 澄清确认清单（技术 6：让用户看见"自己被认真记录"）。 */
export function checklistOf(state) {
  return activeBlueprint(state).map((f) => ({
    label: f.label,
    done: fieldDone(state, f),
  }));
}

/** 换一个角度问：优先挑"还没确认、也不是当前缺口"的维度，避免同一问题翻来覆去。 */
function nextFallback(state, need) {
  const done = new Set(
    Object.entries(state.confirmed || {})
      .filter(([, v]) => v)
      .map(([k]) => k),
  );
  // 只从"当前文体蓝图里真正存在的维度 + 普适维度"里换角度，
  // 防止散文被换到"发文依据/主送对象"这类公文维度上去。
  const allowed = new Set(
    activeBlueprint(state)
      .map((f) => f.key)
      .concat([
        'topic',
        'stance',
        'audience',
        'materials',
        'theme',
        'emotion',
        'ending',
        'styleSample',
        'targetWords',
      ]),
  );
  for (const f of FALLBACK_QUESTIONS) {
    if (f.need === need) continue;
    if (!allowed.has(f.need)) continue;
    if (done.has(f.need)) continue;
    if (f.need === 'styleSample' && state.confirmed?.styleSample) continue;
    if (f.need === 'targetWords' && state.confirmed?.targetWords) continue;
    return f;
  }
  return null;
}

async function askOnce(state, cfg, workspace) {
  const need = missingNeed(state);
  const coreReady = materialGate(state);
  // 低意愿早退（确定性护栏，不依赖 LLM 判断）：连续两次"没有更多/你决定/可以了"
  // → 直接进大纲。核心字段未齐也放行（缺失项占位，写作时再补），绝不困住用户。
  if ((state.lowWill || 0) >= 2) {
    if (!coreReady) markDeferred(state);
    return { stop: true, ready: true, question: null, lowWill: true };
  }
  // 意图理解刷新（v0.57 提速）：首轮串行等（第一问最需要对齐理解）；
  // 之后并行刷新——本轮先用上一轮的"我的理解"生成问题，同时后台刷新意图，下一轮生效。
  // LLM 失败走确定性兜底，绝不阻塞、绝不让用户等。
  let intentPromise = null;
  if (state.lastInput && isMeaningfulTurn(state.lastInput) && !state.metaQuestion) {
    if (!state.intent) {
      try {
        await understandIntent(cfg, workspace, state);
      } catch {
        // understandIntent 内部已兜底，这里再包一层纯保险
      }
    } else {
      intentPromise = understandIntent(cfg, workspace, state).catch(() => {});
    }
    // 思想脉络（v0.43）：用户抛出理论/因果推理/引用书籍 → 提炼并累积，
    // 下一问据此"向下挖一层"，与用户达成思想共识（失败静默，绝不阻塞）。
    if (extractThinkingSignals(state.lastInput).hasThinking) {
      try {
        const llmTh = await extractThinkingWithLLM(cfg, state.lastInput, thinkingBrief(state));
        const th = updateThinkingThread(state, state.lastInput, llmTh);
        if (th.updated) {
          ws.logContext(workspace, 'thinking', `记录思想信号（${th.merged ? '合并' : '新增'}）`);
        }
      } catch {}
    }
  }
  const style = workspace ? styleProgress(workspace) : null;
  // 确认题上用户说"再打磨一下"→ 确定性打磨问题（不依赖 LLM 临场发挥，绝不退回无关模板）。
  if (need === 'outlineRefine') {
    return {
      stop: false,
      ready: materialGate(state),
      question:
        '你想先打磨哪一处？说得具体一点（如"第二节能加个例子""结尾再克制一点"），我改完会把大纲重新呈现给你确认。',
      recommendation: '直接说节号或方向即可；也可以回"不用改了，开始写作"。',
      options: ['不用改了，开始写作'],
      liveOutline: ensureLiveOutline(state),
    };
  }
  // 实时大纲确认（v0.29）：大纲 ≥3 节且核心字段齐 → 明确的"开始写作"确认点。
  if (need === 'outlineConfirm') {
    const outlineText = liveOutlineText(state);
    return {
      stop: false,
      ready: materialGate(state),
      question: `根据我们的讨论，这是目前的大纲——\n${outlineText}\n\n确认这份大纲，开始写作吗？`,
      recommendation:
        '回"开始写作"或"可以"进入写作；想再打磨就说具体改哪里（如"第二节能加个例子"），我会继续陪你磨到大纲满意。',
      options: ['大纲完成，开始写作', '再打磨一下'],
      liveOutline: ensureLiveOutline(state),
      outlineConfirm: true,
    };
  }
  // 蓝图回显（兜底）：实时大纲不足 3 节时的旧确认路径。
  if (need === 'blueprintConfirm') {
    const blueprintText = renderBlueprint(state);
    return {
      stop: false,
      ready: materialGate(state),
      question: `这是我目前理解的整篇文章——\n${blueprintText}\n\n对吗？哪里还要改？`,
      recommendation: '对的话回"可以"；要改哪里直接说，我会把修正记进蓝图再进大纲。',
      options: ['可以，就是这样'],
      blueprint: blueprintText,
      blueprintConfirm: true,
    };
  }
  const ctx = {
    context: contextOf(state),
    lastInput: state.lastInput || '（刚开始）',
    stage: '澄清',
    // v0.44：蓝图状态只是"还有哪些牌没亮"的清单，不是顺序命令；
    // 问什么由 LLM 结合用户刚说的话自主判断（规则 10），suggestedNext 只是可推翻的建议。
    blueprintStatus: activeBlueprint(state)
      .map((f) => `- ${f.label}${fieldDone(state, f) ? '（已确认 ✓）' : '（待补 ✗）'}`)
      .join('\n'),
    suggestedNext: activeBlueprint(state).find((f) => f.key === need)?.label || '',
    stageNeed:
      activeBlueprint(state).find((f) => f.key === need)?.label ||
      NEED_LABELS[need] ||
      '素材细节',
    blueprintFields: activeBlueprint(state).map((f) => f.label).join(' → '),
    coreReady,
    thinking: thinkingBrief(state),
    knowledgeContext: unifiedBrief(
      workspace,
      `${state.confirmed?.topic || ''} ${state.lastInput || ''}`,
    ),
    styleNote: state.confirmed.styleNote || '',
    seeds: (state.seeds || [])
      .map((s) => `- [${s.type}${s.confirmed ? '✓' : '·待确认'}] ${s.text}`)
      .join('\n'),
    constraints: (state.constraints || []).map((c, i) => `${i + 1}. ${c}`).join('\n'),
    blueprintText: state.blueprint && renderBlueprint(state),
    liveOutline: liveOutlineText(state),
    intentBrief: intentBrief(state),
    userNegated: /不不不|不是这样|不是这个|你说错了|理解错了|不是要|不要这样|不对[，。,.]/.test(
      state.lastInput || '',
    ),
    userMeta: state.metaQuestion || '',
    styleProgress: style
      ? `write ${style.write.learned}/${style.write.total} 维 · read ${style.read.learned}/${style.read.total} 维`
      : '',
  };
  try {
    const content = await chatWithRetry(
      cfg,
      [
        {
          role: 'system',
          content: '你是追问设计师。从用户话语中自然生长问题，每个问题都给出建议答案。',
        },
        { role: 'user', content: QUESTIONER_PROMPT(ctx) },
      ],
      // maxTokens 必须给足：追问 JSON 含 question+recommendation+options+blueprintUpdate
      // +outlineUpdate，1000 会被截断 → 解析失败 → 退化成模板兜底问句（v0.57 修复）。
      { json: true, temperature: 0.7, maxTokens: 2500 },
    );
    if (intentPromise) await intentPromise; // 并行意图刷新完成（不阻塞本轮问题生成）
    const q = parseJsonContent(content, '追问');
    if (q.stop) {
      if (missingNeed(state) === '') {
        return {
          stop: true,
          ready: materialGate(state),
          question: null,
          outlineUpdate: q.outlineUpdate || null,
          outlineComplete: q.outlineComplete || false,
        };
      }
    }
    const question = String(q.question || '').trim();
    // v0.57：不再做"软性拉回"。LLM 追问已满足的维度（如细化主题、换个角度聊立意）
    // 往往是高质量追问，直接采用，由 LLM 决定问什么；真正的重复问题由下面的
    // 重复追问护栏兜底，两条路径不会互相打架，也不再把 LLM 的好问题换成模板句。
    // 重复追问护栏（确定性）：LLM 与上一问同义/互相包含 → 换一个未确认维度问，绝不车轱辘。
    const normQ = (s) => String(s || '').replace(/[，。！？、,.！\s]/g, '').toLowerCase();
    const prevQ = normQ(state.lastQuestion);
    const curQ = normQ(question);
    const repeat =
      prevQ &&
      curQ &&
      (prevQ === curQ ||
        (prevQ.length >= 8 && prevQ.includes(curQ)) ||
        (curQ.length >= 8 && curQ.includes(prevQ)));
    if (repeat) {
      state.repeatCount = (state.repeatCount || 0) + 1;
      const f = nextFallback(state, need);
      const fb = f || fallbackFor(need, state);
      return {
        stop: false,
        ready: materialGate(state),
        question: fb.ask,
        recommendation: fb.recommendation,
        options: [],
        fallback: true,
        warn: '检测到重复追问，已换一个角度',
      };
    }
    state.repeatCount = 0;
    // 硬校验：一次只允许一个问题。判定"一次多问"：
    //   a) ≥3 个问号；b) ≥2 个问号且两个分句指向不同维度（如"写多长？读者是谁？"）；
    //   c) 带编号/其次/另外/还有 的列举。同维度复述（"写多长？大概多少字？"）不算多问。
    const qMarks = (question.match(/[？?]/g) || []).length;
    const multi =
      qMarks >= 3 ||
      /(^|\n)\s*([1-9一二三四五六]、?\.?)\s*/.test(question) ||
      /另外|其次|最后，|同时|以及/.test(question);
    if (!question || multi) {
      const f = fallbackFor(need, state);
      return {
        stop: false,
        ready: materialGate(state),
        question: f.ask,
        recommendation: f.recommendation,
        options: [],
        fallback: true,
        warn: 'LLM 一次输出多个问题，已强制退回单问题',
      };
    }
    return {
      stop: false,
      ready: materialGate(state),
      question,
      askedField: normalizeIntent(q.intent),
      overflow: q.overflow || null,
      recommendation: q.recommendation,
      options: q.options || [],
      blueprintUpdate: q.blueprintUpdate || null,
    };
  } catch (err) {
    if (intentPromise) await intentPromise;
    // LLM 不可用时：若用户刚才是反问/质疑，先给"帮助式"回应，绝不生硬套模板；
    // 否则按缺口确定性兜底问，绝不死循环。
    if (state.metaQuestion) {
      const label = NEED_LABELS[need] || '这个方向';
      return {
        stop: false,
        ready: materialGate(state),
        question: `先回你刚才的疑问——我之所以想先问「${label}」，是因为它会直接决定整篇文章往哪走，而不是在收集琐碎细节。你可以直接说想法，也可以回"跳过"，我会按通用方式继续。`,
        recommendation: '想跳过就直接回"跳过"，我们继续往下聊',
        options: ['跳过'],
        warn: '你刚才的反问我收到了',
      };
    }
    const f = pickFallback(state, need);
    return {
      stop: false,
      ready: materialGate(state),
      question: f.ask,
      recommendation: f.recommendation,
      options: [],
      fallback: true,
      warn: String(err.message).slice(0, 120),
    };
  }
}

/** 确定性兜底问题：与上一问完全相同时追加变体，避免用户觉得"同一个问题又问一遍"。 */
function pickFallback(state, need) {
  const base = fallbackFor(need, state);
  const norm = (s) => String(s || '').replace(/[，。！？、,.！\s]/g, '').toLowerCase();
  const prev = norm(state.lastQuestion);
  const cur = norm(base.ask);
  if (prev && cur && prev === cur) {
    return {
      ...base,
      ask: `${base.ask.replace(/[？?]$/, '')}？还有别的吗？`,
      recommendation: base.recommendation,
    };
  }
  return base;
}

/** 每个维度都有确定性问题：LLM 停摆/多问/重复时按需兜底，绝不问无关维度。 */
function fallbackFor(need, state = {}) {
  const official = isOfficialGenre(String(state?.confirmed?.genre || ''));
  const f = FALLBACK_QUESTIONS.find((x) => x.need === need);
  if (f) {
    if (['materials', 'arguments', 'items'].includes(need) && state.listRepeat) {
      return {
        ...f,
        ask: `${f.ask.replace(/[？?]$/, '')}？上一条已经记过了——换一条新的，或说"你决定"。`,
      };
    }
    // 兜底问句也要"接住用户重点"：公文才问"发文依据/主送/事项"，
    // 其它文体（含没识别出来的）一律换成普适的高价值问法，绝不冒出"傻问题"。
    if (need === 'basis' && !official) {
      return {
        ...f,
        ask: '这件事为什么值得写？有没有具体的缘由、背景或触发点？',
        recommendation: '比如"身边越来越多人只会说梗，想替这种沉默说句话"——从真实触发点说起最有力',
      };
    }
    if (need === 'recipient' && !official) {
      return {
        ...f,
        ask: '这篇文章主要写给谁看？',
        recommendation: '老师、同学、编辑、还是陌生读者？这决定信息密度和语气',
      };
    }
    if (need === 'items' && !official) {
      return {
        ...f,
        ask: '还有哪些具体内容或要点需要写进去？',
        recommendation: '一条一条给就行，我帮你组织成文',
      };
    }
    return f;
  }
  const label = NEED_LABELS[need] || need;
  return {
    need,
    ask: `还差「${label}」——你有这方面的想法吗？直接说，或回"跳过"。`,
    recommendation: '答不上来也没关系，说"跳过"我会按通用方式处理。',
  };
}

// 单步澄清：host（MCP）或脚本一次调用 = 应用一条用户消息 + 返回下一个问题。
export async function clarifyStep(cfg, wsDir, { lastInput = '' } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  let state = ws.readState(workspace);
  state.phase = 'clarify';
  ensureLiveOutline(state);
  state.blueprint = state.blueprint || {
    article: '',
    whyNow: '',
    tension: '',
    readerTakeaway: '',
    skeleton: [],
    corrections: [],
  };
  let clarifyPulse = null;
  // 用户反问/质疑检测（v0.57）：用户不是回答、而是提问或表示疑惑时，
  // 绝不把他的反问当作素材/答案记进去，也绝不继续生硬地按模板追问——
  // 交给 LLM 先正面回答他的疑问，再把话题轻轻带回当前缺口。
  const rawInput = String(lastInput || '').trim();
  const META_RE =
    /^(为什么|为啥|怎么回事|什么意思|你问这个|你问的|这有什么用|有什么用|先回答|等一下|等等|你说什么|没听懂|不明白|没明白|听不懂|你在说什么|你理解错|你搞错|我不是这个意思|我不是说|你误会|你确定|你想问|你到底要问|能不能解释)/;
  const isMeta = Boolean(
    rawInput &&
      (META_RE.test(rawInput) || (/[？?]$/.test(rawInput) && rawInput.length <= 24 && !/写|起草|创作/.test(rawInput))),
  );
  if (lastInput && isMeta) {
    state.lastInput = lastInput;
    state.metaQuestion = rawInput;
    state.lowWill = 0;
    ws.logContext(workspace, 'clarify', `用户反问/质疑（不当作答案）：${rawInput}`);
  }
  if (lastInput && !isMeta) {
    state.lastInput = lastInput;
    // 文体识别：开局识别一次（后续答案里的"故事/通知"等词不得误改文体）；
    // 只有用户显式说"改成/换一种文体"时才允许切换。
    const genre = detectGenre(lastInput);
    if (
      genre &&
      (!state.confirmed?.genre || /^(改成|换成|换|改为|不要)/.test(String(lastInput).trim()))
    ) {
      state.confirmed.genre = genre;
      ws.logContext(workspace, 'clarify', `识别文体：${genre}`);
    }
    // 首轮主题预填（v0.35）：用户开局已说出主题，就不再重复问"你想写什么"。
    // LLM 优先提炼（自然语言理解），LLM 不可用时用启发式兜底；拿不准就不预填。
    if (lastInput && !state.lastQuestion && !state.confirmed?.topic) {
      let topic = '';
      try {
        const content = await chatWithRetry(
          cfg,
          [
            { role: 'system', content: '你是主题提炼器。只输出严格 JSON。' },
            {
              role: 'user',
              content: `【主题提炼】\n用户开局说了：${String(lastInput).slice(0, 200)}\n\n如果这句话里给出了要写的主题/题目，提炼成 4-20 字的主题词（去掉"帮我写一篇关于"这类话术）；如果没有明确主题，输出 {"topic":""}。`,
            },
          ],
          { json: true, temperature: 0.1, maxTokens: 400 },
        );
        const parsed = parseJsonContent(content, '主题提炼');
        topic = String(parsed?.topic || '').trim().slice(0, 40);
      } catch {}
      if (!topic) {
        // 启发式兜底（LLM 不可用）：去掉"帮我写一篇关于…"话术前缀。
        topic = String(lastInput)
          .trim()
          .replace(
            /^(好|可以|行)?\s*(我)?(想|要|打算|希望)?\s*(帮我|麻烦|请)?\s*(写一?[篇份个]?|创作|起草|来[一篇份个]?|整[一篇份个]?)?\s*(关于|一篇|一份|一个|的)?\s*/,
            '',
          )
          .replace(/[，。！？、\s]+$/, '')
          .slice(0, 40);
        if (/^(开始|写吧|开写|你看着办|随便|帮我写$|写吧$)/.test(String(lastInput).trim())) {
          topic = '';
        }
      }
      if (topic && topic.length >= 4) {
        state.confirmed.topic = topic;
        ws.logContext(workspace, 'clarify', `首轮预填主题：${topic.slice(0, 30)}`);
      }
    }
    // 多模态输入：用户给出文件路径（docx/xlsx/图片/md）→ 提取成文本素材。
    if (fs.existsSync(String(lastInput).trim())) {
      const ing = await extractInput(String(lastInput).trim(), cfg);
      if (ing.kind === 'text') {
        state.materials = state.materials || [];
        state.materials.push(
          `[文件 ${path.basename(String(lastInput).trim())}] ${ing.text.slice(0, 2000)}`,
        );
        ws.logContext(
          workspace,
          'ingest',
          `已提取 ${path.basename(String(lastInput).trim())}（${ing.source}，${ing.text.length} 字）`,
        );
      } else if (ing.hint) {
        ws.logContext(workspace, 'ingest', ing.hint);
      }
    }
    // 答案归类到"上一个问题"的意图；提问时就推断并保存该意图。
    const field = state.lastField || 'material';
    // 大纲只是结构视图，用户有权随时拍板：任何一轮说"开始写作/大纲完成"→ 直接确认，
    // 且不把拍板话术误当素材/要点收进大纲。
  const explicitStart =
    !state.confirmed.outlineConfirmed &&
    /^(好|可以|行|嗯|对|没问题|就这样|行吧|ok)?\s*(开始写作|开始吧|写吧|开写|进入写作|大纲完成[，,、\s]*开始写作|大纲可以了|大纲没问题|确认大纲|就按这个写|定稿)/.test(
      lastInput.trim(),
    );
  // 加速信号（v0.58）：用户说"你直接梳理差不多就写吧/直接开始/剩下的你定"——
  // 是主动授权推进，不是低意愿。识别并记录，剩余维度按建议默认，不再逐条追问。
  const ACCELERATE_RE =
    /(直接(开始|写|写吧|动手|来)|开始写吧|不用(再)?问了|剩下的你(定|看着办)|差不多就(开始|写)|你看着写吧)/;
  const accelerate = Boolean(lastInput && ACCELERATE_RE.test(lastInput.trim()));
  if (accelerate && !state.accelerated) {
    state.accelerated = true;
    ws.logContext(
      workspace,
      'clarify',
      '加速信号：用户授权直接推进，剩余维度按建议默认（缺项写作时补）',
    );
    if (!materialGate(state)) markDeferred(state);
  }
    if (explicitStart) {
      // 用户明确拍板开始写作 → 素材未齐也放行（缺失项占位，写作时再补）。
      if (!materialGate(state)) markDeferred(state);
      state.confirmed.outlineConfirmed = true;
      state.confirmed.blueprintConfirmed = true;
      if (state.liveOutline) state.liveOutline.complete = true;
      ws.logContext(workspace, 'outline', '用户主动确认大纲（视图允许随时拍板）');
    } else {
      applyAnswer(state, field, lastInput);
    }
    // 低意愿计数（确定性）："没有更多/你决定/可以了/就这样"→ 连续两次且核心字段齐就早退进大纲。
    if (isLowWill(lastInput)) state.lowWill = (state.lowWill || 0) + 1;
    else state.lowWill = 0;
    // 引导质量自检：记录每轮回答的 L0–L5 级别（内置，不展示给用户，供实验与复盘）。
    const level = classifyAnswerLevel(lastInput);
    state.answerLevels = state.answerLevels || [];
    state.answerLevels.push({ ts: ws.nowIso(), level, sample: String(lastInput).slice(0, 60) });
    if (state.answerLevels.length > 20) state.answerLevels = state.answerLevels.slice(-20);
    ws.logContext(workspace, 'answer-level', `L${level}：${String(lastInput).slice(0, 80)}`);
    // 风格全程采集：用户每一句话（含修改理由、素材、语气）都是风格信号。
    const style = applyStyleSignals(workspace, lastInput);
    if (style.writeUpdated + style.readUpdated > 0) {
      ws.logContext(
        workspace,
        'style',
        `被动采集到风格信号 ${style.writeUpdated} 维（write）+ ${style.readUpdated} 维（read）`,
      );
    }
    // 隐式风格信号流水：每轮留一份可回看的记录（style-signals.jsonl/md），压缩也不丢。
    try {
      recordImplicitSignals(workspace, lastInput);
    } catch {}
    // 四层复合风格向量：澄清每轮实时刷新（连续向量 EMA + 动态维度 + 困惑度签名）
    await refreshStyleVector(cfg, workspace, { text: lastInput, kind: 'clarify', evidence: '澄清回答' });
    clarifyPulse = pulseAfterClarify(workspace, lastInput);
    pushPulseToState(state, clarifyPulse);
    if (clarifyPulse.suggestion) {
      ws.logContext(workspace, 'style-pulse', clarifyPulse.suggestion);
    }
    // 风格方向：用户说"整篇更豪迈/更克制…"→ 落档案；已有草稿则标记需要全文重写。
    const dir = applyStyleDirection(workspace, lastInput);
    if (dir.applied) {
      await refreshStyleVector(cfg, workspace, { text: lastInput, kind: 'direction', evidence: dir.phrase });
      if (fs.existsSync(path.join(workspace, 'draft.md'))) state.needsRestyle = true;
      ws.logContext(workspace, 'style', `风格方向变化：${dir.phrase}（影响 ${dir.updated} 维）`);
    }
    // 风格底稿落盘：用户贴的长样本存进 vault，供后续 STYLE_EXTRACTION 使用。
    if (state.lastField === 'style' && lastInput.length >= 80) {
      const sampleDir = path.join(workspace, 'vault', 'style-samples');
      fs.mkdirSync(sampleDir, { recursive: true });
      const sampleFile = path.join(sampleDir, `sample-${Date.now()}.md`);
      fs.writeFileSync(sampleFile, lastInput + '\n');
      state.confirmed.styleSampleFile = sampleFile;
      // 贴了风格底稿 → 立即做 14 维风格提取（LLM），写进 write-style.json。
      const ex = await extractStyleFromSamples(workspace, cfg);
      if (ex.extracted > 0) {
        ws.logContext(workspace, 'style', `风格底稿提取完成：${ex.extracted} 份样本 → 14 维档案`);
      }
    }
    // 个人知识库（PKB）：用户确认读过/喜欢的《书名》、去过的地方 → 归纳收录。
    // 同意才记、标题去重、不硬塞；上一条建议悬而未决的书在"读过/喜欢"时补录。
    const kbCaptured = captureKbMentions(workspace, lastInput, {
      pendingBook: state.pendingKbBook || '',
    });
    if (kbCaptured.length) {
      ws.logContext(workspace, 'knowledge', `从对话归纳收录 ${kbCaptured.length} 条个人知识`);
    }
    // AI 主导知识筛选（v0.58）：用户提到看过/刷到/去过的 视频(B站)/新闻/文章/地方/观点
    // → 由 LLM 提炼入库（正则只做入口判断，收什么由 LLM 决定）；失败静默。
    try {
      const aiKb = await captureKnowledgeAI(cfg, workspace, lastInput);
      if (aiKb.added.length) {
        ws.logContext(
          workspace,
          'knowledge',
          `AI 筛选收录 ${aiKb.added.length} 条（书/视频/新闻/观点等）`,
        );
      }
    } catch {}
    // 用户确认/补充（短句："对，就是那个""看过"）→ 低置信条目升级为"已查验"。
    // 只有短句确认才算数：长句开头带"对"（"对，我觉得…帮我查一查"）不是对结果的确认。
    try {
      const t = String(lastInput || '').trim();
      const shortConfirm =
        t.length <= 24 &&
        /^(对|对的|是的|就是|嗯|没错|看过|读过|是那个|就是那个|对，就是|对，看过|确实看过)/.test(t);
      if (shortConfirm) {
        const upgraded = confirmLowConfidenceEntries(workspace);
        if (upgraded.length) {
          ws.logContext(workspace, 'knowledge', `用户确认，${upgraded.length} 条知识升级为已查验`);
        }
        // 顺带：把待确认的种子标记为"已确认"（用户短句确认 = 种子成立）
        const seeds = state.seeds || [];
        if (seeds.some((s) => !s.confirmed)) {
          seeds.forEach((s) => {
            s.confirmed = true;
          });
          ws.logContext(workspace, 'clarify', `用户确认，${seeds.length} 个种子已确认`);
        }
      }
    } catch {}
    // 显式检索请求（"帮我查一查《乡土中国》中…"）→ 立即排队/直连检索，并把提示回给用户。
    // 之前 RAG 只在"论文/素材不足"时被动触发，用户主动要求查证却被跳过——这里补上显式通路。
    let userSearchSuggestion = '';
    try {
      userSearchSuggestion = await explicitSearchSuggestion(cfg, workspace, lastInput, state);
      if (userSearchSuggestion) {
        ws.logContext(workspace, 'rag', `用户显式检索请求 → ${userSearchSuggestion.slice(0, 120)}`);
      }
    } catch {}
    state.userSearchSuggestion = userSearchSuggestion;
    // pending 书已得到明确回应（确认已入库/否认/答了别的）→ 只问一次，清掉防误记
    if (state.pendingKbBook && lastInput.trim()) state.pendingKbBook = null;
    ws.logContext(workspace, 'clarify', `${state.lastQuestion || '（首轮）'} → ${lastInput}`);
  }
  const next = await askOnce(state, cfg, workspace);
  state.metaQuestion = ''; // 反问已交给 LLM 处理，只生效一轮，防止残留重复解释
  // ── 外溢优先（v0.59）：用户主动给出的高价值信息，当轮入档 ──────────
  const overflow = normalizeOverflow(next.overflow);
  const appendOverflowLog = (type, seed, constraint, coreThesis) => {
    try {
      const logDir = path.join(workspace, 'vault');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'overflow-log.jsonl'),
        JSON.stringify({
          ts: ws.nowIso(),
          task: state.confirmed?.topic || '',
          asked: state.lastQuestion || '',
          userSaid: String(state.lastInput || '').slice(0, 200),
          overflowType: type,
          seed: String(seed || '').slice(0, 200),
          constraint: String(constraint || '').slice(0, 200),
          coreThesis: String(coreThesis || '').slice(0, 200),
          lesson: '',
        }) + '\n',
      );
    } catch {}
  };
  if (overflow) {
    state.seeds = state.seeds || [];
    state.constraints = state.constraints || [];
    state.overflowLog = state.overflowLog || [];
    if (overflow.seedText && !state.seeds.some((s) => s.text === overflow.seedText)) {
      state.seeds.push({ text: overflow.seedText, type: overflow.type, confirmed: false, ts: ws.nowIso() });
    }
    if (overflow.constraint && !state.constraints.includes(overflow.constraint)) {
      state.constraints.push(overflow.constraint);
    }
    if (overflow.coreThesis) state.coreThesis = overflow.coreThesis;
    state.overflowDeepCount = (state.overflowDeepCount || 0) + 1;
    state.overflowLog.push({
      ts: ws.nowIso(),
      overflowType: overflow.type,
      seed: overflow.seedText,
      constraint: overflow.constraint,
      coreThesis: overflow.coreThesis,
    });
    if (state.overflowLog.length > 12) state.overflowLog = state.overflowLog.slice(-12);
    appendOverflowLog(overflow.type, overflow.seedText, overflow.constraint, overflow.coreThesis);
    ws.logContext(
      workspace,
      'clarify',
      `外溢种子[${overflow.type}]：${(overflow.seedText || overflow.constraint || '').slice(0, 60)}`,
    );
  } else {
    state.overflowDeepCount = 0;
    // 确定性兜底（LLM 未识别时）：只抓最明确的书名/红线，分类和深挖仍交给 LLM。
    const t = String(state.lastInput || '').trim();
    if (t && !isLowWill(t) && /《[^》]{1,30}》|父母|家人|师承|导师|台词|一字|不许改|不能改|必须保留|定死了|不许动|推理线/.test(t)) {
      const b = t.match(/《([^》]{1,30})》/)?.[1];
      const seedText = b ? `《${b}》` : '';
      if (seedText && !(state.seeds || []).some((s) => s.text === seedText)) {
        const type = /父母|家人|师承|导师/.test(t) ? 'personal' : /推理线|推理/.test(t) ? 'reasoning' : 'reference';
        state.seeds = state.seeds || [];
        state.seeds.push({ text: seedText, type, confirmed: false, ts: ws.nowIso(), auto: true });
        appendOverflowLog(type, seedText, '', '');
        ws.logContext(workspace, 'clarify', `外溢种子（兜底识别）[${type}]：${seedText}`);
      }
      if (/台词|一字|不许改|不能改|必须保留|定死了|不许动/.test(t)) {
        state.constraints = state.constraints || [];
        const c = t.trim().slice(0, 200);
        if (!state.constraints.includes(c)) {
          state.constraints.push(c);
          appendOverflowLog('constraint', '', c, '');
          ws.logContext(workspace, 'clarify', `红线（兜底识别）：${c.slice(0, 50)}`);
        }
      }
    }
  }
  // 实时大纲生长：LLM 每轮可输出 outlineUpdate（节列表），面板随之逐轮变化。
  if (next.outlineUpdate) mergeLiveOutline(state, next.outlineUpdate);
  // LLM 没给结构（或只给空节）时，用已确认内容生成内容节，保证大纲每轮可见地长大。
  growOutlineFromState(state);
  if (next.outlineComplete === true && state.liveOutline) state.liveOutline.complete = true;
  // 归纳式知识一问（非阻塞）：《书名》未问过才问；主题泛问每会话最多一次。
  const kbSuggest = knowledgeSuggestion(state, workspace, {
    sessionAsked: Boolean(state.kbGenericAsked),
  });
  if (kbSuggest) {
    state.knowledgeSuggestion = kbSuggest;
    const bookMatch = kbSuggest.match(/《([^》]{1,30})》/);
    if (bookMatch) {
      state.pendingKbBook = bookMatch[1];
      markAsked(workspace, `book:${normTitle(bookMatch[1])}`);
    } else {
      state.kbGenericAsked = true;
    }
  } else {
    state.knowledgeSuggestion = '';
  }
  // 实时取数提议（非阻塞）：论文/报告/新闻稿素材不足 → 自动排队检索一次。
  const dataSuggest = dataSuggestion(state, workspace, {
    sessionAsked: Boolean(state.dataGenericAsked),
  });
  if (dataSuggest) state.dataGenericAsked = true;
  state.dataSuggestion = dataSuggest || '';
  // 荐书联想（归纳式推荐）：匹配思想库 → 一次一问，可拒绝；确认后由 captureKbMentions 收录。
  const recSuggest = recommendReadings(state, workspace, {
    sessionAsked: Boolean(state.kbRecommendAsked),
  });
  if (recSuggest) {
    state.kbRecommendAsked = true;
    const bookMatch = recSuggest.match(/《([^》]{1,30})》/);
    if (bookMatch) markAsked(workspace, `recommend:${normTitle(bookMatch[1])}`);
  }
  state.recommendSuggestion = recSuggest || '';
  // 内置思想库未命中 → 联网找相近作品（once/会话，去重；结果回灌后自动入知识库）。
  if (!recSuggest) {
    const topic = String(state.confirmed?.topic || '').trim();
    if (topic) {
      const webRec = webRecommendation(workspace, topic);
      const webBook = webRec.match(/《([^》]{1,30})》/)?.[1] || '';
      const kbHas = webBook
        ? listEntries(workspace).some((e) => normTitle(e.title) === normTitle(webBook))
        : false;
      if (webRec && webBook && !kbHas && !wasAsked(workspace, `recommend:${normTitle(webBook)}`)) {
        state.recommendSuggestion = webRec;
        markAsked(workspace, `recommend:${normTitle(webBook)}`);
      } else if (!state.thoughtSearchAsked) {
        state.thoughtSearchAsked = true;
        queueAssetSearch(workspace, `与「${topic}」主题相近的经典书籍与理论`, {
          purpose: 'thought-search',
        });
      }
    }
  }
  // 学术论证链缺口提示（仅论文）：缺缺口/方法时提示补一次（不强制，写作时会按论证链补全）。
  const acGap = academicGap(state);
  state.academicHint = acGap.ok
    ? ''
    : `（这篇论文还差：${acGap.missing.join('、')}——答不出来也没关系，我会在写作时按论证链补全。）`;
  // 合并 LLM 读出的蓝图增量，让"整篇文章"在澄清中持续生长。
  if (next.blueprintUpdate) {
    const u = next.blueprintUpdate;
    state.blueprint = state.blueprint || {};
    for (const k of ['article', 'whyNow', 'tension', 'readerTakeaway']) {
      if (typeof u[k] === 'string' && u[k].trim()) state.blueprint[k] = u[k].trim();
    }
    if (Array.isArray(u.skeleton)) {
      const sk = u.skeleton.filter((x) => typeof x === 'string' && x.trim());
      if (sk.length) state.blueprint.skeleton = sk.map((x) => x.trim()).slice(0, 8);
    }
  }
  if (next.question) {
    state.lastQuestion = next.question;
    // LLM 声明的 intent 优先；正则分类只做兜底，避免"问得自然、记错字段"。
    state.lastField = next.askedField || classifyAnswer(next.question, '').field;
  }
  const checklist = checklistOf(state);
  const doneCount = checklist.filter((c) => c.done).length;
  state.summary = next.ready
    ? '立意、论点与素材已确认，可生成大纲'
    : `澄清中（清单 ${doneCount}/${checklist.length}）`;
  state.justRefined = false; // 打磨问题已问出，下一轮恢复"大纲确认"判断
  state.nextStep = next.ready ? '运行 stylotrace outline' : '继续回答澄清问题';
  ws.writeState(workspace, state);
  return {
    ...next,
    phase: state.phase,
    confirmed: state.confirmed,
    materials: state.materials,
    blueprint: state.blueprint,
    knowledgeSuggestion: state.knowledgeSuggestion || '',
    dataSuggestion: state.dataSuggestion || '',
    recommendSuggestion: state.recommendSuggestion || '',
    academicHint: state.academicHint || '',
    searchSuggestion: state.userSearchSuggestion || '',
    style: styleProgress(workspace),
    stylePulse: lastInput
      ? { summary: clarifyPulse?.summary || '', suggestion: clarifyPulse?.suggestion || '' }
      : null,
    checklist,
    liveOutline: state.liveOutline,
  };
}

export async function clarifyOnce(cfg, wsDir, { input } = {}) {
  let answer = input ?? '';
  if (answer === '' && !process.stdin.isTTY) {
    answer = fs.readFileSync(0, 'utf8').trim();
  }
  return clarifyStep(cfg, wsDir, { lastInput: answer });
}

export { missingNeed };

export async function clarifyInteractive(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  let lowWill = 0;
  let lastInput = '';
  let state = ws.readState(workspace);
  console.log('Stylotrace 澄清阶段（一次一问，随时说"你决定"结束）\n');
  try {
    while (true) {
      const next = await clarifyStep(cfg, wsDir, { lastInput });
      if (next.stop || (lowWill >= 2 && next.ready)) {
        state = ws.readState(workspace);
        state.summary = next.ready ? '澄清完成，可生成大纲' : '澄清暂停（素材未齐）';
        state.nextStep = next.ready
          ? '运行 stylotrace outline'
          : '还需补充：' + (missingNeed(state) || '细节');
        ws.writeState(workspace, state);
        break;
      }
      if (!next.question) {
        state = ws.readState(workspace);
        break;
      }
      let prompt = `\n${next.question}`;
      if (next.recommendation) prompt += `\n我的建议: ${next.recommendation}`;
      if (next.options?.length)
        prompt += `\n选项: ${next.options.map((o, i) => `${'ABC'[i]}. ${o}`).join('  ')}`;
      if (next.knowledgeSuggestion) prompt += `\n${next.knowledgeSuggestion}`;
      if (next.dataSuggestion) prompt += `\n${next.dataSuggestion}`;
      if (next.searchSuggestion) prompt += `\n${next.searchSuggestion}`;
      if (next.recommendSuggestion) prompt += `\n${next.recommendSuggestion}`;
      if (next.academicHint) prompt += `\n${next.academicHint}`;
      if (next.checklist?.length)
        prompt += `\n[清单] ${next.checklist.map((c) => `${c.done ? '✓' : '…'} ${c.label}`).join(' · ')}`;
      if (next.liveOutline?.sections?.length)
        prompt += `\n[实时大纲]\n${next.liveOutline.sections
          .map((s, i) => `${i + 1}. ${s.heading}（${s.function || ''}${s.words ? `，约${s.words}字` : ''}）${s.thesis ? `｜${s.thesis}` : ''}`)
          .join('\n')}`;
      const answer = await ask(prompt + '\n> ');
      if (isLowWill(answer)) lowWill += 1;
      else lowWill = 0;
      lastInput = answer;
    }
    console.log('\n' + ws.renderPanel(path.join(workspace, 'protocol', 'state.json')));
  } finally {
    rl.close();
  }
  return ws.readState(workspace);
}
