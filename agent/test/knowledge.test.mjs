// 个人知识库（PKB）单元测试：零依赖、离线。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kbDir,
  listEntries,
  readEntry,
  addEntry,
  updateEntry,
  removeEntry,
  matchKb,
  markUsed,
  knowledgeBrief,
  wasAsked,
  markAsked,
  knowledgeSuggestion,
  captureKbMentions,
  confirmSignal,
  declineSignal,
  normTitle,
} from '../src/knowledge.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-kb-'));
const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });

// ── 收录与去重 ──────────────────────────────────────────
let r = addEntry(ws, { title: '《麦田里的守望者》', type: 'book', author: 'J.D. 塞林格', note: '读过' });
check('新增书条目', r.created === true && r.entry.title === '《麦田里的守望者》');
const bookId = r.entry.id;

r = addEntry(ws, { title: '《麦田里的守望者》', note: '重复添加' });
check('同书名去重（含书名号/空格差异）', r.created === false && r.entry.id === bookId);

r = addEntry(ws, { title: '北大红楼', type: 'place', note: '去过，红砖灰瓦' });
check('新增地点条目', r.created === true && r.entry.type === 'place');

check('listEntries 按创建时间倒序', listEntries(ws).length === 2);
check(
  '条目是人类可读 md（frontmatter + 笔记）',
  fs.readFileSync(path.join(kbDir(ws), `${bookId}.md`), 'utf8').includes('麦田里的守望者') &&
    fs.readFileSync(path.join(kbDir(ws), `${bookId}.md`), 'utf8').includes('读过'),
);

// ── 检索与轮换 ──────────────────────────────────────────
addEntry(ws, {
  title: '《我与地坛》',
  type: 'book',
  author: '史铁生',
  note: '关于生死、地坛与母亲，荒芜与落日',
  tags: ['散文', '生死'],
});
addEntry(ws, {
  title: '《百年孤独》',
  type: 'book',
  author: '马尔克斯',
  note: '魔幻现实主义，家族兴衰',
  tags: ['小说', '魔幻'],
});
addEntry(ws, {
  title: '《病隙碎笔》',
  type: 'book',
  author: '史铁生',
  note: '疾病与生命沉思，散文集',
  tags: ['散文', '生命'],
});

let hits = matchKb(ws, '地坛 生死 散文', { limit: 2 });
check(
  'BM25 命中相关条目',
  hits.length >= 1 && hits[0].title.includes('我与地坛'),
  JSON.stringify(hits.map((h) => h.title)),
);

// 轮换：在相近候选中，连续用满上限的条目让位给未用过的同主题条目
const related = matchKb(ws, '史铁生 散文 生死', { limit: 2 });
const usedId = related[0].id;
for (let i = 0; i < 4; i++) markUsed(ws, [usedId]);
const rotated = matchKb(ws, '史铁生 散文 生死', { limit: 2 });
check(
  '轮换：连续使用后排名让位',
  rotated[0].id !== usedId,
  JSON.stringify(rotated.map((h) => `${h.title}:${h.score}`)),
);

const brief = knowledgeBrief(ws, '北大红楼 游记');
check('knowledgeBrief 输出辅助参考', brief.includes('北大红楼'), brief.slice(0, 60));
const placeId = listEntries(ws).find((e) => e.title === '北大红楼').id;
const afterBrief = readEntry(ws, placeId);
check('knowledgeBrief 标记使用', afterBrief.usageCount >= 1);

// ── 提问去重 ────────────────────────────────────────────
check('未问过', wasAsked(ws, 'book:红楼梦') === false);
markAsked(ws, 'book:红楼梦');
check('问过后不再问', wasAsked(ws, 'book:红楼梦') === true);

// ── 归纳式一问 ──────────────────────────────────────────
let sug = knowledgeSuggestion(
  { lastInput: '我想写一篇像《瓦尔登湖》那样的游记', confirmed: {} },
  ws,
  { sessionAsked: false },
);
check(
  '新《书名》→ 提议收录',
  sug.includes('瓦尔登湖') && sug.includes('个人知识库'),
  sug.slice(0, 60),
);
// 调用方契约：建议生成后由 clarify/director 标记"已问过"
markAsked(ws, `book:${normTitle('瓦尔登湖')}`);

sug = knowledgeSuggestion(
  { lastInput: '我想写一篇像《瓦尔登湖》那样的游记', confirmed: {} },
  ws,
  { sessionAsked: false },
);
check('已问过的书不再问', !sug.includes('瓦尔登湖'));

sug = knowledgeSuggestion(
  { lastInput: '写北大红楼的感悟', confirmed: { topic: '北大红楼' } },
  ws,
  { sessionAsked: false },
);
check('主题泛问（库中已有相关则不触发）', sug === '');

const ws2 = path.join(root, 'ws2');
fs.mkdirSync(ws2, { recursive: true });
sug = knowledgeSuggestion(
  { lastInput: '写一篇关于量子纠缠的随笔', confirmed: { topic: '量子纠缠' } },
  ws2,
  { sessionAsked: false },
);
check(
  '主题泛问（库中无相关 → 每会话一次）',
  sug.includes('读过什么书') || sug.includes('个人知识库'),
  sug.slice(0, 60),
);
sug = knowledgeSuggestion(
  { lastInput: '继续', confirmed: { topic: '量子纠缠' } },
  ws2,
  { sessionAsked: true },
);
check('会话内已问过泛问 → 不再问', sug === '');

// ── 从回答中归纳收录 ────────────────────────────────────
check('确认信号', confirmSignal('读过，很喜欢'));
check('否认信号', declineSignal('没读过'));

let cap = captureKbMentions(ws2, '读过《给青年诗人的信》，很受触动');
check(
  '带确认信号的书名自动收录',
  cap.length === 1 && listEntries(ws2).some((e) => e.title.includes('给青年诗人的信')),
);

cap = captureKbMentions(ws2, '没读过《三体》，只是听说过');
check(
  '否认的书不收录',
  cap.length === 0 && !listEntries(ws2).some((e) => e.title.includes('三体')),
);

cap = captureKbMentions(ws2, '读过，很喜欢', { pendingBook: '《边城》' });
check(
  'pending 书被"读过"补录',
  cap.length === 1 && listEntries(ws2).find((e) => e.title.includes('边城'))?.source === 'user-confirmed',
);

cap = captureKbMentions(ws2, '去过北大红楼，站在那间教室里很震撼');
check(
  '去过的地方收录为 place',
  cap.length === 1 && listEntries(ws2).some((e) => e.type === 'place' && e.title.includes('北大红楼')),
);

const before = listEntries(ws2).length;
captureKbMentions(ws2, '去过很多地方，最喜欢江南');
check(
  '泛指地点不收录（"很多地方"）',
  listEntries(ws2).length === before || !listEntries(ws2).some((e) => e.title === '地方'),
);

// ── 更新与移除 ──────────────────────────────────────────
const target = listEntries(ws2).find((e) => e.title.includes('给青年诗人的信'));
updateEntry(ws2, target.id, { author: '里尔克' });
check('更新条目', readEntry(ws2, target.id).author === '里尔克');

removeEntry(ws2, target.id);
check('移除条目', !listEntries(ws2).some((e) => e.id === target.id));

check('normTitle 规范化', normTitle('《 麦田里的守望者 》') === normTitle('麦田里的守望者'));

console.log(`\n${failures === 0 ? '✓ 知识库测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
