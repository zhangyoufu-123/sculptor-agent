// 风格评估闭环（Style Fidelity Eval）：回答一个此前从没回答过的问题——"这篇像不像这个作者本人"。
// 参照系不是范文、不是通用审美，而是作者自己的旧稿样本 + 亲手修改对 + 高置信风格维度
// （参考 EMNLP 2025《Catch Me If You Can? Not Yet》与 WritingPreferenceBench 的偏好对比思路：
// 风格相似度必须拿作者本人的文字当锚点，只评"好不好"不评"像不像"等于没评）。
// 流程：写作/红队之后运行 → LLM 逐句对照打分 → 失败用确定性统计兜底（环节永不缺席）
// → 结果追加 vault/style-eval.jsonl → 低分时把漂移证据写回风格档案（只加证据、不覆盖维度值）。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { audit } from './redteam.js';

const EVAL_DIMS = [
  'temperature',
  'sentencePreference',
  'modifierDensity',
  'languageRegister',
  'emotionalSpectrum',
  'narrativePerspective',
  'imageryTendency',
  'rhythm',
  'rhetoricalDevices',
  'dialogueRatio',
  'timeHandling',
  'endingPattern',
  'criticalStance',
  'vocabularyCharacter',
];

const FIX_THRESHOLD = 0.62; // LLM 评估低于此分且模式为 llm 时，导演触发一轮针对性修订

/** 参照系语料：旧稿样本 + 亲手修改对 + 高置信维度。无任何参照时 hasRef=false。 */
function loadCorpus(workspace) {
  const vault = path.join(workspace, 'vault');
  const samples = [];
  const samplesDir = path.join(vault, 'style-samples');
  try {
    for (const f of fs.readdirSync(samplesDir).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(samplesDir, f), 'utf8').trim();
      if (text.length >= 40) samples.push({ source: f, text: text.slice(0, 3000) });
    }
  } catch {}
  const edits = [];
  try {
    for (const line of fs.readFileSync(path.join(vault, 'edits.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.changed || e.original) edits.push(e);
    }
  } catch {}
  let dims = {};
  try {
    const obj = ws.readJson(path.join(vault, 'write-style.json'));
    dims = Object.entries(obj.dimensions || {})
      .filter(([, d]) => d && (d.confidence || 0) >= 0.5 && d.value)
      .reduce((acc, [k, d]) => ({ ...acc, [k]: d }), {});
  } catch {}
  return {
    samples,
    edits,
    dims,
    hasRef: samples.length > 0 || edits.length > 0 || Object.keys(dims).length > 0,
  };
}

function sentences(text) {
  return String(text || '')
    .replace(/^#+\s*.*$/gm, '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim().replace(/\s+/g, ''))
    .filter((s) => s.length >= 4);
}

function bigrams(text) {
  const chars = String(text || '')
    .toLowerCase()
    .replace(/[\s\d]+/g, '')
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-z]/g, '');
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(g)) out.add(g);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 确定性兜底评估：词汇重叠、句长分布、反 AI 黑名单。LLM 不可用时保证环节不缺席。 */
function deterministicEval(text, corpus) {
  const rep = audit(text);
  const draftSents = sentences(text);
  const draftLen = draftSents.map((s) => [...s].length);
  const avgD = draftLen.reduce((a, b) => a + b, 0) / Math.max(1, draftLen.length);
  const refText = [
    ...corpus.samples.map((s) => s.text),
    ...corpus.edits.map((e) => `${e.original} ${e.changed} ${e.intent}`),
  ].join(' ');
  const refSents = sentences(refText);
  const refLen = refSents.map((s) => [...s].length);
  const avgR = refLen.reduce((a, b) => a + b, 0) / Math.max(1, refLen.length);
  const lexical = corpus.samples.length
    ? corpus.samples.reduce(
        (s, x) => s + jaccard(bigrams(text), bigrams(x.text)),
        0,
      ) / corpus.samples.length
    : 0.3; // 无样本时给中性分，不因缺参照系冤枉作者
  const lenFit = 1 - Math.min(1, Math.abs(avgD - avgR) / Math.max(18, avgR));
  const bannedPenalty = Math.min(0.35, rep.blacklistHits.length * 0.1);
  const metaphorPenalty = Math.min(0.2, rep.repeatedMetaphors.length * 0.1);
  const score = Math.max(
    0.05,
    Math.min(0.98, 0.35 + 0.4 * lexical + 0.25 * lenFit - bannedPenalty - metaphorPenalty),
  );
  const drifted = [];
  if (rep.blacklistHits.length) {
    drifted.push({
      at: rep.blacklistHits[0].context.slice(0, 30),
      note: `出现 AI 套话「${rep.blacklistHits[0].phrase}」`,
    });
  }
  if (rep.repeatedMetaphors.length) {
    drifted.push({ at: '', note: `重复比喻「${rep.repeatedMetaphors[0].vehicle}」跨句出现` });
  }
  const advice = [];
  if (rep.blacklistHits.length) advice.push('清掉黑名单套话，换成作者自己的说法');
  if (rep.repeatedMetaphors.length) advice.push('保留最有力的那一次比喻，其余删掉或换表达');
  if (corpus.samples.length && lexical < 0.18)
    advice.push('多用作者旧稿里的词汇与物象，别滑向通用范文腔');
  return {
    score: Number(score.toFixed(2)),
    dims: {},
    matched: corpus.samples.length
      ? [{ at: draftSents[0] || '', note: '整体与作者参照语料有词汇重叠' }]
      : [],
    drifted,
    advice,
    mode: 'fallback',
  };
}

