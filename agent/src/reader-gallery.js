// 读者群像（Reader Gallery）：交付前的感性反馈环节。
// 完全屏蔽"作者视角"，模拟 8 个不同读者第一次读这篇文章的心理活动：
// 哪里停下来、哪里走神、哪句记住了、最想对作者说什么。
// LLM 失败时退化为确定性反馈，保证这个环节永远不会缺席。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { styleProgress } from './style.js';

export const PERSONAS = [
  {
    id: 'teacher',
    name: '老教师',
    role: '教了一辈子书，最讨厌说教，也最怕空话',
    lens: '真诚不真诚、有没有具体的人与事、孩子读不读得懂',
  },
  {
    id: 'editor',
    name: '挑剔编辑',
    role: '每天审稿，一眼看出重复、注水、结构散',
    lens: '段落功能、重复句式、节奏、开头三行留不留得住人',
  },
  {
    id: 'student',
    name: '中学生',
    role: '被作业逼着读，读到一半会偷偷刷手机',
    lens: '第一句抓不抓人、有没有画面、会不会睡着',
  },
  {
    id: 'critic',
    name: '挑剔评论家',
    role: '不放过立意与论证的漏洞',
    lens: '核心立意是否成立、论点有没有展开、有没有偷换概念',
  },
  {
    id: 'parent',
    name: '焦虑家长',
    role: '关心孩子读到的价值观',
    lens: '导向、情绪、结尾留下的态度',
  },
  {
    id: 'historyFan',
    name: '历史爱好者',
    role: '较真细节，出戏立刻打回',
    lens: '事实、年代、人名、场景是否经得起查证',
  },
  {
    id: 'casual',
    name: '随性读者',
    role: '在地铁上随便点开，读不完就划走',
    lens: '前 30 秒、有没有一个瞬间让我停下来',
  },
  {
    id: 'youngWriter',
    name: '年轻作家',
    role: '一边读一边偷学笔法，也最敏感 AI 味',
    lens: '技巧、节奏、哪句像模板、哪句有作者自己的指纹',
  },
];

export function splitSections(text) {
  const parts = String(text || '').split(/\n(?=## )/);
  if (parts.length > 1) {
    return parts.map((p) => {
      const m = p.match(/^##\s*(.+)$/m);
      return { heading: m ? m[1].trim() : '（开头）', body: p };
    });
  }
  const paras = String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.map((p, i) => ({
    heading: i === 0 ? '开头' : i === paras.length - 1 ? '结尾' : `第 ${i + 1} 段`,
    body: p,
  }));
}

function fallbackPersona(persona, text, sections) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const moments = [];
  const clean = (s) =>
    String(s || '')
      .replace(/^#+\s*.*$/gm, '')
      .trim();
  const firstPara = clean(sections[0]?.body);
  const lastPara = clean(sections[sections.length - 1]?.body);
  if (persona.id === 'editor' || persona.id === 'youngWriter') {
    const dup = new Set();
    const pairs = t.match(/.{4,10}。?/g) || [];
    for (const p of pairs) {
      const norm = p.replace(/\s+/g, '');
      if (dup.has(norm)) {
        moments.push({ at: norm, thought: '这句前面好像见过，有点偷懒了。' });
        break;
      }
      dup.add(norm);
    }
  }
  if (persona.id === 'student' || persona.id === 'casual') {
    moments.push({
      at: firstPara.slice(0, 30) || '开头',
      thought: cjk < 60 ? '开头有点短，还没抓住我。' : '开头有画面，我愿往下读。',
    });
  }
  if (persona.id === 'historyFan') {
    moments.push({
      at: t.slice(0, 40) || '',
      thought: '里面的数字和年代我得去核一下，不核不敢信。',
    });
  }
  if (persona.id === 'teacher') {
    moments.push({
      at: lastPara.slice(0, 30) || '结尾',
      thought: '结尾有没有落到具体的人身上？光有道理不够。',
    });
  }
  if (persona.id === 'parent') {
    moments.push({
      at: lastPara.slice(0, 30) || '结尾',
      thought: '我想知道孩子读完后心里留下的是勇气还是空洞的道理。',
    });
  }
  if (persona.id === 'critic') {
    moments.push({ at: '', thought: '立意我看到了，但每个论点是不是都有实例撑着？' });
  }
  if (!moments.length) {
    moments.push({
      at: firstPara.slice(0, 20) || '开头',
      thought: '第一次读，我先看有没有让我停下来的句子。',
    });
  }
    return {
      id: persona.id,
      persona: persona.name,
      role: persona.role,
      impression: `（离线兜底反馈）我是${persona.name}：${persona.lens}。这篇文章我读完后的第一印象是${
      cjk < 300
        ? '篇幅偏短，还没来得及进入'
        : cjk >= 1500
          ? '信息量不小，有几处需要停一停'
          : '整体能读下去，但有几处想停下来'
    }。`,
    moments,
    advice: `写给你自己的细节比写给读者的道理更有力——${persona.lens.split('、')[0]}。`,
  };
}

const AUDIENCE_PROMPT = (persona, text) => `你是「${persona.name}」——${persona.role}。
你第一次读到下面这篇文章，请完全屏蔽"作者视角"和客套，只记录你真实的心理活动：

要求：
1. impression：读完全文后，你最直接的第一印象（两三句话，不点评文笔，只讲感受）。
2. moments：列出 2-3 个"让你停下来/走神/皱眉/心跳加快"的具体位置，at 必须引用原文片段（10-30 字），thought 写当时你心里在想什么。
3. advice：最后，你最想对作者说的一句话（可以是质疑、一句提醒、或者最打动你的地方）。

你特别在意：${persona.lens}。

【文章】
${text}

输出严格 JSON：
{"impression":"","moments":[{"at":"原文片段","thought":"当时心里想"}],"advice":""}`;

async function personaReaction(cfg, persona, text, sections) {
  if (!cfg.apiKey) return fallbackPersona(persona, text, sections);
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是一个真实的第一读者，输出严格 JSON。' },
        { role: 'user', content: AUDIENCE_PROMPT(persona, text) },
      ],
      { json: true, temperature: 0.9, maxTokens: 1000 },
    );
    const r = parseJsonContent(content, '读者反馈');
    return {
      id: persona.id,
      persona: persona.name,
      role: persona.role,
      impression: String(r.impression || ''),
      moments: Array.isArray(r.moments) ? r.moments.slice(0, 4) : [],
      advice: String(r.advice || ''),
    };
  } catch {
    return fallbackPersona(persona, text, sections);
  }
}

