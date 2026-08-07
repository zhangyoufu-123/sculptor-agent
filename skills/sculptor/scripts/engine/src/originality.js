// 原创性检查（内置、静默质量门）：不展示给用户，但每次交付前真实执行。
// 1) 文内近似重复句：同一文稿里归一化后完全相同的句子（8 字以上）；
// 2) 与个人写作库/旧稿的自我复用：和 vault/library、style-samples 里出现过的句子重复；
// 3) 疑似模板长句：与"通用范文句"弱规则匹配（谨慎，只报高置信的）。
// 输出不打断用户：记录进 state.originality + context 日志，供 RAG 查证与红队修订参考。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';

const TEMPLATE_LIKE = [
  /在当今社会，/,
  /随着(社会|时代|科技)的(发展|进步)，/,
  /我们(应当|应该|必须)(共同)?(努力|携手)/,
  /让我们不禁(思考|感慨|反思)/,
  /综上所述，/,
  /值得(我们)?(注意|关注)的是/,
];

function sentences(text) {
  return String(text || '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim().replace(/\s+/g, ''))
    .filter((s) => [...s].length >= 8);
}

function norm(s) {
  return String(s || '')
    .replace(/[，,、；;：:“”"‘’'（）()《》<>]/g, '')
    .trim();
}

function collectKnownTexts(workspace) {
  const texts = [];
  const vault = path.join(workspace, 'vault');
  for (const dir of [path.join(vault, 'library'), path.join(vault, 'style-samples')]) {
    try {
      for (const root of fs.readdirSync(dir, { withFileTypes: true })) {
        const base = path.join(dir, root.name);
        const files = root.isDirectory()
          ? fs.readdirSync(base).filter((f) => f.endsWith('.md'))
          : root.name.endsWith('.md')
            ? [root.name]
            : [];
        for (const f of files) texts.push(fs.readFileSync(path.join(base, f), 'utf8'));
      }
    } catch {}
  }
  return texts;
}

/** 原创性检查（确定性，毫秒级）。 */
export function originalityScan(text, workspace) {
  const t = String(text || '');
  const sents = sentences(t);
  const counts = new Map();
  for (const s of sents) {
    const k = norm(s);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const selfDuplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([k]) => k)
    .slice(0, 5);
  // 与个人库/旧稿的自我复用
  const known = new Set();
  for (const doc of collectKnownTexts(workspace)) {
    for (const s of sentences(doc)) known.add(norm(s));
  }
  const libraryOverlaps = sents.filter((s) => known.has(norm(s))).slice(0, 5);
  const templateHits = TEMPLATE_LIKE.filter((re) => re.test(t)).map((re) => re.source);
  const total = selfDuplicates.length + libraryOverlaps.length + templateHits.length;
  return {
    total,
    selfDuplicates,
    libraryOverlaps,
    templateHits,
    risk: total >= 3 ? 'high' : total >= 1 ? 'low' : 'none',
  };
}