const EVAL_PROMPT = (ctx) => `你是 Stylotrace 的风格保真评估师。你的任务只有一件：判断这篇文字**像不像这个作者本人**——不是好不好，不是对不对，是像不像。

【作者参照系（全部来自作者本人的旧稿/亲手修改/风格档案）】
${ctx.reference}

【草稿】
${ctx.text}

做法：
1. 逐句对照参照系，找出"最像作者本人"的句子（matched）和"滑回 AI 腔/范文腔"的句子（drifted），at 必须引用原文片段（10-30 字），note 写具体原因（词汇？句长？物象？语气？）。
2. 按 14 个维度给出 0-1 的"像作者"分数（0=完全是模板腔，1=完全是这个人写的）。参照系不足的维度给 0 并写 note 说明。
3. advice 给 2-4 条可执行修订（具体到"把哪句换成什么方向"，供 point-edit/restyle 直接消费）。

输出严格 JSON：
{"score":0.68,"dims":{"temperature":{"score":0.6,"note":""}},"matched":[{"at":"原文片段","note":"为什么像"}],"drifted":[{"at":"原文片段","note":"为什么不像"}],"advice":[""]}`;

function renderReference(corpus) {
  const out = [];
  for (const s of corpus.samples.slice(0, 3))
    out.push(`— 旧稿《${s.source}》—\n${s.text.slice(0, 600)}`);
  for (const e of corpus.edits.slice(0, 3))
    out.push(`— 作者亲手修改 —\n原文：${e.original}\n修改：${e.changed}${e.intent ? `\n意图：${e.intent}` : ''}`);
  const dims = Object.entries(corpus.dims).map(
    ([k, d]) => `${k}: ${d.value}（${(d.confidence * 100).toFixed(0)}%）`,
  );
  if (dims.length) out.push(`— 高置信风格维度 —\n${dims.join('\n')}`);
  return out.join('\n\n') || '（无）';
}

async function llmEval(cfg, text, corpus) {
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是风格保真评估师，输出严格 JSON。' },
      { role: 'user', content: EVAL_PROMPT({ reference: renderReference(corpus), text }) },
    ],
    { json: true, temperature: 0.25, maxTokens: 2600 },
  );
  const r = parseJsonContent(content, '风格评估');
  const score = Number(r.score);
  if (!Number.isFinite(score)) throw new Error('评估缺少 score');
  const dims = {};
  for (const d of EVAL_DIMS) {
    const x = r.dims?.[d];
    dims[d] = x ? { score: Number(x.score) || 0, note: String(x.note || '') } : { score: 0, note: '' };
  }
  return {
    score: Math.max(0, Math.min(1, score)),
    dims,
    matched: Array.isArray(r.matched) ? r.matched.slice(0, 6) : [],
    drifted: Array.isArray(r.drifted) ? r.drifted.slice(0, 6) : [],
    advice: Array.isArray(r.advice) ? r.advice.slice(0, 5) : [],
    mode: 'llm',
  };
}

/**
 * 风格保真评估主入口。
 * @param file 指定要评估的 md；缺省读工作区 draft.md。
 */
