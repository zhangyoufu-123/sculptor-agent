// v0.56 文档互通管线（Document Interop Pipeline）
// 目标：全流程每个环节都可以"文件进、文件出"，并与其他产品（Word/其他 Agent/MCP 客户端）衔接。
// 原则（调研自行业最佳实践）：
//  1) 以 Markdown 为规范中间表示（canonical IR）：docx/pdf/xlsx/md/txt → md → 阶段处理 → md → docx/pdf/md；
//  2) LLM 优先：翻译/重写以"原意解读/风格底稿"为前置上下文，结构（标题/列表/表格）在 IR 中保留；
//  3) 确定性兜底：无密钥时导出 md 并提示；docx 导出依赖本机 python-docx（可选 pandoc reference-doc 路径见 docs/INTEROP.md）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { extractInput, exportDocx, docxAvailable, exportHtml } from './io.js';
import { roundtripCheck } from './roundtrip.js';
import { buildStyleShot } from './style-memory.js';
import * as ws from './workspace.js';

const IO_SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'io');

export const DOC_TRANSLATE_PROMPT = (ctx) => `你是"先懂后译"的文档翻译官。下面是一篇待翻译的文档（Markdown 表示，标题/列表/表格结构必须原样保留）。

【源文（Markdown）】
${String(ctx.text || '').slice(0, 12000)}

目标语言：${ctx.lang || 'en'}

步骤：
1. 先做原意解读：intent（作者想表达什么）/ tone（语气）/ genre（文体）/ keyImagery（关键意象）/ pitfalls（易损点：双关、文化词、专名）；
2. 逐块翻译，**保留全部 Markdown 结构**（# 标题、- 列表、| 表格、引用块、代码块标记），只翻译内容文本；
3. 达意优先于逐字：字面对不上的地方以原意为准；专名首次出现可保留原文并加注。

输出严格 JSON：
{"interpretation":{"intent":"","tone":"","genre":"","keyImagery":[],"pitfalls":[]},"translated":"整篇译文（Markdown）"}`;

export const DOCX_BLOCK_TRANSLATE_PROMPT = (ctx) => `你是"先懂后译"的文档翻译官。下面是一批文本块，每块用 [[ID]] 标记。

目标语言：${ctx.lang || 'en'}

要求：逐块翻译，**块数、ID 与顺序必须一一对应，不要合并、拆分或跳过任何块**；只翻译内容文本，块内可能出现的 Markdown 结构符号原样保留。

【待译块】
${ctx.batch}

输出严格 JSON：
{"blocks":[{"id":"B0","text":"该块译文"}]}`;

export const DOCX_BLOCK_RESTYLE_PROMPT = (ctx) => `你是写作风格执行器。下面是一批文本块，每块用 [[ID]] 标记；按指定风格底稿逐块重写。

【风格底稿】
${ctx.style || '（默认克制写法：短句、具体细节、克制抒情）'}

要求：块数、ID 与顺序一一对应，不要合并/拆分/跳过；不改事实与结构符号。

【待重写块】
${ctx.batch}

输出严格 JSON：
{"blocks":[{"id":"B0","text":"该块重写结果"}]}`;

export const DOC_RESTYLE_PROMPT = (ctx) => `你是写作风格执行器：把一篇已有文档，按指定作者的风格底稿重写（保留结构与全部信息点，不增删事实）。

【风格底稿】
${ctx.style || '（未提供，使用默认克制写法：短句、具体细节、克制抒情）'}

【原文（Markdown）】
${String(ctx.text || '').slice(0, 12000)}

要求：保留 Markdown 结构（标题/列表/表格/引用）；按风格底稿重写语言（用词、句长、节奏、修辞）；不改事实与结构；输出整篇重写结果。

输出严格 JSON：
{"summary":"一句说明这次风格重写做了什么","rewritten":"整篇重写结果（Markdown）"}`;

function writePair(outBase, mdText, html = false) {
  const files = [];
  const mdFile = `${outBase}.md`;
  fs.writeFileSync(mdFile, mdText, 'utf8');
  files.push(mdFile);
  try {
    if (docxAvailable()) {
      const docxFile = `${outBase}.docx`;
      exportDocx(mdText, docxFile);
      files.push(docxFile);
    }
  } catch {}
  if (html) {
    try {
      const htmlFile = `${outBase}.html`;
      exportHtml(mdText, htmlFile);
      files.push(htmlFile);
    } catch {}
  }
  return files;
}

