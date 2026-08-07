// 个人写作库：把用户写过的作品分类整理（议论文/散文/公文/合同…），
// 蒸馏出"这类文体你的写法"成为个人写作 skill（vault/skills/personal/<类别>.md）。
// 写作时按文体限量注入（不污染上下文）；用户随时可查看作品与蒸馏结果。
// Web 端将按 session 为单元组织——这里先用 projectId/session 字段记录来源。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry } from './llm.js';
import * as ws from './workspace.js';

export const CATEGORIES = [
  '议论文',
  '散文',
  '记叙文',
  '说明文',
  '学术论文',
  '新闻稿',
  '邮件',
  '视频脚本',
  '公文',
  '通知',
  '会议纪要',
  '合同',
  '报告',
  '演讲稿',
  '小说',
  '诗歌',
  '其他',
];

const CLASSIFY_RULES = [
  { cat: '合同', re: /合同|协议书|甲方|乙方|违约责任|第一条/ },
  { cat: '学术论文', re: /摘要|关键词|参考文献|引言|研究方法|结论.*不|一、引言|【摘要】/ },
  { cat: '视频脚本', re: /【画面】|【旁白】|【字幕】|分镜|口播|短视频|时长.*秒/ },
  { cat: '邮件', re: /主题行|此致敬礼|顺祝|敬上|邮箱|收件人|发件人/ },
  { cat: '新闻稿', re: /导语|本报讯|记者|通稿|5W1H|据.*报道/ },
  {
    cat: '公文',
    re: /特此通知|妥否，请批示|此复|为深入贯彻落实|现将.*印发|发文机关|请示|批复|通报|公告|通告|公报|决议|决定|命令|议案|贵单位|此函|特此函达/,
  },
  { cat: '通知', re: /^关于.*的通知|现就.*通知如下|请遵照执行/ },
  { cat: '会议纪要', re: /会议纪要|议定事项|参会人员|会议时间/ },
  { cat: '演讲稿', re: /尊敬的|同志们|老师们|同学们|首先，我想|最后，我想|谢谢大家/ },
  { cat: '报告', re: /报告|汇报|据统计|数据显示|建议如下|同比增长/ },
  { cat: '议论文', re: /我认为|由此可见|综上所述|首先.*其次.*最后|论点|论证|然而/ },
  { cat: '说明文', re: /分为.*类|具有.*特点|工作原理|使用方法|说明如下/ },
  { cat: '小说', re: /他[（(]?(说|想|看)[）)]?|她[（(]?(说|想|看)[）)]?|“[^”]*”他/ },
  { cat: '记叙文', re: /那年|那天|记得|后来|如今，|回忆/ },
  { cat: '散文', re: /像|仿佛|黄昏|月光|风|雨|记忆|远方的/ },
];

function slugify(s) {
  return (
    String(s || '作品')
      .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
      .slice(0, 24) || '作品'
  );
}

export function classifyPiece(title, text) {
  const t = String(text || '');
  const head = t.slice(0, 1200);
  for (const { cat, re } of CLASSIFY_RULES) {
    if (re.test(`${title} ${head}`)) return cat;
  }
  return '其他';
}

export function libraryDirs(workspace) {
  return {
    root: path.join(workspace, 'vault', 'library'),
    skills: path.join(workspace, 'vault', 'skills', 'personal'),
    index: path.join(workspace, 'vault', 'library', 'index.json'),
  };
}

export function ensureLibrary(workspace) {
  const d = libraryDirs(workspace);
  fs.mkdirSync(d.root, { recursive: true });
  fs.mkdirSync(d.skills, { recursive: true });
  if (!fs.existsSync(d.index)) {
    ws.writeJson(d.index, { schemaVersion: '0.1', pieces: [], distilled: {} });
  }
  return d;
}

function readIndex(workspace) {
  ensureLibrary(workspace);
  return ws.readJson(libraryDirs(workspace).index);
}

/** 归档一篇作品：自动分类，落盘 vault/library/<类别>/，记录索引。 */
export function addPiece(
  workspace,
  { title = '', text = '', source = '', category = '', session = '' },
) {
  const body = String(text || '').trim();
  if (body.length < 40) throw new Error('作品太短（<40 字），不归档');
  const d = ensureLibrary(workspace);
  const cat = category || classifyPiece(title, body);
  const dir = path.join(d.root, cat);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slugify(title)}.md`);
  const header = [
    `# ${title || '未命名作品'}`,
    `- 分类: ${cat}`,
    `- 归档时间: ${ws.nowIso()}`,
    session ? `- session: ${session}` : '',
    source ? `- 来源: ${source}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(file, header + body + '\n');
  const index = readIndex(workspace);
  index.pieces.push({
    file: path.relative(d.root, file),
    title: title || '',
    category: cat,
    ts: ws.nowIso(),
    session: session || '',
    source: source || '',
  });
  ws.writeJson(d.index, index);
  return { file, category: cat };
}

/** 一键归档 draft.md（导演交付时自动调用）。 */
export function archiveDraft(workspace, state) {
  const draft = path.join(workspace, 'draft.md');
  if (!fs.existsSync(draft)) return null;
  const text = fs.readFileSync(draft, 'utf8').replace(/^## .*\n/g, '');
  const title = state?.confirmed?.topic || state?.outline?.title || '未命名作品';
  try {
    const r = addPiece(workspace, {
      title,
      text,
      source: 'draft.md',
      session: state?.projectId || path.basename(workspace),
    });
    return r;
  } catch {
    return null;
  }
}

const DISTILL_PROMPT = (
  category,
  pieces,
) => `你是写作方法分析师。下面是一位作者写的「${category}」类作品片段，请蒸馏出"这一类文体，这位作者自己的写法"：

