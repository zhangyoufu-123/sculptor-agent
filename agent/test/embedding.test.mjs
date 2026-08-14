// v0.65 神经风格编码 + 向量混合检索 + 调制器增量更新测试。
// 全部使用注入式 mock embedding（确定性哈希向量），不依赖真实 API。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const emb = await import(path.join(HERE, '..', 'src', 'embedding.js'));
const mod = await import(path.join(HERE, '..', 'src', 'modulator.js'));
const kb = await import(path.join(HERE, '..', 'src', 'knowledge.js'));
const { contrastiveScore } = await import(path.join(HERE, '..', 'src', 'token-decode.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-emb-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

const authorA = [
  '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，带着木头的气味。',
  '我想，一百年前有人也这样站过。历史不响，它只是等着。木梯窄，每一步都响。',
  '窗台积灰，灰上有细痕。我没有擦，只是看。过去不说话，可它留了痕迹。',
  '回头，楼还在。暮色里，红砖暗下去。纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去。',
  '我在门口站了很久，久到门卫多看了我两眼。风从门里出来，带着旧木头的味道，我忽然明白，有些东西不必说出来。',
  '再后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，在每一个路过的人停下来的那一眼里。',
].join('\n');
const sampleDir = path.join(w, 'vault', 'style-samples');
fs.mkdirSync(sampleDir, { recursive: true });
fs.writeFileSync(path.join(sampleDir, 'sample-a.md'), authorA);

// 确定性 mock embedding：按字符频率生成 8 维向量（相似文本余弦更高）
function mockEmbed(text) {
  const dim = 8;
  const v = new Array(dim).fill(0);
  for (const ch of String(text || '')) v[ch.charCodeAt(0) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function mockFetch(inputs) {
  return async (url, opts) => {
    assert(String(url).endsWith('/embeddings'), '调用 /embeddings');
    const body = JSON.parse(opts.body);
    const text = String(body.input || '');
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbed(text) }] }),
    };
  };
}

const cfg = {
  embedBaseUrl: 'https://mock-embed/v1',
  embedApiKey: 'mock',
  embedModel: 'mock-model',
};

// 1) 无配置/失败静默降级 + 配置后原型落盘、签名变化重算
{
  const none = await emb.authorPrototype({}, w);
  assert(none.ok === false, '无 embedding 配置 → 降级');
  const p1 = await emb.authorPrototype(cfg, w, { fetchImpl: mockFetch() });
  assert(p1.ok === true, '配置后原型可用');
  assert(p1.dim === 8 && Array.isArray(p1.vector), '原型维度正确');
  assert(fs.existsSync(emb.prototypeFile(w)), '原型落盘');
  const p2 = await emb.authorPrototype(cfg, w, { fetchImpl: mockFetch() });
  assert(p2.signature === p1.signature, '签名一致时复用缓存');
  fs.appendFileSync(path.join(sampleDir, 'sample-a.md'), '\n后来我又去了。门还开着，风还从里面出来。');
  const p3 = await emb.authorPrototype(cfg, w, { fetchImpl: mockFetch() });
  assert(p3.signature !== p1.signature, '语料变化 → 签名变化重算');
  console.log('PASS 神经原型（配置降级/落盘/缓存/签名重算）');
}

// 2) 调制器第 9 维：有原型+候选编码 → embedding 特征生效；无 → 中性 0.5
{
  const proto = await emb.authorPrototype(cfg, w, { fetchImpl: mockFetch() });
  const mWith = mod.modulate(w, '门开着。石阶旧。风从里面出来。', {
    prototype: proto,
    candidateEmbedding: mockEmbed('门开着。石阶旧。风从里面出来。'),
  });
  assert(Math.abs(mWith.features.embedding - 0.5) > 0.2, `embedding 特征应偏离中性（${mWith.features.embedding}）`);
  const mWithout = mod.modulate(w, '门开着。', {});
  assert(mWithout.features.embedding === 0.5, '无原型 → embedding 中性 0.5');
  const cs = contrastiveScore(null, w, '门开着。石阶旧。', {
    prototype: proto,
    candidateEmbedding: mockEmbed('门开着。石阶旧。'),
  });
  assert(typeof cs.embedding === 'number', '得分分解含 embedding 维');
  console.log('PASS 调制器第 9 维（embedding 特征/中性降级/得分分解）');
}

// 3) 知识库向量混合检索：语义排序提升 + 无配置降级
{
  fs.mkdirSync(path.join(w, 'vault', 'knowledge'), { recursive: true });
  kb.addEntry(w, { title: '北大红楼', type: 'place', note: '红砖灰瓦，历史现场', source: 'user-stated', confidence: 0.9 });
  kb.addEntry(w, { title: '量子力学', type: 'book', note: '微观世界的规律', source: 'user-stated', confidence: 0.9 });
  const hybrid = await kb.matchKbHybrid(cfg, w, '红楼 历史 砖', { limit: 10, fetchImpl: mockFetch() });
  assert(hybrid.length === 2, '混合检索返回条目');
  assert(hybrid[0].title === '北大红楼', '语义排序应把相关条目置顶');
  assert(typeof hybrid[0].semantic === 'number' && typeof hybrid[0].bm25 === 'number', '语义/BM25 分数可追溯');
  const plain = kb.matchKb(w, '红楼 历史 砖', { limit: 10 });
  assert(plain.length === 2, '纯 BM25 仍可用');
  const downgraded = await kb.matchKbHybrid({}, w, '红楼 历史 砖', { limit: 10 });
  assert(downgraded.length === 2 && downgraded[0].semantic === null, '无配置 → 语义列为 null 且不报错');
  console.log('PASS 向量混合检索（语义排序/分数追溯/无配置降级）');
}

// 4) 调制器增量在线更新：批量训练 → 追加编辑对 → 局部更新
{
  fs.writeFileSync(
    path.join(w, 'vault', 'edits.jsonl'),
    [
      { original: '在当今社会，随着科技的飞速发展，因此综上所述，我们应当充分发挥前所未有的积极作用。', changed: '门开着。石阶旧。风从里面出来，带着木头的气味。', intent: '去套话' },
      { original: '总而言之，历史具有深远意义，我们应当深刻铭记。', changed: '纪念牌上的字，我念了一遍。', intent: '留白' },
      { original: '首先，这个场景令人印象深刻。其次，我们应当思考其内涵。', changed: '木梯窄，每一步都响。', intent: '具体物象' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  const trained = mod.forceRetrain(w);
  assert(trained.ok === true, '批量训练成功');
  const before = trained.meta.pairs;
  fs.appendFileSync(
    path.join(w, 'vault', 'edits.jsonl'),
    JSON.stringify({ original: '综上所述，我们应当共同努力，开启新篇章。', changed: '风停。门合。他转身走了。', intent: '收束' }) + '\n',
  );
  const inc = mod.applyEditIncremental(w, {
    original: '综上所述，我们应当共同努力，开启新篇章。',
    changed: '风停。门合。他转身走了。',
  });
  assert(inc.ok === true, '增量更新成功');
  assert(inc.meta.pairs === before + 1, `偏好对数 +1（${before} → ${inc.meta.pairs}）`);
  const mPos = mod.modulate(w, '风停。门合。他转身走了。', {});
  const mNeg = mod.modulate(w, '综上所述，我们应当共同努力，开启新篇章。', {});
  assert(mPos.score > mNeg.score, '增量后新编辑对"改后 > 原文"');
  console.log('PASS 调制器增量在线更新（+1 编辑对/局部 SGD/新对排序正确）');
}

console.log('\n✓ embedding.test.mjs 全部通过');
