// 改迹变换（v1.7）：把"编辑即标注"从负空间（avoidance：作者删了什么）补全到
// 正空间——作者在 changed 里**新增**了什么（具体化/意象/口语等）。
// 两者合成"作者会怎么改"的完整方向：editFit = 正向命中 / (正向 + 负向命中)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TRANSFORM_FILE = 'edit-transform.json';

const STOP = new Set([
  '一个', '没有', '自己', '就是', '因为', '所以', '但是', '还是', '可以', '已经',
  '这样', '那样', '时候', '现在', '然后', '知道', '觉得', '真的', '起来', '出来',
  '东西', '事情', '感觉', '开始', '最后', '不是', '只是', '我们', '他们', '你们',
  '这个', '那个', '什么', '以及', '并且', '或者', '如果', '那么', '对于', '关于',
]);

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function cleanText(text) {
  return String(text || '').replace(/[，。！？；、：,.!?;:"“”「」『』（）()\s]/g, '');
}

function ngrams(text) {
  const t = cleanText(text);
  const counts = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    for (let L = 2; L <= 4 && i + L <= t.length; L++) {
      const g = t.slice(i, i + L);
      if (STOP.has(g)) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  return counts;
}

function signatureOf(workspace) {
  const h = crypto.createHash('sha1');
  try {
    const p = path.join(workspace, 'vault', 'edits.jsonl');
    const st = fs.statSync(p);
    h.update(`${p}:${st.size}:${st.mtimeMs}`);
  } catch {}
  return h.digest('hex').slice(0, 16);
}

/**
 * 从编辑对聚合"改迹变换"：added = changed 有而 original 无；deleted = original 有而 changed 无。
 * 各取 top 40，返回 { ok, added:{词:次数}, deleted:{词:次数}, signature }。
 */
export function collectEditTransform(workspace) {
  const added = new Map();
  const deleted = new Map();
  for (const line of readLines(path.join(workspace, 'vault', 'edits.jsonl'))) {
    try {
      const e = JSON.parse(line);
      const orig = ngrams(e.original);
      const chg = ngrams(e.changed);
      for (const [g, c] of chg) if (!orig.has(g)) added.set(g, (added.get(g) || 0) + c);
      for (const [g, c] of orig) if (!chg.has(g)) deleted.set(g, (deleted.get(g) || 0) + c);
    } catch {}
  }
  const top = (m) =>
    Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 40));
  return {
    ok: added.size > 0 || deleted.size > 0,
    added: top(added),
    deleted: top(deleted),
    signature: signatureOf(workspace),
  };
}

export function transformFile(workspace) {
  return path.join(workspace, 'vault', TRANSFORM_FILE);
}

export function readEditTransform(workspace) {
  try {
    const t = JSON.parse(fs.readFileSync(transformFile(workspace), 'utf8'));
    if (t?.ok) return t;
  } catch {}
  return collectEditTransform(workspace);
}

export function writeEditTransform(workspace, obj) {
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(transformFile(workspace), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

/**
 * 改迹贴合度（0~1，0.5 中性）：候选命中作者"新增词"越多越高，命中"删除词"越多越低。
 */
export function editFitScore(profile, text) {
  if (!profile?.ok) return 0.5;
  const t = String(text || '');
  let pos = 0;
  let neg = 0;
  for (const [term, c] of Object.entries(profile.added || {})) if (t.includes(term)) pos += c;
  for (const [term, c] of Object.entries(profile.deleted || {})) if (t.includes(term)) neg += c;
  if (pos + neg === 0) return 0.5;
  return Math.max(0, Math.min(1, pos / (pos + neg)));
}
