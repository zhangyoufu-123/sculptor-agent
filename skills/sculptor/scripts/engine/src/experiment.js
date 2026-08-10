// 实验与数据采集引擎（v0.24）：支撑研究论文第 5.3 节的三类实证研究。
//   实验一 风格保真度对照：通用 LLM（baseline）vs SCULPTOR 风格注入（variant），
//          客观人类化指标 + 随机顺序 A/B 盲评对；
//   实验二 消融：依次关闭 styleShot/persona/knowledge/styleAdapter，量化边际贡献；
//   实验三 用户体验：问卷模板 + 结构化记录。
// 数据采集：作者语料包（旧稿样本 / 修改记录 / 用户话语 / 风格向量摘要 / 知识库）。
// 原则：LLM 不可用时确定性降级，绝不中断流程。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry } from './llm.js';
import { audit } from './redteam.js';
import { perplexityProxy } from './style-vector.js';
import { extractStyleSignals } from './style.js';
import { collectUserUtterances } from './style.js';
import { vectorSummary } from './style-vector.js';
import { listEntries } from './knowledge.js';
import { BASELINE_PROMPT, VARIANT_PROMPT } from './prompts.js';
import * as ws from './workspace.js';

const EXP_DIR = 'experiments';

function expDir(workspace) {
  return path.join(workspace, 'vault', EXP_DIR);
}

// ── 客观人类化指标（复用红队审计 + L3 困惑度签名）────────
export function humanMetrics(text) {
  const a = audit(text);
  const p = perplexityProxy(text);
  return {
    sentenceLengthStddev: a.metrics.sentenceLengthStddev || 0,
    paragraphCv: a.metrics.paragraphCv || 0,
    sentenceStartDedup: a.metrics.sentenceStartDedup || 0,
    bigramTtr: a.metrics.bigramTtr || 0,
    perplexity: p.perplexity,
    blacklistHits: a.blacklistHits.length,
    repeatedMetaphors: a.repeatedMetaphors.length,
    repeatedPatterns: a.repeatedPatterns.length,
    passed: a.passed,
  };
}

/** 人类化指标人类可读渲染。 */
export function renderHumanMetrics(m) {
  if (!m) return '（无指标）';
  return [
    `句长标准差 ${m.sentenceLengthStddev}（真人参考 ≥8）`,
    `段落变异系数 ${m.paragraphCv}（真人参考 ≥0.35）`,
    `句首去重率 ${m.sentenceStartDedup}%（真人参考 ≥75%）`,
    `词汇二元 TTR ${m.bigramTtr}（真人参考 ≥0.70）`,
    `困惑度签名 ${m.perplexity}`,
    `黑名单 ${m.blacklistHits} · 重复比喻 ${m.repeatedMetaphors} · 句式复用 ${m.repeatedPatterns} · ${m.passed ? '通过' : '未通过'}`,
  ].join('\n');
}

// ── 作者语料采集 ────────────────────────────────────────
/**
 * 采集作者的完整语料包：风格样本（≥80 字旧稿）、修改记录、对话用户话语、
 * 知识库、写作库、风格向量摘要。输出结构化对象，便于实验/向量分析/侧写。
 */
export function collectAuthorCorpus(workspace) {
  const vault = path.join(workspace, 'vault');
  const samples = [];
  try {
    for (const f of fs.readdirSync(path.join(vault, 'style-samples')).filter((x) => x.endsWith('.md'))) {
      samples.push(fs.readFileSync(path.join(vault, 'style-samples', f), 'utf8').trim());
    }
  } catch {}
  let edits = [];
  try {
    edits = fs
      .readFileSync(path.join(vault, 'edits.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  let libraryPieces = 0;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(vault, 'library', 'index.json'), 'utf8'));
    libraryPieces = (idx.pieces || []).length;
  } catch {}
  const knowledge = listEntries(workspace);
  const utterances = collectUserUtterances(workspace, { max: 20 });
  let vector = null;
  try {
    vector = vectorSummary(workspace);
  } catch {}
  return {
    collectedAt: ws.nowIso(),
    samples,
    edits: edits.slice(-30),
    utterances,
    knowledge: knowledge.map((k) => ({ title: k.title, type: k.type, note: k.note })),
    libraryPieces,
    vector: vector
      ? {
          mode: vector.mode,
          signals: vector.signals,
          topDims: (vector.topDims || []).slice(0, 8),
        }
      : null,
  };
}

/** 语料包统计（供报告/比赛材料引用）。 */
export function corpusStats(corpus) {
  return {
    samples: corpus.samples.length,
    edits: corpus.edits.length,
    utterances: corpus.utterances.length,
    knowledge: corpus.knowledge.length,
    libraryPieces: corpus.libraryPieces,
    hasVector: Boolean(corpus.vector),
  };
}

// ── 对照组 / 实验组生成 ────────────────────────────────
/**
 * 对照组：通用 LLM 直接生成（无风格/知识注入）。
 */
export async function baselineText(cfg, { topic, genre = '散文', targetWords = 800 }) {
  if (!cfg?.apiKey) return { ok: false, skipped: true, hint: '未配置 LLM 密钥，跳过对照组' };
  const text = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是一名写作者。' },
      { role: 'user', content: BASELINE_PROMPT({ topic, genre, targetWords }) },
    ],
    { temperature: 0.85, maxTokens: 3000 },
  );
  return { ok: true, text: text.trim() };
}

