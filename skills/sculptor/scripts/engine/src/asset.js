// 内置写作资产库（v0.21）：文法连接、诗词典故、论证骨架 + 思想库（荐书联想底座）。
// 确定性内容（JSON 模板），只做检索注入，杜绝诗词/出处幻觉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

let _assets = null;
let _thoughts = null;

export function loadAssetLibrary() {
  if (_assets) return _assets;
  try {
    _assets = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'asset-library.json'), 'utf8'));
  } catch {
    _assets = { grammar: [], poetry: [], argument: [] };
  }
  return _assets;
}

export function loadThoughtLibrary() {
  if (_thoughts) return _thoughts;
  try {
    _thoughts = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'thought-library.json'), 'utf8'));
  } catch {
    _thoughts = { works: [] };
  }
  return _thoughts;
}

function tokens(text) {
  const out = new Set();
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[《》「」“”"'‘’\s\d，。、；：！？]/g, '');
  // 中文用字符二元组（贴合标签/短语匹配），英文保留整词
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) out.add(g);
  }
  for (const m of clean.match(/[a-z]{3,}/g) || []) out.add(m);
  return out;
}

/** 按主题命中诗词/文法/论证骨架（限量）。 */
export function assetBrief(query, { kinds = ['grammar', 'poetry', 'argument'], limit = 4 } = {}) {
  const lib = loadAssetLibrary();
  const out = [];
  const q = tokens(query);
  for (const kind of kinds) {
    const items = lib[kind] || [];
    const scored = items
      .map((it) => {
        let score = 0;
        const pool = [...(it.usage || []), it.name || '', it.meaning || ''];
        for (const t of pool) {
          const tt = tokens(t);
          for (const w of q) if (tt.has(w)) score += 1;
        }
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { it } of scored) {
      if (out.length >= limit) break;
      if (kind === 'poetry') {
        out.push(`诗词：${it.text}（${it.source}）——${it.meaning}`);
      } else if (kind === 'grammar') {
        out.push(`文法「${it.name}」：${(it.examples || []).slice(0, 2).join(' / ')}（用于${it.usage}）`);
      } else {
        out.push(`论证骨架「${it.name}」：${it.template}`);
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 思想库荐书联想：从主题/立意/论点提取关键词，匹配书/理论的 usage 标签，
 * 返回最相关的 1-2 本 + 一句话核心思想 + 为什么适用（由调用方结合用户主题润色）。
 */
export function recommendWorks(state) {
  const lib = loadThoughtLibrary();
  const text = [
    state?.confirmed?.topic,
    state?.confirmed?.theme,
    state?.confirmed?.stance,
    ...(state?.confirmed?.arguments || []),
    state?.lastInput,
  ]
    .filter(Boolean)
    .join(' ');
  const q = tokens(text);
  if (!q.size) return [];
  const scored = lib.works
    .map((w) => {
      const pool = [...(w.apply || []), ...(w.tags || []), w.title, w.author];
      let score = 0;
      for (const t of pool) {
        const tt = tokens(t);
        for (const k of q) if (tt.has(k)) score += 1;
      }
      return { w, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return scored.map(({ w, score }) => ({
    title: w.title,
    author: w.author,
    core: w.core,
    apply: w.apply,
    score,
  }));
}