function runPy(args) {
  return execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function extractDocxBlocks(file) {
  const out = runPy([path.join(IO_SCRIPTS, 'docx_blocks.py'), 'extract', path.resolve(String(file))]);
  return JSON.parse(out).blocks || [];
}

function applyDocxBlocks(src, replacements, out) {
  const replFile = `${out}.repl.json`;
  fs.writeFileSync(replFile, JSON.stringify(replacements), 'utf8');
  try {
    const res = runPy([path.join(IO_SCRIPTS, 'docx_blocks.py'), 'apply', path.resolve(String(src)), replFile, path.resolve(String(out))]);
    return JSON.parse(res);
  } finally {
    try { fs.unlinkSync(replFile); } catch {}
  }
}

async function extract(cfg, file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new Error(`找不到文件: ${abs}`);
  const r = await extractInput(abs, cfg);
  if (r.kind !== 'text') throw new Error(`无法读取 ${abs}：${r.hint || r.kind}`);
  return r.text;
}

async function llmBlocks(cfg, promptFn, blocks, { batch = 20, label = '块级处理' } = {}) {
  const byId = new Map();
  const missing = [];
  for (let i = 0; i < blocks.length; i += batch) {
    const part = blocks.slice(i, i + batch);
    const batchText = part.map((b) => `[[${b.id}]]\n${b.text}`).join('\n\n');
    let parsed = null;
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: `你是文档${label}执行器，输出严格 JSON。` },
          { role: 'user', content: promptFn(batchText) },
        ],
        { json: true, temperature: 0.3, maxTokens: 6000 },
      );
      parsed = parseJsonContent(content, label);
    } catch {}
    const got = new Map((parsed?.blocks || []).filter((b) => b && b.id).map((b) => [b.id, String(b.text ?? '')]));
    for (const b of part) {
      if (got.has(b.id) && got.get(b.id)) {
        byId.set(b.id, got.get(b.id));
      } else {
        // 单块重试一次；仍失败则保留原文并记录
        let ok = false;
        try {
          const one = await chatWithRetry(
            cfg,
            [
              { role: 'system', content: `你是文档${label}执行器，输出严格 JSON。` },
              { role: 'user', content: promptFn(`[[${b.id}]]\n${b.text}`) },
            ],
            { json: true, temperature: 0.3, maxTokens: 2000 },
          );
          const r1 = parseJsonContent(one, label);
          const hit = (r1.blocks || []).find((x) => x && x.id === b.id);
          if (hit && hit.text) { byId.set(b.id, String(hit.text)); ok = true; }
        } catch {}
        if (!ok) missing.push(b.id);
      }
    }
  }
  return { byId, missing };
}

async function docxBlockPipeline(cfg, workspace, { file, lang = '', style = '', out = '', stage = 'translate', verify = true } = {}) {
  const blocks = extractDocxBlocks(file);
  const base = out ? String(out).replace(/\.(md|docx|html)$/i, '') : `${String(file).replace(/\.\w+$/, '')}.${stage === 'translate' ? lang : 'restyled'}`;
  const report = { file, stage, mode: 'docx-block', ts: ws.nowIso(), ok: false, files: [], blocks: blocks.length };
  const promptFn = stage === 'translate'
    ? (batch) => DOCX_BLOCK_TRANSLATE_PROMPT({ lang, batch })
    : (batch) => DOCX_BLOCK_RESTYLE_PROMPT({ style: style || '', batch });
  const { byId, missing } = await llmBlocks(cfg, promptFn, blocks, { label: stage === 'translate' ? '翻译' : '风格重写' });
  const replacements = { blocks: blocks.map((b) => ({ id: b.id, text: byId.has(b.id) ? byId.get(b.id) : b.text })) };
  const docxOut = `${base}.docx`;
  const applied = applyDocxBlocks(file, replacements, docxOut);
  const mdText = blocks.map((b) => byId.has(b.id) ? byId.get(b.id) : b.text).join('\n\n');
  const mdOut = `${base}.md`;
  fs.writeFileSync(mdOut, mdText, 'utf8');
  report.files = [docxOut, mdOut];
  report.ok = applied.applied > 0;
  report.replaced = applied.applied;
  report.missing = missing;
  if (stage === 'translate' && verify && cfg.apiKey) {
    try {
      const rt = await roundtripCheck(cfg, workspace, { text: mdText.slice(0, 1200) });
      report.roundtrip = { kept: rt.content.kept.length, lost: rt.content.lost.length, drifted: rt.content.drifted.length, hint: rt.content.hint || '' };
    } catch {}
  }
  return report;
}

/**
 * 文档翻译：docx/md/txt → 原意解读 + 结构保留翻译 → md/docx 导出（可选回译校验报告）。
 * @param file 输入文档（docx/md/txt/xlsx 等，走 io.extractInput）
 * @param lang 目标语言，如 en / ja / zh
 * @param out 输出路径（无扩展名或 .md/.docx）；缺省 <原文件名>.<lang>
 * @param verify 是否对译文做回译校验（默认 true，有密钥时）
 */
