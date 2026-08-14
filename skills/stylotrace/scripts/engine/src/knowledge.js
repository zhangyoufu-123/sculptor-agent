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
import { chatWithRetry, parseJsonContent } from './llm.js';
import { embedText, cosineDenseVec } from './embedding.js';

const KB_DIR = 'knowledge';
const ASKED_FILE = 'asked.jsonl';
const MAX_KB_INJECT = 3;
const KB_VECTOR_FILE = 'kb-vectors.json';

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

/** 低置信知识是否已可升级为"已查验"：用户确认过（读过/看过/就是那个）即升级。 */
export function confirmLowConfidenceEntries(workspace) {
  const upgraded = [];
  for (const e of listEntries(workspace)) {
    if (e.confidence >= 0.9 && e.verified) continue;
    if (['web-rag', 'user-referenced', 'user-stated-ai'].includes(String(e.source || ''))) {
      const next = updateEntry(workspace, e.id, {
        confidence: 0.95,
        verified: true,
        source: String(e.source || '').includes('web') ? 'web-confirmed' : 'user-confirmed',
      });
      upgraded.push(next.id);
    }
  }
  return upgraded;
}

/** AI 知识筛选触发信号（有这些字眼才值得花一次 LLM 调用去提炼）。 */
const KB_AI_GATE =
  /《[^》]{1,30}》|看过|读过|在B站|B站|b站|视频|纪录片|新闻|报道|文章|参观|去过|到过|采访|讲座|听过|学到一个|知道了|研究了|关注了|刷到|刷过/;

/** LLM 主导的知识筛选（v0.58）：从用户原话提炼 书/视频(B站)/新闻/文章/地方/观点，
 *  只收明确提及、高置信的条目；LLM 不可用时返回空（由正则兜底路径继续）。 */
export async function extractKnowledgeWithLLM(cfg, text) {
  const prompt = `从用户发言中提取值得记入个人知识库的条目——用户明确提到"看过/读过/刷到/去过/听过的"书籍、B站等视频、
新闻/报道、文章、地方，以及 TA 明确认可的重要观点或人物。
只提取明确提及的条目；泛泛的"我看了个视频"不提取。
每条输出：title（条目名，如视频/新闻的标题或主题）、type（book/video/news/article/place/idea/person）、
note（一句话说明来源与内容，如"在B站看过，讲宋朝饮食"）、tags（2-4 个标签）、confidence（0-1）。
输出严格 JSON：{"items":[{"title":"","type":"","note":"","tags":[],"confidence":0.9}]}

用户发言：${String(text || '').slice(0, 400)}`;
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是个人知识库管理员，只收录明确提及的条目，输出严格 JSON。' },
      { role: 'user', content: prompt },
    ],
    { json: true, temperature: 0.2, maxTokens: 900 },
  );
  const r = parseJsonContent(content, '知识筛选');
  const items = Array.isArray(r?.items) ? r.items : [];
  return items
    .filter((x) => x && String(x.title || '').trim() && Number(x.confidence || 0) >= 0.6)
    .map((x) => ({
      title: String(x.title).trim().slice(0, 60),
      type: ['book', 'video', 'news', 'article', 'place', 'idea', 'person'].includes(x.type)
        ? x.type
        : 'idea',
      note: String(x.note || '').trim().slice(0, 300),
      tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 6) : [],
      confidence: Math.max(0.6, Math.min(Number(x.confidence) || 0.6, 0.95)),
    }));
}