/**
 * 读者群像：对草稿跑 8 个（或 --quick 3 个）"第一读者"，输出群像化感性反馈。
 */
export async function runAudience(cfg, wsDir, { file = null, quick = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) {
    throw new Error(`找不到要审阅的文稿: ${draftFile}（先 sculptor write，或 --file 指定）`);
  }
  const text = fs.readFileSync(draftFile, 'utf8');
  const sections = splitSections(text);
  const selected = quick ? PERSONAS.slice(0, 3) : PERSONAS;
  const reactions = [];
  for (const p of selected) {
    reactions.push(await personaReaction(cfg, p, text, sections));
  }
  const sectionHeat = sections.map((s) => {
    const hits = reactions.flatMap((r) =>
      (r.moments || [])
        .filter((m) => m.at && s.body.includes(m.at))
        .map((m) => ({ persona: r.persona, thought: m.thought })),
    );
    return { heading: s.heading, reactions: hits };
  });
  const topAdvice = reactions
    .map((r) => ({ persona: r.persona, advice: r.advice }))
    .filter((r) => r.advice);
  const style = styleProgress(workspace);
  const report = {
    file: draftFile,
    personas: reactions,
    sectionHeat,
    topAdvice,
    style,
  };
  ws.logContext(
    workspace,
    'audience',
    `读者群像 ${reactions.length} 人，${sectionHeat.reduce((s, x) => s + x.reactions.length, 0)} 个反应点`,
  );
  return report;
}

export function renderAudience(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 读者群像 · 第一次阅读反馈', line);
  for (const p of report.personas) {
    out.push(`\n【${p.persona}】${p.role ? `（${p.role}）` : ''}`);
    if (p.impression) out.push(`读完后: ${p.impression}`);
    for (const m of p.moments || []) {
      out.push(`  · 「${m.at}」`);
      out.push(`    → ${m.thought}`);
    }
    if (p.advice) out.push(`最想对作者说: ${p.advice}`);
  }
  out.push(`\n${line}`, '哪些位置触动了读者', line);
  for (const s of report.sectionHeat) {
    if (!s.reactions.length) continue;
    out.push(`「${s.heading}」`);
    for (const r of s.reactions) out.push(`  · ${r.persona}: ${r.thought}`);
  }
  const style = report.style;
  if (style?.write) {
    out.push(
      `\n风格档案（本次阅读时的写/读档案）: write 已学 ${style.write.learned}/${style.write.total} · read ${style.read.learned}/${style.read.total}`,
    );
  }
  out.push(line);
  return out.join('\n');
}

