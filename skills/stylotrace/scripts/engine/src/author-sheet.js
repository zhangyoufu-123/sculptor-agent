// 作者写作清单（Author Writing Sheet · v0.66）——L3 深层风格读取协议。
//
// 理论依据：小语料下深层风格（立场、论证习惯、读者意识、红线、触发）不能靠统计读取，
// 必须把"澄清/外溢/修改"中已经确认的信号结构化（借鉴 Author Writing Sheet 访谈式读取，
// arXiv:2502.13028）。五问：
//   1 主张与立场  2 论证与推理  3 读者意识  4 红线与边界  5 触发与参照
//
// 数据源（全部来自作者已确认信号，不虚构）：
//   state.theme/stance/audience/arguments/constraints/seeds + state.thinking（思想脉络）
//   + read-style.json（结构层读者相关维度）
//
// 归纳：LLM 优先（结构化 JSON 输出），失败时确定性兜底；红线在两种路径下都强制完整保留；
// 落盘 vault/author-sheet.json，签名变化自动重算。调制器把它作为第 10 维 fineRead 特征。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ws from './workspace.js';
import { thinkingBrief } from './thinking.js';
import { chatWithRetry, parseJsonContent } from './llm.js';

const SHEET_FILE = 'author-sheet.json';

export const FIVE_QUESTIONS = [
  { id: 'stance', label: '主张与立场', hint: '这篇要让读者相信/感觉到什么？' },
  { id: 'argumentation', label: '论证与推理', hint: '心里有没有一条现成推理线/一本书可顺着想？' },
  { id: 'reader', label: '读者意识', hint: '最怕读者怎么想？希望谁看到、谁沉默？' },
  { id: 'redLines', label: '红线与边界', hint: '哪句话/哪个词定死了不许改？' },
  { id: 'triggers', label: '触发与参照', hint: '是哪部作品/哪个画面让你现在想写？' },
];

export function sheetFile(workspace) {
  return path.join(workspace, 'vault', SHEET_FILE);
}

/** 关键字段汇总签名：任何澄清/外溢/红线变化都会触发重算。 */
export function stateSignature(state) {
  const h = crypto.createHash('sha1');
  const pick = [
    state.theme,
    state.stance,
    state.audience,
    JSON.stringify(state.arguments || []),
    JSON.stringify(state.constraints || []),
    JSON.stringify((state.seeds || []).map((s) => `${s.type}:${s.text}:${s.confirmed ? 1 : 0}`)),
    JSON.stringify((state.thinking || []).map((t) => `${t.claim}|${t.source}`)),
  ].join('\u0001');
  h.update(pick);
  return h.digest('hex').slice(0, 16);
}

function clean(t) {
  return String(t || '').trim();
}