/**
 * 实验组：带作者风格注入生成。ablate 可关闭部分注入做消融。
 * 作者样本缺失时退化为对照组（保证可比性）。
 */
export async function sculptorVariant(
  cfg,
  { topic, genre = '散文', targetWords = 800, sample = '', ablate = [] } = {},
) {
  if (!cfg?.apiKey) return { ok: false, skipped: true, hint: '未配置 LLM 密钥，跳过实验组' };
  const signals = sample ? extractStyleSignals(sample) : { dims: {} };
  const writeStyle =
    ablate.includes('styleAdapter') || ablate.includes('styleShot')
      ? ''
      : Object.entries(signals.dims || {})
          .filter(([, v]) => v && v.value)
          .map(([k, v]) => `${k}: ${v.value}`)
          .join('\n');
  const styleShot =
    ablate.includes('styleShot') || !sample
      ? null
      : { samples: [{ text: sample.slice(0, 500) }], edits: [], vectorDims: [] };
  const text = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是人类风格的写作者，输出正文。' },
      {
        role: 'user',
        content: VARIANT_PROMPT({
          topic,
          genre,
          targetWords,
          writeStyle: ablate.includes('styleAdapter') ? '' : writeStyle,
          styleShot,
          persona: ablate.includes('persona') ? '' : '（实验注入：作者风格侧写摘要）',
          knowledgeBrief: ablate.includes('knowledge')
            ? ''
            : '（实验注入：作者个人知识库相关条目）',
        }),
      },
    ],
    { temperature: 0.85, maxTokens: 3000 },
  );
  return { ok: true, text: text.trim() };
}

// ── 对照实验批跑 ────────────────────────────────────────
/**
 * 实验一：对每位作者跑 baseline + variant，输出指标对比与随机顺序盲评对。
 * @param cfg LLM 配置
 * @param opts { topic, genre, targetWords, authors: [{name, sample}], workspace?, ablate? }
 * @returns { ok, results, blind, report, dir }
 */