// ── 读者交锋辩论（MAJ-EVAL 式多智能体评审）────────────────────────
// 8 位"第一读者"各自读完只代表 8 个单点；再选分歧最大的 3 位进入交锋，
// 互相看到对方最尖锐的意见后收敛出"共识 / 争议 / 优先级"——共识直接改，
// 争议留给作者拍板。LLM 失败时用确定性主题聚类兜底，环节永不缺席。

export const DEBATE_IDS = ['teacher', 'critic', 'youngWriter', 'editor'];

const THEME_WORDS = [
  ['重复', '注水', '赘余'],
  ['结尾', '收束'],
  ['开头', '开场'],
  ['空洞', '空泛', '口号', '说教'],
  ['细节', '具体', '画面'],
  ['事实', '数字', '年代', '查证'],
  ['节奏', '句式', '句长'],
  ['比喻', '意象', '文艺'],
  ['结构', '段落', '层次'],
  ['立场', '立意', '论点'],
];

function themeOf(text) {
  const t = String(text || '');
  for (const words of THEME_WORDS) {
    if (words.some((w) => t.includes(w))) return words[0];
  }
  return '其他';
}

function deterministicDebate(debaters) {
  const themes = new Map(); // theme -> { personas: [], advice: [], quotes: [] }
  for (const d of debaters) {
    const theme = themeOf(d.sharpest);
    if (!themes.has(theme)) themes.set(theme, { personas: [], advice: [], quotes: [] });
    const t = themes.get(theme);
    if (!t.personas.includes(d.persona)) t.personas.push(d.persona);
    t.advice.push(d.sharpest);
    if (d.quote) t.quotes.push(d.quote);
  }
  const sorted = [...themes.entries()].sort((a, b) => b[1].personas.length - a[1].personas.length);
  const shared = sorted.filter(([, t]) => t.personas.length >= 2);
  const solo = sorted.filter(([, t]) => t.personas.length === 1);
  const consensus = shared.slice(0, 3).map(([theme, t]) => ({
    point: `${theme}：${t.advice[0]}`,
    quote: t.quotes[0] || '',
  }));
  const disputes = solo.slice(0, 3).map(([theme, t]) => ({
    topic: theme,
    views: t.advice.slice(0, 2),
  }));
  const priority = sorted.slice(0, 3).map(([theme, t], i) => ({
    action: t.advice[0],
    quote: t.quotes[0] || '',
    why: `${t.personas.join('、')}都提到了${theme}`,
  }));
  return {
    exchanges: debaters.map((d) => ({
      persona: d.persona,
      reply: `我最想说的是：${d.sharpest}`,
    })),
    consensus,
    disputes,
    priority,
    mode: 'fallback',
  };
}

const DEBATE_PROMPT = (ctx) => `你是 Sculptor 的读者辩论主持人（MAJ-EVAL 式多智能体交锋）。三位"第一读者"第一次读同一篇文章，各执一词。请组织一轮交锋并收敛，让作者拿到可直接执行的结论。

【文章】（节选）
${ctx.excerpt}

【三位读者与最尖锐的意见】
${ctx.debaters
  .map(
    (d, i) =>
      `${i + 1}. ${d.persona}（${d.role}）：\n   最尖锐的意见：${d.sharpest}\n   引用原文：${d.quote || '（无）'}`,
  )
  .join('\n\n')}

规则：
1. exchanges：先让三人互相看到对方最尖锐的意见，每人给一句回应（认同/反驳/补充），
   回应里必须提到至少一位其他读者。
2. consensus：三人一致同意"必须改"的（≤3 条，point 写清改什么，quote 引用原文）。
3. disputes：三人意见冲突、留给作者拍板的（≤3 条，topic + 双方观点 views）。
4. priority：按"对读者伤害大小"排序的可执行行动（≤3 条，action/quote/why）。
5. 不要客套，不要表扬，只给能直接改的结论。

输出严格 JSON：
{"exchanges":[{"persona":"","reply":""}],"consensus":[{"point":"","quote":""}],"disputes":[{"topic":"","views":[""]}],"priority":[{"action":"","quote":"","why":""}]}`;

