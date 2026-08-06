// 深度定点修改：用户选中一句原文（或粘贴"引用"），AI 精确定位、只改那一处，
// 校验改动不越界、吸收进风格档案、输出 diff。这是"人机深度协作"的核心协议。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry } from './llm.js';
import * as ws from './workspace.js';
import { styleSummary } from './outline.js';

/** 解析"引用"粘贴格式：〔Sculptor 引用〕《原文》 或 直接原文 */
export function parseQuoteArg(raw) {
  let s = String(raw || '').trim();
  // 两行引用块：〔Sculptor 引用〕《原文》\n修改指令：…
  const block = s.match(/〔[^〕]*引用[^〕]*〕\s*[《<«「](.+?)[》>»」]/s);
  if (block) return block[1].trim();
  const m = s.match(/〔[^〕]*引用[^〕]*〕\s*[《<«「]?(.+?)[》>»」]?$/s);
  if (m) return m[1].trim();
  s = s.replace(/^〔[^〕]*引用[^〕]*〕\s*/, '');
  s = s.replace(/^[《<«「]/, '').replace(/[》>»」]$/, '');
  return s.trim();
}

/** 从两行引用块里提取"修改指令：…" */
export function extractInstruction(raw) {
  const m = String(raw || '').match(/修改指令[：:]\s*(.+)/s);
  return m ? m[1].trim() : '';
}

function normalizeText(t) {
  return String(t)
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！“”‘’"'（）()《》<>【】]/g, '');
}

/** 在正文中定位引用：先精确匹配，再归一化匹配 */
export function findQuote(text, quote) {
  const idx = text.indexOf(quote);
  if (idx >= 0) return { start: idx, end: idx + quote.length, matched: quote };
  const nq = normalizeText(quote);
  const nt = normalizeText(text);
  const ni = nt.indexOf(nq);
  if (ni >= 0) {
    let start = -1;
    let j = 0;
    for (let i = 0; i < text.length && j <= ni; i++) {
      if (normalizeText(text[i])) {
        if (j === ni) start = i;
        j += 1;
      }
    }
    let end = start;
    let k = 0;
    for (let i = start; i < text.length && k < nq.length; i++) {
      if (normalizeText(text[i])) k += 1;
      end = i + 1;
    }
    if (start >= 0 && end > start) return { start, end, matched: text.slice(start, end) };
  }
  return null;
}

