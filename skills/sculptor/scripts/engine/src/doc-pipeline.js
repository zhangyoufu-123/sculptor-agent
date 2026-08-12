// v0.56 文档互通管线（Document Interop Pipeline）
// 目标：全流程每个环节都可以"文件进、文件出"，并与其他产品（Word/其他 Agent/MCP 客户端）衔接。
// 原则（调研自行业最佳实践）：
//  1) 以 Markdown 为规范中间表示（canonical IR）：docx/pdf/xlsx/md/txt → md → 阶段处理 → md → docx/pdf/md；
//  2) LLM 优先：翻译/重写以"原意解读/风格底稿"为前置上下文，结构（标题/列表/表格）在 IR 中保留；
//  3) 确定性兜底：无密钥时导出 md 并提示；docx 导出依赖本机 python-docx（可选 pandoc reference-doc 路径见 docs/INTEROP.md）。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { extractInput, exportDocx, docxAvailable, exportHtml, exportPdf } from './io.js';
import { roundtripCheck } from './roundtrip.js';
import { buildStyleShot } from './style-memory.js';
import * as ws from './workspace.js';

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

async function extract(cfg, file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new Error(`找不到文件: ${abs}`);
  const r = await extractInput(abs, cfg);
  if (r.kind !== 'text') throw new Error(`无法读取 ${abs}：${r.hint || r.kind}`);
  return r.text;
}

/**
 * 文档翻译：docx/md/txt → 原意解读 + 结构保留翻译 → md/docx 导出（可选回译校验报告）。
 * @param file 输入文档（docx/md/txt/xlsx 等，走 io.extractInput）
 * @param lang 目标语言，如 en / ja / zh
 * @param out 输出路径（无扩展名或 .md/.docx）；缺省 <原文件名>.<lang>
 * @param verify 是否对译文做回译校验（默认 true，有密钥时）
 */
export async function docTranslate(cfg, workspace, { file, lang = 'en', out = '', verify = true } = {}) {
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
