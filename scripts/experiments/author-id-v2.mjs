#!/usr/bin/env node
// 作者识别 v2（强基线 + 置换检验）：用真实的 JS 个人 n-gram + 12 维调制器特征，
// 对比字符二元组 TF-IDF 基线，并给出配对置换检验的显著性。
// 用法：node scripts/experiments/author-id-v2.mjs [--out result.md]
// 诚实边界：样本仍为 9 类单篇文本（匿名真人 + 真人模拟 + 通用模型 + 模板），
// 同文滑窗切块会高估准确率；本脚本的增量价值是"真实 JS 签名 + 显著性"，不是"声称超基线"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const pm = await import(path.join(ROOT, 'agent', 'src', 'personal-model.js'));
const mod = await import(path.join(ROOT, 'agent', 'src', 'modulator.js'));
const { permutationTestPaired } = await import(path.join(ROOT, 'agent', 'src', 'stats.js'));
const ws = await import(path.join(ROOT, 'agent', 'src', 'workspace.js'));
const stylo = await import(path.join(ROOT, 'agent', 'src', 'stylometry.js'));

const SAMPLES = {
  'SCULPTOR 作者':
    '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，在每一个路过的人停下来看的那一眼里。',
  '真人作者 A':
    '它为一个失魂落魄的人把一切都准备好了。那时，太阳循着亘古不变的路途正越来越大，也越红。在满园弥漫的沉静光芒中，一个人更容易看到时间，并看见自己的身影。一个人，出生了，这就不再是一个可以辩论的问题，而只是上帝交给他的一个事实。死是一件不必急于求成的事，死是一个必然会降临的节日。园子荒芜但并不衰败。蜂儿如一朵小雾稳稳地停在半空，蚂蚁摇头晃脑捋着触须，压弯了草叶轰然坠地摔开万道金光。满园子都是草木竞相生长弄出的响动，窸窸窣窣片刻不息。',
  '真人作者 B':
    '乡下人在城里人眼睛里是"愚"的。其实乡下人并不愚，他们只是在乡土环境里不需要认得那么多字。文字是间接的说话，而且是个不太完善的工具。在面对面社群里，连语言本身都还是不得已而采取的工具。文字所能传的情、达的意是不完全的，这不完全是出于"间接接触"的原因。乡土社会里，语言像是个通行证，而这个通行证却只有在这个社会里的人才懂得它的意义。',
  '真人模拟·克制留白':
    '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。',
  '真人模拟·口语亲切':
    '你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。',
  '真人模拟·豪迈大气':
    '风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，他跨过门槛的瞬间，历史便从纸面站起，成为人。木梯向上，每一步都像擂鼓，在空旷的穹顶下回荡。人们说历史很远，可它就在这灰里、这木纹里，等着一个敢走进去的人，把它重新点燃。',
  'ChatGPT 通用基线':
    '在当今社会，随着科技的飞速发展，人工智能已经深刻地改变了我们的生活方式。它不仅提高了生产效率，也为人们带来了前所未有的便利。与此同时，我们也应该看到，任何事物都具有两面性。因此，我们需要理性地看待人工智能的发展，充分发挥其积极作用，同时也要注意防范潜在的风险。总而言之，人工智能是时代发展的必然趋势，我们应该以积极的态度迎接它，让它更好地服务于人类社会的发展与进步。',
  'DeepSeek 通用基线':
    '随着人工智能技术的持续演进，其应用场景正在不断拓展，覆盖了教育、医疗、金融等多个重要领域。首先，在教育领域，智能辅导系统能够为学生提供个性化的学习路径；其次，在医疗领域，辅助诊断模型显著提升了诊疗效率；此外，金融风控模型也帮助机构更好地识别风险。值得注意的是，技术的进步同时也带来了数据安全与伦理等方面的挑战。综上所述，我们应当秉持审慎的态度，推动人工智能健康有序地发展。',
  '模板公文基线':
    '根据上级有关文件精神，结合我单位实际情况，现就做好相关工作通知如下：一、提高思想认识，充分领会工作的重要性；二、加强组织领导，明确责任分工；三、严格时间节点，确保任务按期完成；四、强化督导检查，及时通报进展情况。请各单位认真贯彻执行，并将落实情况及时上报。特此通知。',
};

// ── 字符二元组 TF-IDF 基线 ──────────────────────────────
function bigrams(text) {
  const clean = String(text || '').replace(/[\s\d]+/g, '').replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z]/g, '');
  const out = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}
