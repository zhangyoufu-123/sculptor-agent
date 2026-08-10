// 个人知识库（Personal Knowledge Base，v0.18）
// 理念：人的联想、理论与写作，都来源于“读过什么 + 个人经历”。AI 智库再大，
// 也只是通用底座；真正独特的是用户自己的知识库——读过的书、听过的理论、去过的地方、
// 看过的作品、自己的构想。设计三条铁律：
//   1) 归纳式确认：用户提出构想时，AI 主动问“你读过/去过相关的什么吗？”，
//      同意才记录——不硬塞、不强求；
//   2) 提问去重：同一个话题/作品只问一次，绝不反复追问；
//   3) 灵活调用：检索注入只作辅助参考，轮换使用（不用完所有条目、不每篇都翻同一本）。
// 存储：vault/knowledge/<id>.md —— 人类可直接阅读/编辑（JSON 头 + Markdown 笔记）。
// 参考：MemGPT 分层记忆 / Alexandria（来源可引、人可读）/ memories-off（像管代码一样管知识）/
//       read-aware（Agent 引导的简短访谈）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ws from './workspace.js';
import { recommendWorks } from './asset.js';

const KB_DIR = 'knowledge';
const ASKED_FILE = 'asked.jsonl';
const MAX_KB_INJECT = 3;

export function kbDir(workspace) {
  return path.join(workspace, 'vault', KB_DIR);
}

function kbFile(workspace, id) {
  return path.join(kbDir(workspace), `${id}.md`);
}

function askedFile(workspace) {
  return path.join(kbDir(workspace), ASKED_FILE);
}

export function kbId(title) {
  return createHash('sha1').update(String(title || '').trim()).digest('hex').slice(0, 10);
}

/** 规范化标题：去掉书名号/空格/引号，便于去重。 */
export function normTitle(t) {
  return String(t || '').replace(/[《》「」“”"'‘’\s]/g, '').toLowerCase();
}

// ── 条目读写（<id>.md：JSON frontmatter + Markdown 笔记）────────────
export function listEntries(workspace) {
  const dir = kbDir(workspace);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }
  return files
    .map((f) => readEntry(workspace, f.replace(/\.md$/, '')))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function readEntry(workspace, id) {
  try {
    const text = fs.readFileSync(kbFile(workspace, id), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return null;
    const meta = JSON.parse(m[1]);
    return { ...meta, id, note: m[2].trim() };
  } catch {
    return null;
  }
}

export function writeEntry(workspace, entry) {
  fs.mkdirSync(kbDir(workspace), { recursive: true });
  const { note, ...meta } = entry;
  const text = `---\n${JSON.stringify(meta, null, 2)}\n---\n${note || ''}\n`;
  fs.writeFileSync(kbFile(workspace, entry.id), text, { mode: 0o600 });
  return entry;
}

/** 新增（自动去重：同标题存在则返回已有条目）。 */
export function addEntry(workspace, { title, type = 'book', author = '', note = '', tags = [], relatedTo = [], source = 'user-stated', confidence = 0.9 } = {}) {
  const t = String(title || '').trim();
  if (!t) throw new Error('知识条目需要标题');
  const existing = listEntries(workspace).find((e) => normTitle(e.title) === normTitle(t));
  if (existing) return { entry: existing, created: false };
  const entry = {
    id: kbId(t),
    title: t,
    type,
    author,
    note,
    tags: Array.isArray(tags) ? tags : [],
    relatedTo: Array.isArray(relatedTo) ? relatedTo : [],
    source,
    confidence: Number(confidence) || 0.9,
    usageCount: 0,
    lastUsedAt: null,
    createdAt: ws.nowIso(),
    updatedAt: ws.nowIso(),
  };
  writeEntry(workspace, entry);
  ws.logContext(workspace, 'knowledge', `新增知识条目：${t}（${type}，来源 ${source}）`);
  return { entry, created: true };
}

export function removeEntry(workspace, id) {
  const f = kbFile(workspace, id);
  if (!fs.existsSync(f)) throw new Error(`知识条目不存在: ${id}`);
  fs.rmSync(f);
  return { removed: id };
}

export function updateEntry(workspace, id, patch = {}) {
  const cur = readEntry(workspace, id);
  if (!cur) throw new Error(`知识条目不存在: ${id}`);
  const next = { ...cur, ...patch, id, updatedAt: ws.nowIso() };
  writeEntry(workspace, next);
  return next;
}

// ── 匹配（BM25 字符二元组 + 标签/关联词兜底）──────────────────────
function tokenize(text) {
  const clean = String(text || '').toLowerCase().replace(/[\s\d]+/g, '').replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z]/g, '');
  const grams = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) grams.push(g);
  }
  return grams;
}