async function llmDebate(cfg, debaters, text) {
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是读者辩论主持人，输出严格 JSON。' },
      {
        role: 'user',
        content: DEBATE_PROMPT({
          excerpt: String(text || '').slice(0, 2400),
          debaters,
        }),
      },
    ],
    { json: true, temperature: 0.55, maxTokens: 1800 },
  );
  const r = parseJsonContent(content, '读者辩论');
  return {
    exchanges: Array.isArray(r.exchanges) ? r.exchanges.slice(0, 3) : [],
    consensus: Array.isArray(r.consensus) ? r.consensus.slice(0, 3) : [],
    disputes: Array.isArray(r.disputes) ? r.disputes.slice(0, 3) : [],
    priority: Array.isArray(r.priority) ? r.priority.slice(0, 3) : [],
    mode: 'llm',
  };
}

/**
 * 读者交锋辩论：8 位"第一读者"反应（可复用 runAudience 结果）→ 3 位分歧最大者交锋 → 共识/争议/优先级。
 * @param reactions 已跑过的群像反应（personas）；缺省先跑 runAudience。
 */
export async function runDebate(
  cfg,
  wsDir,
  { file = null, quick = false, reactions = null } = {},
) {
  const workspace = ws.ensureWorkspace(wsDir);
  const personas = reactions || (await runAudience(cfg, wsDir, { file, quick })).personas;
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) {
    throw new Error(`找不到要交锋的文稿: ${draftFile}（先 sculptor write，或 --file 指定）`);
  }
  const text = fs.readFileSync(draftFile, 'utf8');
  const sections = splitSections(text);
  const debaters = personas
    .filter((p) => DEBATE_IDS.includes(p.id))
    .slice(0, 3)
    .map((p) => {
      const moment = (p.moments || [])[0];
      return {
        persona: p.persona,
        role: p.role,
        sharpest: p.advice || moment?.thought || p.impression || '',
        quote: moment?.at || '',
      };
    })
    .filter((d) => d.sharpest);
  if (!debaters.length) {
    return {
      file: draftFile,
      mode: 'none',
      exchanges: [],
      consensus: [],
      disputes: [],
      priority: [],
      reason: '没有可交锋的读者意见',
    };
  }
  let report;
  if (cfg.apiKey) {
    try {
      report = await llmDebate(cfg, debaters, text);
    } catch {
      report = deterministicDebate(debaters);
    }
  } else {
    report = deterministicDebate(debaters);
  }
  report.file = draftFile;
  report.sections = sections.map((s) => s.heading);
  report.debaters = debaters.map((d) => d.persona);
  ws.logContext(
    workspace,
    'debate',
    `读者交锋：${debaters.map((d) => d.persona).join('、')} → 共识 ${report.consensus.length}、争议 ${report.disputes.length}、优先级 ${report.priority.length}`,
  );
  return report;
}

/** 人类可读的辩论报告。 */
export function renderDebate(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 读者交锋 · 共识 / 争议 / 优先级', line);
  if (report.mode === 'none') {
    out.push(report.reason || '（无交锋）');
    out.push(line);
    return out.join('\n');
  }
  out.push(`交锋者：${(report.debaters || []).join('、')}（${report.mode === 'llm' ? 'LLM 交锋' : '确定性聚类兜底'}）`);
  if (report.exchanges?.length) {
    out.push('互看意见后的回应:');
    for (const e of report.exchanges) out.push(`  · ${e.persona}：${e.reply}`);
  }
  if (report.consensus?.length) {
    out.push('三人一致的共识（直接改）:');
    for (const c of report.consensus)
      out.push(`  · ${c.point}${c.quote ? `「${c.quote}」` : ''}`);
  }
  if (report.disputes?.length) {
    out.push('争议（作者拍板）:');
    for (const d of report.disputes) out.push(`  · ${d.topic}：${(d.views || []).join(' / ')}`);
  }
  if (report.priority?.length) {
    out.push('优先级（按对读者伤害排序）:');
    for (const p of report.priority)
      out.push(`  ${report.priority.indexOf(p) + 1}. ${p.action}${p.quote ? `「${p.quote}」` : ''}（${p.why}）`);
  }
  out.push(line);
  return out.join('\n');
}