function gramVec(grams) {
  const v = new Map();
  for (const g of grams) v.set(g, (v.get(g) || 0) + 1);
  return v;
}
function cosine(a, b) {
  let dot = 0;
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k);
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
function tfidfFit(trainVecs) {
  const df = new Map();
  for (const v of trainVecs) for (const k of v.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = trainVecs.length || 1;
  const idf = new Map();
  let maxIdf = 0;
  for (const [k, c] of df) {
    const idfV = Math.log(N / c);
    idf.set(k, idfV);
    if (idfV > maxIdf) maxIdf = idfV;
  }
  return { idf, maxIdf };
}
function tfidfTransform(vecs, idf, maxIdf) {
  return vecs.map((v) => {
    const out = new Map();
    for (const [g, cnt] of v) out.set(g, (1 + Math.log(cnt)) * (idf.get(g) ?? maxIdf));
    return out;
  });
}

// ── 分块与工作区 ──────────────────────────────────────
function chunk(text, window = 80, step = 40, minLen = 40) {
  const out = [];
  for (let i = 0; i < text.length - minLen; i += step) out.push(text.slice(i, i + window));
  return out;
}
function authorWorkspace(author, text) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-v2-'));
  const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });
  const dir = path.join(w, 'vault', 'style-samples');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${author}.md`), text);
  return w;
}

// ── 文本级特征（纯函数，与 workspace 无关，避免泄漏）──────
function textFeatureVec(text) {
  return [
    mod.surfaceFeature(text),
    mod.discourseFeature(text),
    mod.defectScore(text),
    mod.postureFeature(text),
    mod.impedanceScore(text, 0.5),
  ];
}
function dot(a, b) {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}
function norm(a) {
  return Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
}
function featCos(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

// ── 分类 ──────────────────────────────────────────────
function classifyTfidf(trainCentroids, testVec) {
  let best = null;
  let bestS = -1;
  for (const [a, cent] of trainCentroids) {
    const s = cosine(testVec, cent);
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}
function classifyPersonal(models, text) {
  let best = null;
  let bestS = -Infinity;
  for (const [a, m] of models) {
    const s = pm.personalLogProb(m, text);
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}
function classifyFeatures(featCentroids, text) {
  let best = null;
  let bestS = -Infinity;
  const feat = textFeatureVec(text);
  for (const [a, cent] of featCentroids) {
    const s = featCos(feat, cent);
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}
function classifyStylometry(styloCentroids, text) {
  const v = stylo.stylometricVector(text);
  let best = null;
  let bestS = -1;
  for (const [a, cent] of styloCentroids) {
    const s = stylo.stylometricCosine(v, cent);
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}
function classifyFused(models, featCentroids, text, alpha = 0.6) {
  let best = null;
  let bestS = -Infinity;
  const plogs = [];
  for (const [a, m] of models) plogs.push([a, pm.personalLogProb(m, text)]);
  const plMin = Math.min(...plogs.map((x) => x[1]));
  const plMax = Math.max(...plogs.map((x) => x[1]));
  const span = plMax - plMin || 1;
  const feat = textFeatureVec(text);
  for (const [a, m] of models) {
    const pNorm = (pm.personalLogProb(m, text) - plMin) / span;
    const fc = featCos(feat, featCentroids.get(a));
    const s = alpha * pNorm + (1 - alpha) * fc;
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}
function classifySignature(models, styloCentroids, text, alpha = 0.5) {
  const plogs = [];
  for (const [a, m] of models) plogs.push([a, pm.personalLogProb(m, text)]);
  const plMin = Math.min(...plogs.map((x) => x[1]));
  const plMax = Math.max(...plogs.map((x) => x[1]));
  const span = plMax - plMin || 1;
  const sv = stylo.stylometricVector(text);
  let best = null;
  let bestS = -Infinity;
  for (const [a, m] of models) {
    const pNorm = (pm.personalLogProb(m, text) - plMin) / span;
    const sc = stylo.stylometricCosine(sv, styloCentroids.get(a));
    const s = alpha * pNorm + (1 - alpha) * sc;
    if (s > bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}

// ── 主流程（按作者分层切分，模型只在训练集上拟合，杜绝泄漏）──────────
const AUTHORS = Object.keys(SAMPLES);
const authorChunks = new Map();
for (const a of AUTHORS) authorChunks.set(a, chunk(SAMPLES[a]));

// 确定性种子
let rng = 20260813;
function rand() {
  rng = (rng * 1664525 + 1013904223) >>> 0;
  return rng / 4294967296;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function avgVec(vecs) {
  const n = vecs.length || 1;
  const out = new Array(vecs[0]?.length || 0).fill(0);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return out.map((x) => x / n);
}

const preds = { tfidf: [], personal: [], features: [], stylometry: [], signature: [], fused: [] };
const truths = [];
const ROUNDS = 12;
for (let r = 0; r < ROUNDS; r++) {
  // 1) 每个作者自己的块按 60/40 切，模型只用各自训练块拟合
  const trainByAuthor = new Map();
  const testByAuthor = new Map();
  for (const a of AUTHORS) {
    const cs = shuffle([...authorChunks.get(a)]);
    const split = Math.max(1, Math.floor(cs.length * 0.6));
    trainByAuthor.set(a, cs.slice(0, split));
    testByAuthor.set(a, cs.slice(split));
  }
  const models = new Map();
  const featCentroids = new Map();
  const styloCentroids = new Map();
  for (const a of AUTHORS) {
    const w = authorWorkspace(a, trainByAuthor.get(a).join('\n'));
    models.set(a, pm.getPersonalModel(w));
    featCentroids.set(a, avgVec(trainByAuthor.get(a).map((t) => textFeatureVec(t))));
    styloCentroids.set(a, stylo.stylometricCentroid(trainByAuthor.get(a).map((t) => stylo.stylometricVector(t))));
  }
  // 2) TF-IDF 在训练块上拟合
  const trainFlat = [];
  const trainAuthor = [];
  for (const a of AUTHORS) {
    for (const t of trainByAuthor.get(a)) {
      trainFlat.push(gramVec(bigrams(t)));
      trainAuthor.push(a);
    }
  }
  const { idf, maxIdf } = tfidfFit(trainFlat);
  const tfTr = tfidfTransform(trainFlat, idf, maxIdf);
  const centroids = new Map();
  for (let j = 0; j < trainFlat.length; j++) {
    const a = trainAuthor[j];
    if (!centroids.has(a)) centroids.set(a, new Map());
    const c = centroids.get(a);
    for (const [g, v] of tfTr[j]) c.set(g, (c.get(g) || 0) + v);
  }
  // 3) 测试
  for (const a of AUTHORS) {
    for (const text of testByAuthor.get(a)) {
      truths.push(a);
      preds.tfidf.push(classifyTfidf(centroids, tfidfTransform([gramVec(bigrams(text))], idf, maxIdf)[0]));
      preds.personal.push(classifyPersonal(models, text));
      preds.features.push(classifyFeatures(featCentroids, text));
      preds.stylometry.push(classifyStylometry(styloCentroids, text));
      preds.signature.push(classifySignature(models, styloCentroids, text));
      preds.fused.push(classifyFused(models, featCentroids, text));
    }
  }
}

function acc(p) {
  let hit = 0;
  for (let i = 0; i < truths.length; i++) if (p[i] === truths[i]) hit += 1;
  return hit / truths.length;
}
const accTfidf = acc(preds.tfidf);
const accPersonal = acc(preds.personal);
const accFeatures = acc(preds.features);
const accStylometry = acc(preds.stylometry);
const accSignature = acc(preds.signature);
const accFused = acc(preds.fused);
const sigFeaturesVsTfidf = permutationTestPaired(preds.features, preds.tfidf, truths);
const sigStylometryVsTfidf = permutationTestPaired(preds.stylometry, preds.tfidf, truths);
const sigSignatureVsTfidf = permutationTestPaired(preds.signature, preds.tfidf, truths);
const sigFusedVsTfidf = permutationTestPaired(preds.fused, preds.tfidf, truths);
const sigPersonalVsTfidf = permutationTestPaired(preds.personal, preds.tfidf, truths);

const lines = [];
lines.push('# 作者识别 v2（真实 JS 签名 + 置换检验）');
lines.push('');
lines.push('> 语料：9 类单篇文本 → 滑窗切块（80/40）→ 60/40 × 12 轮 → 最近质心/最大似然分类。');
lines.push('> 基线：字符二元组 TF-IDF + 余弦。本系统：个人 n-gram 似然 + 12 维特征的文本子集。');
lines.push('> 诚实边界：同文切块高估准确率；本报告不用于"宣称超基线"，仅定位差距与显著性。');
lines.push('');
lines.push('| 路线 | 准确率 | vs TF-IDF 差值 | 置换 p |');
lines.push('| --- | --- | --- | --- |');
lines.push(`| TF-IDF 基线 | ${(accTfidf * 100).toFixed(1)}% | — | — |`);
lines.push(`| 个人 n-gram（似然） | ${(accPersonal * 100).toFixed(1)}% | ${((accPersonal - accTfidf) * 100).toFixed(1)}% | ${sigPersonalVsTfidf.pValue} |`);
lines.push(`| 文本特征（5 维，最近质心） | ${(accFeatures * 100).toFixed(1)}% | ${((accFeatures - accTfidf) * 100).toFixed(1)}% | ${sigFeaturesVsTfidf.pValue} |`);
lines.push(`| 文体计量（功能词+标点） | ${(accStylometry * 100).toFixed(1)}% | ${((accStylometry - accTfidf) * 100).toFixed(1)}% | ${sigStylometryVsTfidf.pValue} |`);
lines.push(`| 签名（n-gram + 文体计量） | ${(accSignature * 100).toFixed(1)}% | ${((accSignature - accTfidf) * 100).toFixed(1)}% | ${sigSignatureVsTfidf.pValue} |`);
lines.push(`| 融合（n-gram + 特征） | ${(accFused * 100).toFixed(1)}% | ${((accFused - accTfidf) * 100).toFixed(1)}% | ${sigFusedVsTfidf.pValue} |`);
lines.push('');
lines.push(`置换检验（融合 vs 基线）：不一致样本 ${sigFusedVsTfidf.discordant}，p=${sigFusedVsTfidf.pValue}${sigFusedVsTfidf.pValue < 0.05 ? '（显著）' : '（未达显著）'}`);
lines.push('');
lines.push('结论：以当前单篇合成语料，真实 JS 签名的判别力尚未显著超越 TF-IDF；这是 v1.6 要攻克的硬指标。');

const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'docs', 'competition', 'AUTHOR-ID-v2.md');
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\nsaved → ${outFile}`);