/** AI 主导入库（v0.58）：命中信号才调用 LLM；新增条目直接写库并返回 id 列表。 */
export async function captureKnowledgeAI(cfg, workspace, text) {
  if (!cfg?.apiKey || !KB_AI_GATE.test(String(text || ''))) return { added: [], skipped: 0 };
  try {
    const items = await extractKnowledgeWithLLM(cfg, text);
    const added = [];
    for (const it of items) {
      if (!it.title) continue;
      const { entry, created } = addEntry(workspace, {
        title: it.title,
        type: it.type,
        note: it.note,
        tags: it.tags,
        source: 'user-stated-ai',
        confidence: it.confidence,
      });
      if (created) added.push(entry.id);
    }
    return { added, skipped: items.length - added.length };
  } catch {
    return { added: [], skipped: 0 };
  }
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

function kbVectorFile(workspace) {
  return path.join(workspace, 'vault', KB_VECTOR_FILE);
}

function readKbVectors(workspace) {
  try {
    const obj = JSON.parse(fs.readFileSync(kbVectorFile(workspace), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeKbVectors(workspace, cache) {
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(kbVectorFile(workspace), JSON.stringify(cache) + '\n', { mode: 0o600 });
  } catch {}
}

/**
 * 向量混合检索（v0.65）：BM25 字符二元组 + 语义 embedding 余弦融合（0.6/0.4），
 * 条目向量落盘缓存（vault/kb-vectors.json）。未配置/失败时自动降级为纯 BM25
 * （排序与 matchKb 一致），语义层是增强而非依赖。
 */
export async function matchKbHybrid(
  cfg = {},
  workspace,
  query,
  { limit = MAX_KB_INJECT, avoidIds = [], fetchImpl = null } = {},
) {
  const entries = listEntries(workspace).filter((e) => !avoidIds.includes(e.id));
  if (!entries.length) return [];
  const docs = entries.map((e) => ({
    ...e,
    grams: tokenize(`${e.title} ${e.author} ${e.note} ${(e.tags || []).join(' ')} ${(e.relatedTo || []).join(' ')}`),
  }));
  const rawBm25 = bm25(docs, query);
  const maxB = Math.max(...rawBm25, 1e-9);
  let sims = null;
  const qv = await embedText(cfg, query, { fetchImpl });
  if (qv) {
    const cache = readKbVectors(workspace);
    sims = [];
    for (const e of entries) {
      let v = cache[e.id];
      if (!v) {
        v = await embedText(cfg, `${e.title} ${e.author} ${e.note}`, { fetchImpl });
        if (v) cache[e.id] = Array.from(v);
      }
      const c = v ? cosineDenseVec(qv, v) : null;
      sims.push(c !== null && Number.isFinite(c) ? c : null);
    }
    writeKbVectors(workspace, cache);
  }
  return docs
    .map((d, i) => {
      const bm = rawBm25[i] / maxB;
      const sem = sims ? (sims[i] === null ? 0 : (sims[i] + 1) / 2) : 0;
      const base = sims ? 0.6 * bm + 0.4 * sem : bm;
      return {
        ...d,
        score: Number(
          (base + (d.usageCount ? -Math.min(0.45, d.usageCount * 0.15) : 0.2)).toFixed(3),
        ),
        bm25: Number(bm.toFixed(3)),
        semantic: sims && sims[i] !== null ? Number(sims[i].toFixed(3)) : null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id, title, type, author, note, score, bm25, semantic }) => ({
      id,
      title,
      type,
      author,
      note,
      score,
      bm25,
      semantic,
    }));
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
// 引用式提及：无书名号、但明显在引用一本书/一段论述（"在乡土中国中听到…"）
const BARE_REFER_RE =
  /(?:(?<![站坐走待住躺放立挂贴摆存藏听看])在|读到|看到|听到|提到|讲到|论述|说过|读过|看过)([\u4e00-\u9fff·]{2,8})(?:中|里|一书|这本书|那本书|这部|那部|里面有|论述|讲到|提到)/g;
const EXCLUDE_BARE = new Set([
  '这里', '那里', '刚才', '之前', '现在', '时候', '之后', '上面', '下面', '里面',
  '其中', '方面', '当中', '中间', '过程', '情况', '环境', '社会', '世界', '生活',
  '学习', '工作', '对话', '讨论', '文章', '作品', '内容', '文字', '语言', '思想',
  '观念', '理论', '问题', '事情', '东西', '原因', '说法', '段落', '章节',
]);

/** 书名号《书名》是否处于"引用"语境（读到/听到/论述/中/里…）。 */
function isReferencedTitle(text, title) {
  const t = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`(?:在|读到|看到|听到|提到|讲到|论述|说过|读过|看过|书中|书里|作品|文章)[^。；，！？]{0,14}《${t}》`).test(text) ||
    new RegExp(`《${t}》[^。；，！？]{0,10}(?:中|里|论述|讲到|提到|读到|看到|听到)`).test(text)
  );
}

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
  const handle = (title, type, source, confidence = 0.9, skipDeclined = false) => {
    const t = String(title || '').trim();
    if (!t || exists(t)) return;
    if (declined && !skipDeclined) return;
    const { entry, created } = addEntry(workspace, {
      title: t,
      type,
      note: text.slice(0, 200),
      source,
      confidence,
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
    } else if (isReferencedTitle(text, b)) {
      // 引用式提及：即使没明说"读过"，用户主动引用/要求查证 → 低置信收录，标注来源
      handle(b, 'book', 'user-referenced', 0.6, true);
    }
  }
  // 无书名号的引用式提及："在乡土中国中听到一段论述" → 收录（低置信、可删除）
  if (!declined) {
    for (const m of text.matchAll(BARE_REFER_RE)) {
      let name = String(m[1] || '')
        .replace(/^(这|那|我|你|他|她|一|各|某|我们|你们|他们)/, '')
        .replace(/(多了|很多|不少|一些|几个|好几次|等地|等)$/, '')
        .trim();
      // "站在那间教室里"这类不是书目引用：原名以"这/那"开头直接跳过
      if (/^[这那]/.test(String(m[1] || ''))) continue;
      if (name.length < 2 || EXCLUDE_BARE.has(name) || exists(name)) continue;
      const { entry, created } = addEntry(workspace, {
        title: name,
        type: 'book',
        note: text.slice(0, 200),
        source: 'user-referenced',
        confidence: 0.6,
      });
      if (created) captured.push(entry.id);
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

// ── 跨工作区迁移（v0.23）：个人知识库随人走，不锁在单个项目里 ──

/** 导出知识库为可移植 bundle（含条目与"已问过"记录）。 */
export function exportKnowledge(workspace, outFile = '') {
  const entries = listEntries(workspace);
  const asked = [];
  try {
    asked = fs
      .readFileSync(askedFile(workspace), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  const bundle = {
    schemaVersion: '1.0',
    exportedAt: ws.nowIso(),
    entries,
    asked,
  };
  const dest = outFile ? path.resolve(outFile) : path.join(workspace, 'vault', 'knowledge-export.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
  return { file: dest, entries: entries.length, asked: asked.length };
}

/** 导入知识库 bundle（按标题去重合并；本地已有则不动）。 */
export function importKnowledge(workspace, file) {
  const bundle = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const entries = Array.isArray(bundle.entries) ? bundle.entries : [];
  let added = 0;
  for (const e of entries) {
    if (!e?.title) continue;
    const r = addEntry(workspace, {
      title: e.title,
      type: e.type || 'book',
      author: e.author || '',
      note: e.note || '',
      tags: e.tags || [],
      relatedTo: e.relatedTo || [],
      source: e.source || 'imported',
      confidence: Number(e.confidence) || 0.9,
    });
    if (r.created) added += 1;
  }
  let askedAdded = 0;
  if (Array.isArray(bundle.asked)) {
    for (const a of bundle.asked) {
      if (a?.key && !wasAsked(workspace, a.key)) {
        markAsked(workspace, a.key, { declined: Boolean(a.declined) });
        askedAdded += 1;
      }
    }
  }
  ws.logContext(workspace, 'knowledge', `导入 ${added} 条知识 + ${askedAdded} 条提问记录`);
  return { added, askedAdded };
}