/** 确定性关键词：书名《》、红线原词、种子文本、论点前导词（2–6 字实词片段）。 */
export function extractKeywords(...texts) {
  const out = new Set();
  const push = (s) => {
    const k = clean(s).replace(/[「」“”『』《》【】。，、！？：；,.!?:;'"“”]/g, '').trim();
    if (k.length >= 2 && k.length <= 20) out.add(k);
  };
  for (const t of texts) {
    const s = clean(t);
    if (!s) continue;
    const books = s.matchAll(/《([^》]{2,24})》/g);
    for (const m of books) push(m[1]);
    if (s.length <= 20) push(s);
    else {
      // 长文本取前 12 字与含"根本/本质/关键"的片段
      push(s.slice(0, 12));
      for (const frag of s.match(/[^，。；]{0,8}(根本|本质|关键|问题在于|最重要的是)[^，。；]{0,10}/g) || []) push(frag);
    }
  }
  return [...out].slice(0, 24);
}

/** 红线拆句：引号内短句优先（逐字匹配长句必然失败），无引号保留原句。 */
export function redLineFragments(lines) {
  const out = [];
  for (const raw of lines) {
    const l = clean(raw);
    if (!l) continue;
    const quoted = [...l.matchAll(/[「"“']([^」"”']{2,20})[」"”']/g)];
    if (quoted.length) {
      for (const m of quoted) out.push(m[1]);
    } else {
      out.push(l);
    }
  }
  return [...new Set(out)];
}

/** 确定性兜底：直接从已确认信号归纳五问（无 LLM 也可用）。 */
export function sheetFromState(workspace) {
  const state = ws.readState(workspace) || {};
  const read = (() => {
    try {
      return ws.readJson(path.join(workspace, 'vault', 'read-style.json')) || {};
    } catch {
      return {};
    }
  })();
  const arguments_ = Array.isArray(state.arguments) ? state.arguments : [];
  const constraints = Array.isArray(state.constraints) ? state.constraints : [];
  const seeds = Array.isArray(state.seeds) ? state.seeds : [];
  const thinking = Array.isArray(state.thinking) ? state.thinking : [];
  const triggerTexts = seeds
    .filter((s) => ['reference', 'work', 'video', 'podcast', 'author'].includes(s.type))
    .map((s) => s.text);
  const sheet = {
    ok: true,
    mode: 'deterministic',
    stance: clean(state.theme || state.stance || ''),
    argumentation: [
      ...arguments_,
      ...thinking.filter((t) => t.claim).map((t) => t.claim),
    ].filter(Boolean),
    reader: clean(state.audience || read.reader || ''),
    redLines: [...new Set(constraints.map(clean).filter(Boolean))],
    redLineFragments: redLineFragments(constraints),
    triggers: [...new Set(triggerTexts.map(clean).filter(Boolean))],
    keywords: extractKeywords(
      state.theme,
      state.stance,
      ...arguments_,
      ...constraints,
      ...triggerTexts,
      ...thinking.map((t) => `${t.claim || ''} ${t.source || ''}`),
    ),
    summary: thinkingBrief(state),
    signature: stateSignature(state),
    updatedAt: new Date().toISOString(),
  };
  const empty =
    !sheet.stance &&
    !sheet.argumentation.length &&
    !sheet.reader &&
    !sheet.redLines.length &&
    !sheet.triggers.length &&
    !sheet.keywords.length;
  return empty ? { ok: false, reason: '无作者信号' } : sheet;
}

/** 同步读取（无落盘文件时用确定性归纳，不写盘）。 */
export function readAuthorSheet(workspace) {
  try {
    const s = JSON.parse(fs.readFileSync(sheetFile(workspace), 'utf8'));
    if (s?.ok) return s;
  } catch {}
  return sheetFromState(workspace);
}

function writeSheet(workspace, sheet) {
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(sheetFile(workspace), JSON.stringify(sheet, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

function mergeSheet(base, llmSheet) {
  const pick = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : clean(v) ? [clean(v)] : []);
  const arg = [...new Set([...pick(base.argumentation), ...pick(llmSheet.argumentation)])];
  const kw = [...new Set([...pick(base.keywords), ...pick(llmSheet.keywords)])];
  return {
    ok: true,
    mode: 'llm+deterministic',
    stance: clean(llmSheet.stance || base.stance),
    argumentation: arg,
    reader: clean(llmSheet.reader || base.reader),
    // 红线强制完整保留：LLM 归纳可能丢词，必须以确定性基线为准
    redLines: [...new Set([...base.redLines, ...pick(llmSheet.redLines)])],
    redLineFragments: [...new Set([...base.redLineFragments, ...redLineFragments(pick(llmSheet.redLines))])],
    triggers: [...new Set([...base.triggers, ...pick(llmSheet.triggers)])],
    keywords: [...new Set([...kw, ...base.redLines, ...base.triggers])].slice(0, 32),
    summary: clean(llmSheet.summary || base.summary),
    signature: base.signature,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * LLM 优先归纳作者写作清单（可注入 llm 便于测试）；失败走确定性兜底。
 * 签名不变且非 force 时直接复用落盘结果。
 */
export async function extractAuthorSheet(cfg = {}, workspace, { force = false, llm = null } = {}) {
  const base = sheetFromState(workspace);
  if (!force) {
    try {
      const existing = JSON.parse(fs.readFileSync(sheetFile(workspace), 'utf8'));
      if (existing?.ok && existing.signature === base.signature) return existing;
    } catch {}
  }
  const brief = [
    `核心立意：${base.stance || '（未定）'}`,
    `支撑论点：${base.argumentation.length ? base.argumentation.join('；') : '（未定）'}`,
    `读者：${base.reader || '（未定）'}`,
    `红线：${base.redLines.length ? base.redLines.join('；') : '（无）'}`,
    `触发/参照：${base.triggers.length ? base.triggers.join('；') : '（无）'}`,
    `思想脉络：${base.summary || '（无）'}`,
  ].join('\n');
  const system =
    '你是作者写作清单归纳器。根据作者的已确认信号，输出严格 JSON：' +
    '{"stance":"一句话立场","argumentation":["推理线1"],"reader":"读者意识","redLines":["红线"],"triggers":["触发参照"],"keywords":["风格关键词"],"summary":"整体风格摘要"}。' +
    '只归纳已有信号，不虚构；红线必须逐字保留。';
  try {
    const gen = llm || ((msgs, opts) => chatWithRetry(cfg, msgs, opts));
    const content = await gen(
      [
        { role: 'system', content: system },
        { role: 'user', content: `【作者已确认信号】\n${brief}` },
      ],
      { temperature: 0.2, maxTokens: 1200 },
    );
    const parsed = parseJsonContent(String(content || ''));
    if (parsed && typeof parsed === 'object') {
      const sheet = mergeSheet(base, parsed);
      writeSheet(workspace, sheet);
      return sheet;
    }
  } catch {}
  writeSheet(workspace, { ...base, mode: 'deterministic', updatedAt: new Date().toISOString() });
  return base;
}
