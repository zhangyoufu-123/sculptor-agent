// 多模态输入输出：docx / xlsx / md / txt / 图片 / 音频 → 文本；draft → docx / html / pdf / srt。
// 依赖本机 Python（python-docx 用于 docx；xlsx 用 zipfile+ElementTree 零第三方解析）；
// 图片识别走视觉模型（SCULPTOR_VISION_MODEL），音频转录走 whisper（SCULPTOR_WHISPER_CMD），
// 未配置时给出明确降级提示。所有外部进程带超时，绝不阻塞主流程。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IO_SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'io',
);
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const AUDIO_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
};

function runPy(args) {
  return execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function pythonAvailable() {
  try {
    runPy(['-c', 'import sys; print(sys.version.split()[0])']);
    return true;
  } catch {
    return false;
  }
}

export function docxAvailable() {
  try {
    runPy(['-c', 'import docx; print(1)']);
    return true;
  } catch {
    return false;
  }
}

export function pdfAvailable() {
  try {
    runPy(['-c', 'import reportlab; print(1)']);
    return true;
  } catch {
    return false;
  }
}

/** 检测可用的 whisper 转录命令：环境变量优先，其次 PATH 里的 whisper / whisper-cli / whisper.cpp main。 */
export function detectWhisper(cfg = {}) {
  if (cfg.whisperCmd) return String(cfg.whisperCmd);
  for (const bin of ['whisper', 'whisper-cli', 'main']) {
    try {
      const found = execFileSync('which', [bin], { encoding: 'utf8', timeout: 5000 }).trim();
      if (found) return found;
    } catch {}
  }
  return '';
}

/**
 * 音频转录：运行 whisper 类命令（stdout 输出转写文本）。
 * 约定：SCULPTOR_WHISPER_CMD 可含 <file> 占位符，否则把音频路径追加为最后一个参数。
 */
export function transcribeAudio(file, cfg = {}) {
  const cmd = detectWhisper(cfg);
  if (!cmd) {
    return {
      ok: false,
      hint:
        '未检测到 whisper/whisper.cpp，无法自动转录。可安装 whisper.cpp 后设置 SCULPTOR_WHISPER_CMD（命令须把转写文本输出到 stdout）；或先用 macOS 听写/录音转文字，另存为 .md/.txt 提供。',
    };
  }
  const hasPlaceholder = cmd.includes('<file>');
  const cmdLine = hasPlaceholder ? cmd.replaceAll('<file>', file) : `${cmd} ${JSON.stringify(file)}`;
  const parts = cmdLine.split(/\s+/);
  const bin = parts.shift();
  const args = parts.filter(Boolean);
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: cfg.whisperTimeoutMs || 300000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (!out) {
      return { ok: false, hint: 'whisper 转录返回空文本（命令可能不支持 stdout 输出，请确认 SCULPTOR_WHISPER_CMD 会打印转写内容）' };
    }
    return { ok: true, text: out, source: 'voice' };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 160);
    const timedOut = /ETIMEDOUT|timeout/i.test(msg);
    return {
      ok: false,
      hint: `whisper 转录失败${timedOut ? '（超时）' : ''}：${msg}。可先手动转写为 .md/.txt。`,
    };
  }
}