要求（输出严格 JSON，全部用中文，总长不超过 450 字）：
1. structure：他这类文章通常怎么开头、怎么推进、怎么收尾（1-2 句）。
2. voice：句长、语气、用词习惯、常用表达（2-3 句）。
3. devices：他惯用的手法（意象/举例/设问/数据/引文…）。
4. pitfalls：他容易滑向什么（如空泛抒情/堆排比/套话），写的时候要避免。
5. example：一句最能代表他的句子（从他的原文里摘）。

【作品片段】
${pieces}

{"structure":"","voice":"","devices":"","pitfalls":"","example":""}`;

/** 蒸馏某类的个人写作 skill（LLM；失败时降级为确定性统计摘要，不阻塞）。 */
export async function distillCategory(workspace, category, cfg) {
  const d = ensureLibrary(workspace);
  const dir = path.join(d.root, category);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    files = [];
  }
  if (!files.length) return { category, distilled: false, pieces: 0 };
  const texts = files
    .slice(-4)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2500))
    .join('\n\n---\n\n');
  const out = path.join(d.skills, `${category}.md`);
  let body = '';
  if (cfg.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是写作方法分析师，输出严格 JSON。' },
          { role: 'user', content: DISTILL_PROMPT(category, texts) },
        ],
        { json: true, temperature: 0.3, maxTokens: 1200 },
      );
      const r = JSON.parse(
        content
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim(),
      );
      body = [
        `# 个人写作 skill · ${category}`,
        `> 蒸馏自 ${files.length} 篇作品（${ws.nowIso()}）`,
        '',
        `## 结构\n${r.structure || ''}`,
        '',
        `## 语气\n${r.voice || ''}`,
        '',
        `## 惯用手法\n${r.devices || ''}`,
        '',
        `## 要避开的坑\n${r.pitfalls || ''}`,
        '',
        `## 代表句\n> ${r.example || ''}`,
        '',
      ].join('\n');
    } catch {
      body = fallbackDistill(category, files.length, texts);
    }
  } else {
    body = fallbackDistill(category, files.length, texts);
  }
  fs.writeFileSync(out, body + '\n');
  const index = readIndex(workspace);
  index.distilled[category] = {
    at: ws.nowIso(),
    pieces: files.length,
    file: path.relative(d.skills, out),
  };
  ws.writeJson(d.index, index);
  return { category, distilled: true, pieces: files.length };
}

function fallbackDistill(category, count, texts) {
  const all = texts.replace(/^#.*$/gm, '').trim();
  return [
    `# 个人写作 skill · ${category}`,
    `> 蒸馏自 ${count} 篇作品（确定性兜底，${ws.nowIso()}）`,
    '',
    `## 结构\n按 ${category} 文体的常规骨架展开，具体见正文。`,
    '',
    `## 语气\n句长 ${all.length > 0 ? '见样本统计' : '未知'}；用词倾向见样本原文。`,
    '',
    `## 惯用手法\n见样本原文（vault/library/${category}/）。`,
    '',
    `## 要避开的坑\n避免 AI 套话与空泛堆砌（见 anti-ai 清单）。`,
    '',
  ].join('\n');
}

/** 蒸馏所有有作品的类别。 */
export async function distillAll(workspace, cfg) {
  const d = ensureLibrary(workspace);
  const cats = fs
    .readdirSync(d.root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const results = [];
  for (const c of cats) results.push(await distillCategory(workspace, c, cfg));
  return results;
}

/** 按类别读取蒸馏后的个人 skill，限量返回（不污染上下文）。 */
export function loadPersonalSkill(workspace, { category = '', limit = 500 } = {}) {
  if (!category) return '';
  const d = ensureLibrary(workspace);
  const file = path.join(d.skills, `${category}.md`);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '';
  }
}

export function listLibrary(workspace) {
  const index = readIndex(workspace);
  const byCat = {};
  for (const p of index.pieces) byCat[p.category] = (byCat[p.category] || 0) + 1;
  const lines = ['个人写作库:'];
  if (!index.pieces.length)
    lines.push('  （空）— 写作完成后自动归档，或 sculptor library add <file>');
  for (const [cat, n] of Object.entries(byCat).sort()) {
    const distilled = index.distilled?.[cat] ? '✓ 已蒸馏' : '（未蒸馏）';
    lines.push(`  · ${cat}：${n} 篇 ${distilled}`);
  }
  const distilled = Object.values(index.distilled || {}).length;
  lines.push(`蒸馏 skill: ${distilled} 份 → vault/skills/personal/`);
  return lines.join('\n');
}

export function viewCategory(workspace, category) {
  const d = ensureLibrary(workspace);
  const skill = path.join(d.skills, `${category}.md`);
  const pieces = path.join(d.root, category);
  const out = [];
  if (fs.existsSync(skill)) out.push(fs.readFileSync(skill, 'utf8').trim());
  else out.push(`（${category} 还没有蒸馏 skill，先运行 sculptor library scan）`);
  try {
    const files = fs.readdirSync(pieces).filter((f) => f.endsWith('.md'));
    if (files.length) {
      out.push('', `作品清单（${files.length} 篇）:`);
      for (const f of files.slice(-10)) out.push(`  · ${f}`);
    }
  } catch {}
  return out.join('\n');
}