export async function runPairExperiment(cfg, opts = {}) {
  const topic = String(opts.topic || '').trim();
  const authors = Array.isArray(opts.authors) ? opts.authors : [];
  if (!topic || !authors.length) return { ok: false, hint: '需要 --topic 与至少一位作者样本' };
  const workspace = opts.workspace || process.env.SCULPTOR_WORKSPACE || '.';
  const dir = path.join(expDir(workspace), `run-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const results = [];
  const blind = [];
  for (const au of authors) {
    const name = String(au.name || '作者').trim();
    const b = await baselineText(cfg, { topic, genre: opts.genre, targetWords: opts.targetWords });
    const v = await sculptorVariant(cfg, {
      topic,
      genre: opts.genre,
      targetWords: opts.targetWords,
      sample: au.sample || '',
      ablate: opts.ablate || [],
    });
    if (!b.ok || !v.ok) {
      results.push({ author: name, skipped: true, hint: b.hint || v.hint });
      continue;
    }
    const mb = humanMetrics(b.text);
    const mv = humanMetrics(v.text);
    const order = Math.random() < 0.5;
    const pair = {
      author: name,
      A: order ? { source: 'baseline', text: b.text } : { source: 'variant', text: v.text },
      B: order ? { source: 'variant', text: v.text } : { source: 'baseline', text: b.text },
    };
    results.push({
      author: name,
      baselineChars: b.text.length,
      variantChars: v.text.length,
      baseline: mb,
      variant: mv,
    });
    blind.push(pair);
  }
  const report = buildExperimentReport(results);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(dir, 'blind.json'), JSON.stringify(blind, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(dir, 'report.md'), report + '\n', { mode: 0o600 });
  ws.logContext(workspace, 'experiment', `对照实验完成：${results.length} 位作者 → ${dir}`);
  return { ok: true, results, blind, report, dir };
}

/** 汇总报告：均值对比、指标改进方向、盲评说明。 */
export function buildExperimentReport(results) {
  const rows = results.filter((r) => !r.skipped);
  if (!rows.length) return '（无可对比结果）';
  const keys = ['sentenceLengthStddev', 'paragraphCv', 'sentenceStartDedup', 'bigramTtr'];
  const lines = ['# 对照实验结果', '', `样本数：${rows.length} 位作者`, ''];
  lines.push('| 指标 | baseline 均值 | variant 均值 | 变化 |', '| --- | --- | --- | --- |');
  for (const k of keys) {
    const mb = rows.reduce((s, r) => s + (r.baseline?.[k] || 0), 0) / rows.length;
    const mv = rows.reduce((s, r) => s + (r.variant?.[k] || 0), 0) / rows.length;
    const delta = mv - mb;
    lines.push(`| ${k} | ${mb.toFixed(2)} | ${mv.toFixed(2)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} |`);
  }
  lines.push(
    '',
    '> 指标方向说明：句长标准差/段落变异系数/句首去重率/TTR 越高通常越接近真人写作。',
    '> 盲评：见 blind.json——每对 A/B 顺序已随机化，请 3 名以上盲评人独立选择"哪篇更像该作者本人"。',
    '',
    '## 逐作者明细',
  );
  for (const r of rows) {
    lines.push(`- ${r.author}：baseline ${r.baselineChars} 字 / variant ${r.variantChars} 字`);
    lines.push(`  - baseline：${renderHumanMetrics(r.baseline).replace(/\n/g, '；')}`);
    lines.push(`  - variant ：${renderHumanMetrics(r.variant).replace(/\n/g, '；')}`);
  }
  return lines.join('\n');
}

// ── 消融实验 ────────────────────────────────────────────
/**
 * 实验二：同一作者样本，依次关闭各注入模块，输出各变体指标对比。
 */
export async function runAblation(cfg, opts = {}) {
  const topic = String(opts.topic || '').trim();
  const sample = String(opts.sample || '').trim();
  if (!topic || !sample) return { ok: false, hint: '需要 --topic 与作者样本（--author 文件或样本文本）' };
  const variants = [];
  const configs = [
    { label: '完整（全注入）', ablate: [] },
    { label: '去风格少样本', ablate: ['styleShot'] },
    { label: '去风格侧写', ablate: ['persona'] },
    { label: '去知识库', ablate: ['knowledge'] },
    { label: '去风格档案', ablate: ['styleAdapter'] },
  ];
  for (const c of configs) {
    const r = await sculptorVariant(cfg, {
      topic,
      genre: opts.genre,
      targetWords: opts.targetWords,
      sample,
      ablate: c.ablate,
    });
    variants.push({
      label: c.label,
      ablate: c.ablate,
      ok: r.ok,
      metrics: r.ok ? humanMetrics(r.text) : null,
      chars: r.ok ? r.text.length : 0,
    });
  }
  const dir = path.join(expDir(opts.workspace || process.env.SCULPTOR_WORKSPACE || '.'), `ablation-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ablation.json'), JSON.stringify(variants, null, 2) + '\n', {
    mode: 0o600,
  });
  return { ok: true, variants, dir };
}

// ── 问卷模板（实验三：用户体验 + 盲评）──────────────────
export function userSurveyTemplate() {
  return {
    title: 'Sculptor 写作体验实验问卷',
    sections: [
      {
        name: '盲评（实验一）',
        items: [
          { key: 'author_a_b', type: 'radio', question: '哪一篇更像该作者本人写的？（A/B 二选一，可加一句理由）', options: ['A', 'B', '难以判断'] },
          { key: 'why', type: 'text', question: '你判断的理由（用词/句式/情感/细节，任意一点即可）' },
        ],
      },
      {
        name: '用户体验（实验三）',
        items: [
          { key: 'understand', type: 'scale', question: '系统理解你想法的程度（1-5）', min: 1, max: 5 },
          { key: 'control', type: 'scale', question: '你对成稿的掌控感（1-5：能不能让它改到你要的样子）', min: 1, max: 5 },
          { key: 'satisfaction', type: 'scale', question: '对最终成稿的满意度（1-5）', min: 1, max: 5 },
          { key: 'ai_feel', type: 'scale', question: '成稿的"AI 味"程度（1=几乎没有，5=非常明显）', min: 1, max: 5 },
          { key: 'clarify_rounds', type: 'number', question: '你大约回答了几轮澄清问题？' },
          { key: 'edits', type: 'number', question: '你手动修改了多少处？' },
          { key: 'minutes', type: 'number', question: '完成整篇大约用了多少分钟？' },
          { key: 'open', type: 'text', question: '最想吐槽/最喜欢的一点' },
        ],
      },
    ],
    note: '数据仅用于研究，匿名保存，不用于其他用途。',
  };
}

export { BASELINE_PROMPT, VARIANT_PROMPT };
