// 个人回避库（v0.68，负空间第一阶段）：作者"不写什么"也是一级风格信号。
//
// 依据：每一次 point-edit 的 original（作者亲手删掉的片段）就是一条"我不这么写"
// 的证据。聚合这些片段的高频词，得到个人回避词库——与通用 AI 词表（defect）不同，
// 这是从作者自己行为里学出来的回避，越用越个人化。
// 存储：vault/avoidance.json { terms: {词: 次数}, signature }。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AVOIDANCE_FILE = 'avoidance.json';

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

function signatureOf(workspace) {
  const h = crypto.createHash('sha1');
  try {
    const p = path.join(workspace, 'vault', 'edits.jsonl');
    const st = fs.statSync(p);
    h.update(`${p}:${st.size}:${st.mtimeMs}`);
  } catch {}
  return h.digest('hex').slice(0, 16);
}

export function avoidanceFile(workspace) {
  return path.join(workspace, 'vault', AVOIDANCE_FILE);
}

/** 聚合 edits.original：2–4 字高频窗口，过滤停用词，取 top 50。 */
export function collectAvoidance(workspace) {
  const counts = new Map();
  for (const line of readLines(path.join(workspace, 'vault', 'edits.jsonl'))) {
    try {
      const e = JSON.parse(line);
      const orig = String(e.original || '')
        .replace(/[，。！？；、：,.!?;:"“”「」『』（）()\s]/g, '');
      if (orig.length < 2) continue;
      for (let i = 0; i < orig.length - 1; i++) {
        for (let L = 2; L <= 4 && i + L <= orig.length; L++) {
          const t = orig.slice(i, i + L);
          if (STOP.has(t)) continue;
          counts.set(t, (counts.get(t) || 0) + 1);
        }
      }
    } catch {}
  }
  const terms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 50);
  return {
    ok: terms.length > 0,
    terms: Object.fromEntries(terms),
    signature: signatureOf(workspace),
  };
}

/** 同步读取（无文件时确定性聚合，不写盘）。 */
export function readAvoidance(workspace) {
  try {
    const a = JSON.parse(fs.readFileSync(avoidanceFile(workspace), 'utf8'));
    if (a?.ok) return a;
  } catch {}
  return collectAvoidance(workspace);
}

/** 落盘（数据签名变化时由调制器调用）。 */
export function writeAvoidance(workspace, obj) {
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(avoidanceFile(workspace), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}
