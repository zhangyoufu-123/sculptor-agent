// 神经风格编码（v0.65）：把"统计指纹"升级为可选的语义级风格编码。
//
// 设计：配置 STYLOTRACE_EMBED_BASE_URL/API_KEY/MODEL 后，作者语料被编码为
// 稠密原型向量（风格语义原型），候选文本与原型做余弦——捕捉统计特征抓不到的
// 语义级风格（意象系统、论证气味、叙述视角）。
// 未配置时全部静默降级（{ok:false}），现有稀疏/统计路径不受影响。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectPersonalCorpus } from './personal-model.js';

const cache = new Map();
const PROTOTYPE_FILE = 'style-prototype.json';

/** OpenAI 兼容 /embeddings 单文本编码；失败返回 null（可注入 fetchImpl 便于测试）。 */
export async function embedText(cfg = {}, text, { fetchImpl = null } = {}) {
  const t = String(text || '');
  if (!t) return null;
  const base = String(cfg.embedBaseUrl || '').replace(/\/+$/, '');
  if (!base || !cfg.embedApiKey || !cfg.embedModel) return null;
  const key = crypto.createHash('sha1').update(t).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') return null;
  try {
    const res = await fetcher(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.embedApiKey}`,
      },
      body: JSON.stringify({ model: cfg.embedModel, input: t.slice(0, 8000) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res || !res.ok) return null;
    const j = await res.json();
    const vec = j?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.length) return null;
    const arr = Float64Array.from(vec);
    cache.set(key, arr);
    return arr;
  } catch {
    return null;
  }
}

export function cosineDenseVec(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 0;
}

function chunkTexts(texts, maxChars = 1200) {
  const out = [];
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  }
  return out;
}

export function prototypeFile(workspace) {
  return path.join(workspace, 'vault', PROTOTYPE_FILE);
}

/** 同步读取已落盘的作者稠密原型（无则 {ok:false}）。 */
export function readPrototype(workspace) {
  try {
    const p = JSON.parse(fs.readFileSync(prototypeFile(workspace), 'utf8'));
    if (!p?.ok || !Array.isArray(p.vector) || !p.vector.length) return { ok: false };
    return p;
  } catch {
    return { ok: false };
  }
}

/**
 * 计算并落盘作者稠密原型：个人语料分块 embedding → 逐分量均值。
 * 语料签名变化自动重算；无 embedding 配置/失败时降级 {ok:false}。
 */
export async function authorPrototype(cfg = {}, workspace, { force = false, fetchImpl = null } = {}) {
  const texts = collectPersonalCorpus(workspace);
  if (!texts.length) return { ok: false, reason: '无个人语料' };
  const chunks = chunkTexts(texts);
  const h = crypto.createHash('sha1');
  for (const c of chunks) h.update(c);
  const signature = h.digest('hex').slice(0, 16);
  const file = prototypeFile(workspace);
  if (!force) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing?.ok && existing.signature === signature) return existing;
    } catch {}
  }
  const vectors = [];
  for (const c of chunks) {
    const v = await embedText(cfg, c, { fetchImpl });
    if (v) vectors.push(v);
  }
  if (!vectors.length) return { ok: false, reason: 'embedding 不可用（未配置或请求失败）' };
  const dim = vectors[0].length;
  const sum = new Float64Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  const vector = Array.from(sum).map((x) => x / vectors.length);
  const proto = {
    ok: true,
    dim,
    vector,
    model: cfg.embedModel || '',
    signature,
    chunks: vectors.length,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(proto) + '\n', { mode: 0o600 });
  } catch {}
  return proto;
}
