// 个人模型（v0.62）：把"风格签名"升级为可预测作者下一步选择的局部语言模型。
// 实现：基于作者本人语料（风格样本/成稿/亲手修改后的文本）训练字符级 n-gram 条件模型
// （order=4，回退 + 加一平滑），输出 p_personal(w|c) 的均值对数概率。
// 这是"签名 → 模型"的第一步：能对候选文本打分、能预测"作者更可能怎么写"，
// 与知识库严格分离（"如何写"来自作者语料，"写什么"来自知识库）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ORDER = 4;
const MIN_CORPUS = 80; // 至少 80 字符才有统计意义

/** 收集作者语料：风格样本 + 成稿 + 亲手修改后的文本（不含知识库/检索内容）。 */
export function collectPersonalCorpus(workspace) {
  const texts = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s.length >= 12) texts.push(s);
  };
  try {
    const sampleDir = path.join(workspace, 'vault', 'style-samples');
    if (fs.existsSync(sampleDir)) {
      for (const f of fs.readdirSync(sampleDir)) {
        if (f.endsWith('.md')) push(fs.readFileSync(path.join(sampleDir, f), 'utf8'));
      }
    }
  } catch {}
  try {
    const draft = path.join(workspace, 'draft.md');
    if (fs.existsSync(draft)) push(fs.readFileSync(draft, 'utf8'));
  } catch {}
  try {
    const edits = path.join(workspace, 'vault', 'edits.jsonl');
    if (fs.existsSync(edits)) {
      for (const line of fs.readFileSync(edits, 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          push(e.replacement || e.after || e.new || '');
        } catch {}
      }
    }
  } catch {}
  try {
    const lib = path.join(workspace, 'vault', 'library');
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.md')) push(fs.readFileSync(p, 'utf8'));
      }
    };
    if (fs.existsSync(lib)) walk(lib);
  } catch {}
  return texts;
}

export function corpusSignature(workspace) {
  const h = crypto.createHash('sha1');
  const files = [];
  const collect = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        if (fs.statSync(p).isDirectory()) collect(p);
        else files.push([p, fs.statSync(p).size, fs.statSync(p).mtimeMs]);
      } catch {}
    }
  };
  collect(path.join(workspace, 'vault', 'style-samples'));
  collect(path.join(workspace, 'vault', 'library'));
  for (const f of ['draft.md', path.join('vault', 'edits.jsonl')]) {
    const p = path.join(workspace, f);
    try {
      files.push([p, fs.statSync(p).size, fs.statSync(p).mtimeMs]);
    } catch {}
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const f of files) h.update(String(f));
  return h.digest('hex').slice(0, 16);
}

const modelCache = new Map();

/** 训练（或取缓存）个人字符级 n-gram 模型。 */
export function getPersonalModel(workspace) {
  const sig = corpusSignature(workspace);
  const cached = modelCache.get(sig);
  if (cached) return cached;
  const texts = collectPersonalCorpus(workspace);
  const corpus = texts.join('\n');
  if (corpus.length < MIN_CORPUS) return { ok: false, chars: corpus.length };
  const counts = new Map(); // key: 前缀+'\u0001'+字符
  const totals = new Map(); // key: 前缀
  const V = new Set();
  for (let i = 0; i < corpus.length; i++) {
    const ch = corpus[i];
    V.add(ch);
    const start = Math.max(0, i - (ORDER - 1));
    for (let k = start; k <= i; k++) {
      const prefix = corpus.slice(k, i);
      const key = prefix + '\u0001' + ch;
      counts.set(key, (counts.get(key) || 0) + 1);
      totals.set(prefix, (totals.get(prefix) || 0) + 1);
    }
  }
  const vocab = V.size;
  const model = {
    ok: true,
    order: ORDER,
    counts,
    totals,
    vocab,
    chars: corpus.length,
    alpha: 0.4, // 加一平滑强度（对稀疏语料保守）
  };
  modelCache.set(sig, model);
  if (modelCache.size > 20) {
    const first = modelCache.keys().next().value;
    modelCache.delete(first);
  }
  return model;
}

/** 单字符条件对数概率（回退到更短前缀，最终回退到均匀分布）。 */
export function charLogProb(model, prefix, ch) {
  if (!model || !model.ok) return 0;
  const n = Math.min(model.order, prefix.length);
  for (let k = n; k >= 1; k--) {
    const p = prefix.slice(prefix.length - k);
    const key = p + '\u0001' + ch;
    const c = model.counts.get(key) || 0;
    const t = model.totals.get(p) || 0;
    if (t > 0) {
      return Math.log((c + model.alpha) / (t + model.alpha * model.vocab));
    }
  }
  return Math.log(model.alpha / (model.alpha * model.vocab));
}

/** 候选文本的平均每字符对数概率（p_personal 评分，数值越大越像作者）。 */
export function personalLogProb(model, text) {
  if (!model || !model.ok) return 0;
  const t = String(text || '');
  if (t.length < 4) return 0;
  let sum = 0;
  let count = 0;
  let prefix = '';
  for (const ch of t) {
    sum += charLogProb(model, prefix, ch);
    count += 1;
    prefix = (prefix + ch).slice(-(model.order - 1));
  }
  return sum / count;
}

export function personalCorpusSize(workspace) {
  try {
    return getPersonalModel(workspace).chars || 0;
  } catch {
    return 0;
  }
}