async function visionDescribe(file, cfg) {
  const model = cfg.visionModel || '';
  if (!model) {
    return {
      ok: false,
      hint: '未配置视觉模型（SCULPTOR_VISION_MODEL）。图片无法自动识别——你可以先描述图片内容（画面/文字/氛围），我照样能写进文章。',
    };
  }
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext] || 'image/png';
  const b64 = fs.readFileSync(file).toString('base64');
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '这是一张用户提供的图片。请用中文详细描述：画面里的内容、出现的文字、氛围，以及可以直接写进文章的具体细节（300 字内，只描述，不评价）。',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    max_tokens: 800,
    temperature: 0.3,
  };
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`视觉 API ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('视觉模型返回空');
    return { ok: true, text: String(text).trim(), source: 'vision' };
  } catch (err) {
    return {
      ok: false,
      hint: `视觉识别失败：${err.message.slice(0, 120)}。可先自行描述图片内容。`,
    };
  }
}

/**
 * 把用户提供的文件提取为可写作的文本（异步：图片走视觉模型、音频走 whisper）。
 * @returns {kind:'text'|'image'|'unsupported', text?, hint?, source?}
 */
export async function extractInput(file, cfg = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { kind: 'unsupported', hint: `文件不存在: ${abs}` };
  const ext = path.extname(abs).toLowerCase();
  if (['.md', '.txt', '.markdown'].includes(ext)) {
    return { kind: 'text', text: fs.readFileSync(abs, 'utf8'), source: ext.slice(1) };
  }
  if (ext === '.docx') {
    if (!docxAvailable())
      return {
        kind: 'unsupported',
        hint: '本机没有 python-docx，无法读取 docx。请另存为 .md/.txt。',
      };
    try {
      return {
        kind: 'text',
        text: runPy([path.join(IO_SCRIPTS, 'extract.py'), 'docx', abs]),
        source: 'docx',
      };
    } catch (err) {
      return { kind: 'unsupported', hint: `docx 解析失败：${err.message.slice(0, 120)}` };
    }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    if (!pythonAvailable())
      return {
        kind: 'unsupported',
        hint: '本机没有 python3，无法读取 xlsx。请另存为 .md/.txt/csv。',
      };
    try {
      return {
        kind: 'text',
        text: runPy([path.join(IO_SCRIPTS, 'extract.py'), 'xlsx', abs]),
        source: 'xlsx',
      };
    } catch (err) {
      return { kind: 'unsupported', hint: `xlsx 解析失败：${err.message.slice(0, 120)}` };
    }
  }
  if (IMAGE_MIME[ext]) return visionDescribe(abs, cfg);
  if (AUDIO_EXT[ext]) return transcribeAudio(abs, cfg);
  if (ext === '.pdf') {
    return {
      kind: 'unsupported',
      hint: 'PDF 暂不支持自动提取（本机无 pdftotext/pdfplumber）。请另存为 .md/.txt，或用视觉模型把关键页转成图片给我。',
    };
  }
  return {
    kind: 'unsupported',
    hint: `暂不支持 ${ext} 文件。支持：md / txt / docx / xlsx / 图片。`,
  };
}

/** 把 draft（markdown）导出为 docx。 */
export function exportDocx(mdText, outFile) {
  if (!docxAvailable()) throw new Error('本机没有 python-docx，无法导出 docx。可先导出 md。');
  const tmpMd = path.join(path.dirname(outFile), `.sculptor-export-${Date.now()}.md`);
  fs.writeFileSync(tmpMd, mdText);
  try {
    runPy([path.join(IO_SCRIPTS, 'write_docx.py'), tmpMd, path.resolve(outFile)]);
  } finally {
    fs.rmSync(tmpMd, { force: true });
  }
  return path.resolve(outFile);
}

/** 按 GB/T 9704-2012 公文排版导出 docx（红头文件可选；缺省自动补标题）。 */
export function exportOfficialDocx(mdText, outFile, { redhead = false, title = '' } = {}) {
  if (!docxAvailable()) throw new Error('本机没有 python-docx，无法导出公文 docx。可先导出 md。');
  const tmpMd = path.join(path.dirname(outFile), `.sculptor-official-${Date.now()}.md`);
  const hasTitle = /^#\s+.+$/m.test(mdText);
  const withTitle = !hasTitle && String(title || '').trim() ? `# ${title.trim()}\n\n${mdText}` : mdText;
  fs.writeFileSync(tmpMd, withTitle);
  try {
    const args = [path.join(IO_SCRIPTS, 'write_docx.py'), tmpMd, path.resolve(outFile), '--official'];
    if (redhead) args.push('--redhead');
    runPy(args);
  } finally {
    fs.rmSync(tmpMd, { force: true });
  }
  return path.resolve(outFile);
}