export async function docTranslate(cfg, workspace, { file, lang = 'en', out = '', verify = true } = {}) {
  if (/\.docx$/i.test(String(file)) && docxAvailable() && cfg.apiKey) {
    return docxBlockPipeline(cfg, workspace, { file, lang, out, stage: 'translate', verify });
  }
  const text = await extract(cfg, file);
  const base = out ? String(out).replace(/\.(md|docx|html)$/i, '') : `${String(file).replace(/\.\w+$/, '')}.${lang}`;
  const report = { file, lang, stage: 'translate', ts: ws.nowIso(), ok: false, files: [] };
  if (!cfg.apiKey) {
    report.reason = '未配置 LLM 密钥：已导出原文 md，可配置密钥后重跑';
    report.files = writePair(base, text);
    return report;
  }
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是文档翻译官，输出严格 JSON。' },
        { role: 'user', content: DOC_TRANSLATE_PROMPT({ text, lang }) },
      ],
      { json: true, temperature: 0.3, maxTokens: 8000 },
    );
    const r = parseJsonContent(content, '文档翻译');
    const translated = String(r.translated || '');
    report.interpretation = r.interpretation || {};
    report.ok = translated.length > 0;
    report.files = writePair(base, translated, true);
    if (verify && cfg.apiKey && translated.length) {
      try {
        const sample = translated.slice(0, 1200);
        const rt = await roundtripCheck(cfg, workspace, { text: sample });
        report.roundtrip = {
          verdict: rt.verdict,
          kept: rt.content.kept.length,
          lost: rt.content.lost.length,
          drifted: rt.content.drifted.length,
          hint: rt.content.hint || '',
        };
      } catch {
        report.roundtrip = { skipped: true, reason: '回译校验失败（静默跳过）' };
      }
    }
    return report;
  } catch (e) {
    report.reason = String(e?.message || e).slice(0, 160);
    report.files = writePair(base, text);
    return report;
  }
}

/**
 * 文档风格重写：把一篇成品文档按作者风格重写（结构保留）。
 * @param style 风格来源：文件路径（旧稿）或方向描述（如"更克制、短句、留白"）；
 *              缺省读取工作区风格档案。
 */
export async function docRestyle(cfg, workspace, { file, style = '', out = '' } = {}) {
  if (/\.docx$/i.test(String(file)) && docxAvailable() && cfg.apiKey) {
    return docxBlockPipeline(cfg, workspace, { file, style, out, stage: 'restyle' });
  }
  const text = await extract(cfg, file);
  const base = out ? String(out).replace(/\.(md|docx|html)$/i, '') : `${String(file).replace(/\.\w+$/, '')}.restyled`;
  const report = { file, stage: 'restyle', ts: ws.nowIso(), ok: false, files: [] };
  let styleCtx = style;
  if (!styleCtx && fs.existsSync(path.join(workspace, 'vault', 'write-style.json'))) {
    try {
      const shot = buildStyleShot(workspace);
      styleCtx = shot?.styleDirections?.join('；') || '';
    } catch {}
  }
  report.styleSource = styleCtx ? (style ? '用户指定' : '工作区风格档案') : '默认';
  if (!cfg.apiKey) {
    report.reason = '未配置 LLM 密钥：已导出原文 md，可配置密钥后重跑';
    report.files = writePair(base, text);
    return report;
  }
  try {
    const content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是写作风格执行器，输出严格 JSON。' },
        { role: 'user', content: DOC_RESTYLE_PROMPT({ text, style: styleCtx }) },
      ],
      { json: true, temperature: 0.5, maxTokens: 8000 },
    );
    const r = parseJsonContent(content, '文档风格重写');
    const rewritten = String(r.rewritten || '');
    report.summary = String(r.summary || '');
    report.ok = rewritten.length > 0;
    report.files = writePair(base, rewritten, true);
    return report;
  } catch (e) {
    report.reason = String(e?.message || e).slice(0, 160);
    report.files = writePair(base, text);
    return report;
  }
}

export function renderDocReport(r) {
  const lines = [
    `# 文档${r.stage === 'translate' ? '翻译' : '风格重写'}报告`,
    '',
    `- 输入：${r.file}`,
    `- 状态：${r.ok ? '成功' : '未完成'}`,
  ];
  if (r.mode === 'docx-block') {
    lines.push(`- 模式：docx 块级回填（run 级格式保留）｜块数 ${r.blocks ?? '—'}｜替换 ${r.replaced ?? '—'}${r.missing?.length ? `｜未覆盖 ${r.missing.length} 块（保留原文）` : ''}`);
  }
  if (r.lang) lines.push(`- 目标语言：${r.lang}`);
  if (r.interpretation) {
    const it = r.interpretation;
    lines.push(`- 原意解读：意图「${it.intent || ''}」｜语气「${it.tone || ''}」｜文体「${it.genre || ''}」｜易损点「${(it.pitfalls || []).join('、')}」`);
  }
  if (r.summary) lines.push(`- 重写说明：${r.summary}`);
  if (r.roundtrip) {
    lines.push(`- 回译校验：保留 ${r.roundtrip.kept ?? '—'} / 丢失 ${r.roundtrip.lost ?? '—'} / 漂移 ${r.roundtrip.drifted ?? '—'}${r.roundtrip.hint ? '｜' + r.roundtrip.hint : ''}`);
  }
  if (r.reason) lines.push(`- 提示：${r.reason}`);
  lines.push(`- 产物：${(r.files || []).join('、') || '（无）'}`, '');
  return lines.join('\n');
}