export async function evaluateStyleFidelity(cfg, wsDir, { file = null } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) {
    throw new Error(`找不到要评估的文稿: ${draftFile}（先 stylotrace write，或 --file 指定）`);
  }
  const text = fs.readFileSync(draftFile, 'utf8').trim();
  if ((text.match(/[\u4e00-\u9fff]/g) || []).length < 60)
    throw new Error('文稿太短（<60 个汉字），暂无法做有意义的风格保真评估');
  const corpus = loadCorpus(workspace);
  let body;
  if (corpus.hasRef && cfg.apiKey) {
    try {
      body = await llmEval(cfg, text, corpus);
      // 集成评分（arxiv 2508.06374：集成指标优于单一指标）：LLM 判断为主、确定性统计为佐证。
      const deter = deterministicEval(text, corpus);
      body.score = Number((0.82 * body.score + 0.18 * deter.score).toFixed(2));
      body.llmScore = body.score;
    } catch {
      body = deterministicEval(text, corpus);
    }
  } else {
    body = {
      ...deterministicEval(text, corpus),
      score: null,
      noReference: true,
      advice: ['工作区还没有作者旧稿/修改记录——先贴一段同文体旧稿或做几次 point-edit，风格保真评估才能对照本人打分'],
    };
  }
  const report = {
    file: draftFile,
    ts: ws.nowIso(),
    hasReference: corpus.hasRef,
    mode: body.noReference ? 'no-reference' : body.mode,
    score: body.score,
    llmScore: body.llmScore,
    dims: body.dims,
    matched: body.matched,
    drifted: body.drifted,
    advice: body.advice,
    needsFix: body.mode === 'llm' && body.score < FIX_THRESHOLD,
  };
  const evalFile = path.join(workspace, 'vault', 'style-eval.jsonl');
  fs.mkdirSync(path.dirname(evalFile), { recursive: true });
  fs.appendFileSync(
    evalFile,
    JSON.stringify({
      ts: report.ts,
      file: report.file,
      mode: report.mode,
      score: report.score,
      dims: report.dims,
      drifted: report.drifted.map((d) => d.note),
    }) + '\n',
  );
  ws.logContext(
    workspace,
    'style-eval',
    `风格保真评估：${report.score === null ? '无参照系' : `${report.score}（${report.mode}）`}，漂移 ${report.drifted.length} 处`,
  );
  return report;
}

/** 把低分评估的漂移证据写回风格档案（只加 evidence，绝不覆盖维度值/置信度）。 */
export function applyEvalFeedback(workspace, report) {
  if (!report || report.score === null || report.score >= FIX_THRESHOLD) {
    return { applied: 0 };
  }
  const file = path.join(workspace, 'vault', 'write-style.json');
  const obj = ws.readJson(file);
  obj.learnedFrom = obj.learnedFrom || {};
  obj.learnedFrom.styleEvals = (obj.learnedFrom.styleEvals || 0) + 1;
  let applied = 0;
  const dimNames = Object.entries(report.dims || {})
    .filter(([, d]) => d && d.score !== undefined && d.score < 0.5 && d.note)
    .map(([k]) => k);
  for (const dimName of dimNames.slice(0, 3)) {
    const dim = obj.dimensions?.[dimName];
    if (!dim) continue;
    dim.evidence = dim.evidence || [];
    const ev = `风格保真评估：${report.dims[dimName].note}`;
    if (!dim.evidence.includes(ev)) dim.evidence.push(ev.slice(0, 120));
    applied += 1;
  }
  if (applied) {
    obj.lastUpdated = ws.nowIso();
    ws.writeJson(file, obj);
  }
  return { applied };
}

/** 人类可读的风格保真评估面板。 */
export function renderStyleEval(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Stylotrace 风格保真评估 · 这篇像不像你', line);
  if (!report.hasReference) {
    out.push('（工作区还没有作者参照语料——旧稿样本或亲手修改记录）');
    out.push(report.advice[0] || '先贴一段同文体旧稿，或做几次 point-edit 建立参照系。');
    out.push(line);
    return out.join('\n');
  }
  out.push(
    `保真度: ${report.score === null ? '（未打分）' : `${(report.score * 100).toFixed(0)} 分`}（${report.mode === 'llm' ? '逐句对照评估' : '确定性统计兜底'}）`,
  );
  if (report.mode === 'llm' && Object.keys(report.dims).length) {
    const low = Object.entries(report.dims)
      .filter(([, d]) => d && d.score < 0.5 && d.note)
      .slice(0, 4);
    if (low.length) {
      out.push('最容易露馅的维度:');
      for (const [k, d] of low) out.push(`  · ${k} ${(d.score * 100).toFixed(0)}分 — ${d.note}`);
    }
  }
  if (report.matched?.length) {
    out.push('最像你的句子:');
    for (const m of report.matched.slice(0, 3))
      out.push(`  · 「${m.at}」${m.note ? `（${m.note}）` : ''}`);
  }
  if (report.drifted?.length) {
    out.push('滑回 AI 腔的地方:');
    for (const d of report.drifted.slice(0, 4))
      out.push(`  · 「${d.at}」${d.note ? `（${d.note}）` : ''}`);
  }
  if (report.advice?.length) {
    out.push('修订建议:');
    for (const a of report.advice) out.push(`  · ${a}`);
  }
  out.push(line);
  return out.join('\n');
}
