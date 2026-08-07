// 多模态输入输出：docx / xlsx / md / txt / 图片 → 文本；draft → docx。
// 依赖本机 Python（python-docx 用于 docx；xlsx 用 zipfile+ElementTree 零第三方解析）；
// 图片识别走视觉模型（SCULPTOR_VISION_MODEL），未配置时给出明确降级提示。
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
 * 把用户提供的文件提取为可写作的文本。
 * @returns {kind:'text'|'image'|'unsupported', text?, hint?, source?}
 */
export function extractInput(file, cfg = {}) {
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