function bm25(docs, query) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return docs.map(() => 0);
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const g of new Set(d.grams)) df.set(g, (df.get(g) || 0) + 1);
  const avgdl = docs.reduce((s, d) => s + d.grams.length, 0) / N;
  return docs.map((d) => {
    const tf = new Map();
    for (const g of d.grams) tf.set(g, (tf.get(g) || 0) + 1);
    let s = 0;
    for (const g of q) {
      const f = tf.get(g) || 0;
      if (!f) continue;
      s += Math.log(1 + (N - (df.get(g) || 1) + 0.5) / ((df.get(g) || 1) + 0.5)) * ((f * 2.5) / (f + 1.5 * (1 - 0.75 + 0.75 * (d.grams.length / Math.max(1, avgdl)))));
    }
    return s;
  });
}

/**
 * 按主题检索知识库：BM25 + 新鲜度轮换（优先没用过/最近最少用的高分条目）。
 * @param opts { limit, avoidIds } — avoidIds 用于本轮已注入的去重
 */
export function matchKb(workspace, query, { limit = MAX_KB_INJECT, avoidIds = [] } = {}) {
  const entries = listEntries(workspace).filter((e) => !avoidIds.includes(e.id));
  if (!entries.length) return [];
  const docs = entries.map((e) => ({
    ...e,
    grams: tokenize(`${e.title} ${e.author} ${e.note} ${(e.tags || []).join(' ')} ${(e.relatedTo || []).join(' ')}`),
  }));
  const raw = bm25(docs, query);
  const max = Math.max(...raw, 1e-9);
  return docs
    .map((d, i) => ({
      ...d,
      // 新鲜度轮换：没用过的 +0.2，用过的按次数递减（封顶 -0.45），
      // 避免同一本书被反复注入、让读者起疑。
      score: Number(
        (raw[i] / max + (d.usageCount ? -Math.min(0.45, d.usageCount * 0.15) : 0.2)).toFixed(3),
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id, title, type, author, note, score }) => ({ id, title, type, author, note, score }));
}

/** 标记使用（轮换依据）。 */
export function markUsed(workspace, ids) {
  for (const id of ids) {
    const e = readEntry(workspace, id);
    if (e) updateEntry(workspace, id, { usageCount: (e.usageCount || 0) + 1, lastUsedAt: ws.nowIso() });
  }
}

/** 注入用的简短文本（辅助参考，不强制）。 */
export function knowledgeBrief(workspace, query) {
  const hits = matchKb(workspace, query);
  if (!hits.length) return '';
  markUsed(workspace, hits.map((h) => h.id));
  return hits
    .map(
      (h) =>
        `- 《${h.title.replace(/^《|》$/g, '')}》${h.author ? `（${h.author}）` : ''}${
          h.note ? `：${h.note.slice(0, 80)}` : ''
        }`,
    )
    .join('\n');
}

// ── 归纳式提问去重 ─────────────────────────────────────────
export function wasAsked(workspace, key) {
  try {
    const lines = fs.readFileSync(askedFile(workspace), 'utf8').split('\n').filter(Boolean);
    return lines.some((l) => {
      try {
        return JSON.parse(l).key === key;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function markAsked(workspace, key, { declined = false } = {}) {
  fs.mkdirSync(kbDir(workspace), { recursive: true });
  ws.appendLine(askedFile(workspace), JSON.stringify({ key, declined, ts: ws.nowIso() }));
}

/**
 * 澄清时的归纳式一问（只生成一次、非阻塞）：
 * 用户提到《书名》且库里没有且没问过 → 提议记入知识库；
 * 用户没提书名但主题明确且库中无相关 → 每会话最多一次，泛问“读过/去过相关的吗”。
 */
export function knowledgeSuggestion(state, workspace, { sessionAsked = false } = {}) {
  const last = String(state.lastInput || '');
  const books = [...last.matchAll(/《([^》]{1,30})》/g)].map((m) => m[1]);
  for (const b of books) {
    const key = `book:${normTitle(b)}`;
    if (!wasAsked(workspace, key) && !listEntries(workspace).some((e) => normTitle(e.title) === normTitle(b))) {
      return `（如果《${b}》是你读过/喜欢的作品，告诉我一声，我会把它记入你的个人知识库，之后写作用得上。）`;
    }
  }
  // 主题泛问：只允许每会话一次，且库里完全没有相关条目
  const topic = state.confirmed?.topic || state.confirmed?.theme || '';
  if (!sessionAsked && topic && !matchKb(workspace, topic).length) {
    return `（这个话题你读过什么书、或去过相关的地方吗？说给我，我会记进你的个人知识库——没有也没关系。）`;
  }
  return '';
}

// ── 从用户输入中归纳收录（同意才记，不硬塞）────────────────────
const CONFIRM_RE =
  /读过|看过|喜欢|爱看|爱读|很喜欢|确实是|是的|对，|可以|好，|嗯|没错|同意|收录|记下|一直想看/;
const DECLINE_RE = /没读过|没看过|没读|没看|没去过|没有读过|没有看过|不是|算了|不用|不记得|谈不上/;
const GENERIC_PLACE = /^(地方|那里|那些|这边|这些|几次|许多|很多|不少|一些|好几个地方|别处)$/;

/** 用户输入是否带"确认读过/喜欢"信号。 */
export function confirmSignal(input) {
  return CONFIRM_RE.test(String(input || ''));
}

/** 用户输入是否带"否认/拒绝"信号。 */
export function declineSignal(input) {
  return DECLINE_RE.test(String(input || ''));
}

/**
 * 从用户回答中捕获可收录的知识：带确认信号的《书名》+ "去过/参观过 ×"。
 * 库中已有自动跳过；返回本次新收录的条目 id。
 * @param opts.pendingBook 上一条建议里悬而未决的书（用户答"读过/喜欢"即补录）
 */
export function captureKbMentions(workspace, input, { pendingBook = '' } = {}) {
  const text = String(input || '');
  if (!text) return [];
  const captured = [];
  const declined = declineSignal(text);
  const confirmed = confirmSignal(text);
  const exists = (title) =>
    listEntries(workspace).some((e) => normTitle(e.title) === normTitle(title));
  const handle = (title, type, source) => {
    const t = String(title || '').trim();
    if (!t || declined || exists(t)) return;
    const { entry, created } = addEntry(workspace, {
      title: t,
      type,
      note: text.slice(0, 200),
      source,
    });
    if (created) captured.push(entry.id);
  };
  // 悬而未决的书：用户答"读过/喜欢/可以"→ 补录
  if (pendingBook && confirmed) handle(pendingBook, 'book', 'user-confirmed');
  // 明确提到《书名》且带确认信号 → 收录
  const books = [...text.matchAll(/《([^》]{1,30})》/g)].map((m) => m[1]);
  for (const b of books) {
    if (confirmed || (pendingBook && normTitle(b) === normTitle(pendingBook))) {
      handle(b, 'book', 'user-confirmed');
    }
  }
  // 去过/参观过的地方（泛问时已声明"说给我，我会记进知识库"）→ 收录为 place
  if (!declined) {
    const m = text.match(/(?:去过|到过|参观过|游览过|待过|住在)\s*([\u4e00-\u9fff·]{2,12})/);
    if (m) {
      const name = m[1]
        .replace(/^的/, '')
        .replace(/(多了|很多|不少|一些|几个|好几次|那里|那些|等地|等)$/, '')
        .trim();
      if (name.length >= 2 && !GENERIC_PLACE.test(name)) handle(name, 'place', 'user-confirmed');
    }
  }
  return captured;
}

/**
 * 荐书联想（归纳式推荐）：作者心里有想法 → 从思想库匹配相近的书/理论，
 * 用简明语言说明"理论是什么、为什么可以用"，并关联用户已有知识库（互链、共享）。
 * 只问一次、可拒绝：用户确认读过/感兴趣 → 由调用方 addEntry 收录。
 */
export function recommendReadings(state, workspace, { sessionAsked = false } = {}) {
  if (sessionAsked) return '';
  const recs = recommendWorks(state).filter(
    (r) => !listEntries(workspace).some((e) => normTitle(e.title) === normTitle(r.title)),
  );
  if (!recs.length) return '';
  const r = recs[0];
  const topic =
    state?.confirmed?.topic ||
    String(state?.lastInput || '').slice(0, 24) ||
    '这个主题';
  const why = (r.apply || []).slice(0, 3).join('、');
  // 与用户已有知识库互链：库里有相近条目时带上，让"读过的东西"彼此勾连
  const related = listEntries(workspace)
    .filter((e) => (e.relatedTo || []).some((t) => (r.apply || []).includes(t)) || r.apply?.some((a) => normTitle(e.title).includes(normTitle(a))))
    .slice(0, 1)
    .map((e) => `（你知识库里已有「${e.title}」，和它思路相通）`)
    .join('');
  return (
    `（我想到一本和你想法相近的书：${r.title}（${r.author}）。它的核心是：${r.core}。` +
    `用在这篇文章里，是因为你谈的是「${topic}」——它能提供「${why}」这一层的支撑。${related}` +
    '读过或感兴趣的话告诉我一声，我记进你的个人知识库并作为写作参考；没读过也没关系。）'
  );
}
