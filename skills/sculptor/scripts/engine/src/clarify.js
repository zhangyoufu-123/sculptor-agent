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
} from './style.js';
import { pulseAfterClarify, pushPulseToState } from './style-pulse.js';
import { refreshStyleVector } from './style-vector.js';
import { detectGenre, genreBlueprint } from './genre.js';
import { parseTargetWords, guessTargetWords } from './budget.js';
import { extractInput } from './io.js';
import {
  knowledgeSuggestion,
  captureKbMentions,
  recommendReadings,
  listEntries,
  normTitle,
  markAsked,
  wasAsked,
} from './knowledge.js';
import { dataSuggestion, queueAssetSearch, webRecommendation } from './rag.js';
import { academicGap } from './academic.js';

const LOW_WILL = /没(有|什么)?更多|你决定|你自己决定|就这样|先这样|可以了|够了|你看着办/;
const NEED_LABELS = {
  topic: '主题',
  stance: '立场/目的',
  audience: '读者',
  materials: '具体素材',
  theme: '核心立意',
  argument: '支撑论点',
  emotion: '情感曲线',
  ending: '结尾姿态',
  styleSample: '风格底稿',
  blueprintConfirm: '整篇文章蓝图确认',
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

function classifyAnswer(question, _answer) {
  const q = question || '';
  // 蓝图回显优先识别：问题以"整篇文章"开头，不能被里面的"支撑论点"字样带偏。
  if (/整篇文章|蓝图确认|我理解的整篇/.test(q)) return { field: 'blueprint' };
  if (/论点|支撑|理由|论证|观点/.test(q)) return { field: 'argument' };
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

function applyAnswer(state, field, answer) {
  state.confirmed = state.confirmed || {};
  const a = answer.trim();
  // 蓝图确认在低意愿早退之前处理：用户说"可以/你决定"都算确认，防死循环。
  if (field === 'blueprint') {
    state.blueprint = state.blueprint || {};
    state.blueprintRounds = (state.blueprintRounds || 0) + 1;
    const norm = a.replace(/[，。！？、,.！\s]/g, '');
    const confirm =
      !a ||
      LOW_WILL.test(a) ||
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
  if (!a || LOW_WILL.test(a) || /^(没有|不知道|跳过|算了|none|na)$/i.test(a)) return state;
  if (field === 'topic') state.confirmed.topic = a;
  else if (field === 'stance') state.confirmed.stance = a;
  else if (field === 'audience') state.confirmed.audience = a;
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
    if (!state.confirmed.arguments.includes(a)) state.confirmed.arguments.push(a);
  } else if (field === 'emotion') state.confirmed.emotionalCurve = a;
  else if (field === 'ending') state.confirmed.endingTaste = a;
  else if (field === 'items') {
    state.confirmed.items = state.confirmed.items || [];
    if (!state.confirmed.items.includes(a)) state.confirmed.items.push(a);
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
    if (!state.materials.includes(a)) state.materials.push(a);
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
  // 蓝图 key 与状态存储的别名映射（emotion→emotionalCurve, ending→endingTaste）
  const valueKey =
    f.key === 'emotion' ? 'emotionalCurve' : f.key === 'ending' ? 'endingTaste' : f.key;
  return Boolean(c[valueKey]);
}

/** 第一个未满足的蓝图字段（含收尾的蓝图确认）。 */
function blueprintNeed(state) {
  for (const f of activeBlueprint(state)) {
    if (!fieldDone(state, f)) return f.key;
  }
  if (!state.confirmed?.blueprintConfirmed) return 'blueprintConfirm';
  return '';
}

/** 核心（必填、非风格底稿）维度是否齐了——齐了就能进大纲。 */
function materialGate(state) {
  for (const f of activeBlueprint(state)) {
    if (!f.required || f.key === 'styleSample') continue;
    if (!fieldDone(state, f)) return false;
  }
  return true;
}

function missingNeed(state) {
  return blueprintNeed(state);
}

async function askOnce(state, cfg, workspace) {
  const need = missingNeed(state);
  const coreReady = materialGate(state);
  const style = workspace ? styleProgress(workspace) : null;
  // 蓝图回显：核心信息齐 + 风格底稿问过之后，把整篇文章回显给用户确认，再进大纲。
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
    stageNeed:
      activeBlueprint(state).find((f) => f.key === need)?.label ||
      NEED_LABELS[need] ||
      '素材细节',
    blueprintFields: activeBlueprint(state).map((f) => f.label).join(' → '),
    coreReady,
    styleNote: state.confirmed.styleNote || '',
    blueprintText: state.blueprint && renderBlueprint(state),
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
      { json: true, temperature: 0.7, maxTokens: 1000 },
    );
    const q = parseJsonContent(content, '追问');
    if (q.stop && missingNeed(state) === '') {
      return { stop: true, ready: materialGate(state), question: null };
    }
    const question = String(q.question || '').trim();
    // 硬校验：一次只允许一个问题。LLM 一旦输出"一次多问"（≥3 个问号，或带编号/其次/另外的列举），
    // 退回确定性单问题，绝不让用户面对多问、也绝不自答默认。
    const qMarks = (question.match(/[？?]/g) || []).length;
    const multi =
      qMarks >= 3 ||
      /(^|\n)\s*([1-9一二三四五六]、?\.?)\s*/.test(question) ||
      /另外|还有|其次|最后，/.test(question);
    if (!question || multi) {
      const f =
        FALLBACK_QUESTIONS.find((x) => x.need === need) ||
        FALLBACK_QUESTIONS[FALLBACK_QUESTIONS.length - 1];
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
      recommendation: q.recommendation,
      options: q.options || [],
      blueprintUpdate: q.blueprintUpdate || null,
    };
  } catch (err) {
    // LLM 不可用时的确定性兜底：按缺口依次问，绝不死循环。
    const f =
      FALLBACK_QUESTIONS.find((x) => x.need === need) ||
      FALLBACK_QUESTIONS[FALLBACK_QUESTIONS.length - 1];
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

// 单步澄清：host（MCP）或脚本一次调用 = 应用一条用户消息 + 返回下一个问题。
export async function clarifyStep(cfg, wsDir, { lastInput = '' } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  let state = ws.readState(workspace);
  state.phase = 'clarify';
  state.blueprint = state.blueprint || {
    article: '',
    whyNow: '',
    tension: '',
    readerTakeaway: '',
    skeleton: [],
    corrections: [],
  };
  let clarifyPulse = null;
  if (lastInput) {
    state.lastInput = lastInput;
    // 文体识别：用户说"写一份关于××的通知/合同/请示…" → 记录文体，后续按范式写作。
    const genre = detectGenre(lastInput);
    if (genre) {
      state.confirmed.genre = genre;
      ws.logContext(workspace, 'clarify', `识别文体：${genre}`);
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
    applyAnswer(state, field, lastInput);
    // 风格全程采集：用户每一句话（含修改理由、素材、语气）都是风格信号。
    const style = applyStyleSignals(workspace, lastInput);
    if (style.writeUpdated + style.readUpdated > 0) {
      ws.logContext(
        workspace,
        'style',
        `被动采集到风格信号 ${style.writeUpdated} 维（write）+ ${style.readUpdated} 维（read）`,
      );
    }
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
    // pending 书已得到明确回应（确认已入库/否认/答了别的）→ 只问一次，清掉防误记
    if (state.pendingKbBook && lastInput.trim()) state.pendingKbBook = null;
    ws.logContext(workspace, 'clarify', `${state.lastQuestion || '（首轮）'} → ${lastInput}`);
  }
  const next = await askOnce(state, cfg, workspace);
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
    state.lastField = classifyAnswer(next.question, '').field;
  }
  state.summary = next.ready ? '立意、论点与素材已确认，可生成大纲' : '澄清中';
  state.nextStep = next.ready ? '运行 sculptor outline' : '继续回答澄清问题';
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
    style: styleProgress(workspace),
    stylePulse: lastInput
      ? { summary: clarifyPulse?.summary || '', suggestion: clarifyPulse?.suggestion || '' }
      : null,
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
  console.log('Sculptor 澄清阶段（一次一问，随时说"你决定"结束）\n');
  try {
    while (true) {
      const next = await clarifyStep(cfg, wsDir, { lastInput });
      if (next.stop || (lowWill >= 2 && next.ready)) {
        state = ws.readState(workspace);
        state.summary = next.ready ? '澄清完成，可生成大纲' : '澄清暂停（素材未齐）';
        state.nextStep = next.ready
          ? '运行 sculptor outline'
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
      if (next.recommendSuggestion) prompt += `\n${next.recommendSuggestion}`;
      if (next.academicHint) prompt += `\n${next.academicHint}`;
      const answer = await ask(prompt + '\n> ');
      if (LOW_WILL.test(answer)) lowWill += 1;
      else lowWill = 0;
      lastInput = answer;
    }
    console.log('\n' + ws.renderPanel(path.join(workspace, 'protocol', 'state.json')));
  } finally {
    rl.close();
  }
  return ws.readState(workspace);
}