/** 扫描项目下的 .md 文件（有界，跳过 node_modules/.git/.sculptor） */
export function scanMdFiles(dir, { max = 50 } = {}) {
  const out = [];
  const walk = (d) => {
    if (out.length >= max) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || ['node_modules', 'out', '.sculptor'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && !e.name.startsWith('.')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function locateQuote(dir, quote, fileHint) {
  if (fileHint && fs.existsSync(fileHint)) {
    const text = fs.readFileSync(fileHint, 'utf8');
    return allHits(text, quote).map((hit) => ({ file: fileHint, text, hit }));
  }
  const results = [];
  for (const f of scanMdFiles(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const hit of allHits(text, quote)) results.push({ file: f, text, hit });
  }
  return results;
}

/**
 * 并发修改守卫（退让协议）：写盘前重新读取文件，确认目标原文仍在原位置。
 * 文件被其他 agent 或用户改过 → 中止且不写盘，绝不覆盖别人的改动。
 */
export function applyChangeIfUnchanged(file, hit, replacement) {
  const current = fs.readFileSync(file, 'utf8');
  if (current.slice(hit.start, hit.end) !== hit.matched) {
    throw new Error(
      '该文件在修改期间被外部改动（目标原文已变化），Sculptor 已退让中止、未写盘。请重新选择引用后再改。',
    );
  }
  const before = current.slice(0, hit.start);
  const after = current.slice(hit.end);
  const newText = before + replacement + after;
  if (
    newText.slice(0, hit.start) !== before ||
    newText.slice(hit.start + replacement.length) !== after
  ) {
    throw new Error('修订结果越界（改到了区间之外），已中止且未写盘。');
  }
  fs.writeFileSync(file, newText);
  return newText;
}

/** 收集正文中引用的所有出现位置（同文件内重复也算） */
function allHits(text, quote) {
  const hits = [];
  let from = 0;
  while (from < text.length) {
    const hit = findQuote(text.slice(from), quote);
    if (!hit) break;
    hits.push({ start: from + hit.start, end: from + hit.end, matched: hit.matched });
    from = from + hit.end;
  }
  return hits;
}

/** 从修改指令中提取风格维度信号（写/读档案） */
export function classifyInstruction(inst) {
  const write = {};
  const read = {};
  const i = String(inst || '');
  if (/文艺|矫情|华丽|堆砌/.test(i)) {
    write.temperature = { value: '更克制', delta: 0.15 };
    write.imageryTendency = { value: '减少意象堆叠', delta: 0.1 };
  }
  if (/短|紧凑|啰嗦|简练/.test(i)) {
    write.sentencePreference = { value: '短句为主', delta: 0.15 };
    read.pacing = { value: '更紧凑', delta: 0.1 };
  }
  if (/像 ?ai|ai ?味|机器/.test(i)) write.temperature = { value: '更有人味', delta: 0.2 };
  if (/留白|含蓄|收/.test(i)) write.endingPattern = { value: '留白收束', delta: 0.15 };
  if (/具体|画面|细节|场景/.test(i)) write.modifierDensity = { value: '细节更足', delta: 0.15 };
  if (/口语|自然|不像写作文/.test(i)) write.languageRegister = { value: '更口语化', delta: 0.15 };
  return { write, read };
}

/**
 * 定点修改主流程
 * @param quote       选中的原文（或〔引用〕格式）
 * @param instruction 修改指令
 */
export async function pointEdit(cfg, wsDir, { quote, instruction, dir, file }) {
  const workspace = ws.ensureWorkspace(wsDir);
  const project = path.resolve(dir || process.cwd());
  const q = parseQuoteArg(quote);
  if (!q) throw new Error('引用为空：请提供选中的原文');
  const found = locateQuote(project, q, file);
  if (found.length === 0) {
    throw new Error(
      `在工作区找不到引用的原文:\n「${q}」\n请确认选中的是文档里的原句（带上标点更稳）。`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `「${q}」在 ${found.length} 个位置出现，请用 --file 指定文件:\n${found.map((f) => `  ${f.file}`).join('\n')}`,
    );
  }
  const { file: targetFile, text, hit } = found[0];
  const before = text.slice(0, hit.start);
  const after = text.slice(hit.end);
  const context = `${before.slice(-200)}\n⟦待修改⟧${hit.matched}⟦⟧\n${after.slice(0, 200)}`;
  const writeStyle = styleSummary(path.join(workspace, 'vault', 'write-style.json'));

  const content = await chatWithRetry(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是修订者。只改写 ⟦待修改⟧ 标记的片段本身，保持上下文其余文字完全不变；只输出改写后的片段。',
      },
      {
        role: 'user',
        content: `修改指令: ${instruction}\n\n【写作风格】${writeStyle}\n\n【上下文】\n${context}`,
      },
    ],
    { temperature: 0.7, maxTokens: 1500 },
  );
  const replacement = content.trim();

  applyChangeIfUnchanged(targetFile, hit, replacement);

  const dims = classifyInstruction(instruction);
  const absorbed = ws.absorbEdit(workspace, {
    target: q,
    original: hit.matched,
    changed: replacement,
    intent: instruction,
    evidence: `point-edit: ${String(instruction).slice(0, 40)}`,
    writeDims: dims.write,
    readDims: dims.read,
  });
  ws.logContext(
    workspace,
    'point-edit',
    `${targetFile}: 「${q.slice(0, 30)}」→ ${String(instruction).slice(0, 30)}`,
  );

  return {
    file: targetFile,
    quote: hit.matched,
    replacement,
    writeUpdated: absorbed.writeUpdated,
    readUpdated: absorbed.readUpdated,
  };
}