/** 按学术论文排版导出 docx（宋体小四正文、黑体标题、1.5 倍行距）。 */
export function exportAcademicDocx(mdText, outFile) {
  if (!docxAvailable()) throw new Error('本机没有 python-docx，无法导出学术 docx。可先导出 md。');
  const tmpMd = path.join(path.dirname(outFile), `.sculptor-academic-${Date.now()}.md`);
  fs.writeFileSync(tmpMd, mdText);
  try {
    runPy([path.join(IO_SCRIPTS, 'write_docx.py'), tmpMd, path.resolve(outFile), '--academic']);
  } finally {
    fs.rmSync(tmpMd, { force: true });
  }
  return path.resolve(outFile);
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMd(s) {
  return escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escLatex(s) {
  return String(s || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** markdown（含 $$…$$ 公式）→ LaTeX 论文（v0.51：数学公式等特殊格式以 LaTeX 原样输出）。 */
export function exportLatex(mdText, outFile) {
  const lines = String(mdText || '').split('\n');
  const out = [
    '\\documentclass[12pt]{article}',
    '\\usepackage[UTF8]{ctex}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\title{SCULPTOR 论文}',
    '\\begin{document}',
    '\\maketitle',
  ];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const img = t.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (img) {
      out.push(`\\begin{figure}[htbp]\\centering\\includegraphics[width=0.75\\textwidth]{${escLatex(img[2])}}\\caption{${escLatex(img[1])}}\\end{figure}`);
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = Math.min(6, h[1].length);
      out.push(`\\section*{${escLatex(h[2])}}`.replace('section', level <= 2 ? 'section' : level <= 3 ? 'subsection' : 'subsubsection'));
      continue;
    }
    if (t.startsWith('$$')) {
      out.push(t); // 数学公式原样保留
      continue;
    }
    if (t.startsWith('|')) continue; // 表格简化为注释（公式论文以文本为准）
    if (t.startsWith('**关键词')) {
      out.push(`\\noindent\\textbf{${escLatex(t)}}\\\\`);
      continue;
    }
    out.push(escLatex(t));
  }
  out.push('', '\\end{document}');
  fs.writeFileSync(outFile, out.join('\n'));
  return path.resolve(outFile);
}

/** markdown（标题/段落/引用/列表/粗斜体）→ 完整 HTML 文档（纯 Node，零依赖）。 */
export function exportHtml(mdText, outFile) {
  const lines = String(mdText || '').split('\n');
  const body = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      body.push('</ul>');
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      closeList();
      body.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (line.startsWith('> ')) {
      closeList();
      body.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (!inList) {
        body.push('<ul>');
        inList = true;
      }
      body.push(`<li>${inlineMd(line.replace(/^[-*] /, ''))}</li>`);
      continue;
    }
    closeList();
    body.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(mdText.split('\n').find((l) => l.startsWith('# '))?.slice(2) || 'Sculptor 文稿')}</title>
<style>
body{max-width:760px;margin:2.4rem auto;padding:0 1.2rem;font-family:"Songti SC","STSong","SimSun",serif;line-height:1.9;color:#222}
h1,h2,h3{font-family:"Heiti SC","STHeiti","SimHei",sans-serif;line-height:1.4}
blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}
code{background:#f4f4f4;padding:.1em .35em;border-radius:3px}
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;
  fs.writeFileSync(outFile, html);
  return path.resolve(outFile);
}

function toSrtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/**
 * 视频脚本文稿 → SRT 字幕：取【旁白/配音/台词/字幕/对白】标记行（或非标题正文行），
 * 按中文字符 4 字/秒估算时长；支持 [mm:ss] 或 [hh:mm:ss] 显式起始时间。
 */
export function exportSrt(mdText, outFile) {
  const blocks = [];
  let cursor = 0;
  for (const raw of String(mdText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const marker = line.match(/^[【\[]?(旁白|配音|台词|字幕|对白|字幕文案)[】\]]?[:：]\s*(.+)$/);
    const tMatch = line.match(/^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.+)$/);
    let text = '';
    let start = null;
    if (marker) text = marker[2];
    else if (tMatch) {
      const [, mm, ss, hh, rest] = tMatch;
      start = Number(hh || 0) * 3600 + Number(mm) * 60 + Number(ss);
      text = rest;
    } else if (/^#/.test(line)) continue;
    else text = line;
    if (!text) continue;
    if (start === null) start = cursor;
    const dur = Math.max(1.5, [...text].length / 4);
    blocks.push({ start, end: start + dur, text });
    cursor = start + dur;
  }
  if (!blocks.length) {
    throw new Error('没有可转字幕的台词行：请用【旁白/台词/字幕】标记，或提供 [mm:ss] 时间码');
  }
  const srt = blocks
    .map((b, i) => `${i + 1}\n${toSrtTime(b.start)} --> ${toSrtTime(b.end)}\n${b.text}\n`)
    .join('\n');
  fs.writeFileSync(outFile, srt);
  return path.resolve(outFile);
}

/** draft → PDF（reportlab + 内置中文 CID 字体，无需系统字体）。 */
export function exportPdf(mdText, outFile) {
  if (!pdfAvailable()) {
    throw new Error('本机没有 reportlab，无法导出 PDF。可先导出 html（--html）或 md。');
  }
  const tmpMd = path.join(path.dirname(outFile), `.sculptor-pdf-${Date.now()}.md`);
  fs.writeFileSync(tmpMd, mdText);
  try {
    runPy([path.join(IO_SCRIPTS, 'write_pdf.py'), tmpMd, path.resolve(outFile)]);
  } finally {
    fs.rmSync(tmpMd, { force: true });
  }
  return path.resolve(outFile);
}
