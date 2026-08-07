// 风格持续微调基建（Panza 式：<100 样本 + PeFT + RAG）：
//  1) collectStyleCorpus —— 汇总旧稿样本 + 个人写作库 + 亲手修改对（偏好对）；
//  2) buildStyleDataset  —— 生成 Reverse Instructions 式 JSONL 微调数据集（零 LLM，确定性）；
//  3) distillStyleAdapter —— LLM 把全部素材压缩成"风格适配卡"（写作时最高优先级注入，
//     不再靠贴整段旧稿）；失败用确定性统计兜底；
//  4) loadStyleAdapter —— 限量读取适配卡供提示词注入（不污染上下文）；
//  5) submitFineTune —— 配置了 SCULPTOR_FT_ENDPOINT/API_KEY 时上传数据集并创建微调任务；
//     未配置时给出本地 LoRA 训练指引（scripts/finetune/style_lora.py）。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';

/** 汇总风格素材：旧稿样本 + 个人写作库 + 亲手修改对。 */
export function collectStyleCorpus(workspace) {
  const vault = path.join(workspace, 'vault');
  const samples = [];
  const samplesDir = path.join(vault, 'style-samples');
  try {
    for (const f of fs.readdirSync(samplesDir).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(samplesDir, f), 'utf8').trim();
      if (text.length >= 40) samples.push({ source: f, text: text.slice(0, 2500) });
    }
  } catch {}
  const pieces = [];
  const libRoot = path.join(vault, 'library');
  try {
    for (const cat of fs.readdirSync(libRoot)) {
      const catDir = path.join(libRoot, cat);
      if (!fs.statSync(catDir).isDirectory()) continue;
      for (const f of fs.readdirSync(catDir).filter((x) => x.endsWith('.md'))) {
        const raw = fs.readFileSync(path.join(catDir, f), 'utf8');
        const text = raw
          .replace(/^# .*$/m, '')
          .replace(/^[-•] .*$/m, '')
          .trim();
        if (text.length >= 80) pieces.push({ category: cat, source: f, text: text.slice(0, 2500) });
      }
    }
  } catch {}
  const edits = [];
  try {
    for (const line of fs.readFileSync(path.join(vault, 'edits.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.original && e.changed) edits.push(e);
    }
  } catch {}
  return { samples, pieces, edits };
}

/** 生成 Reverse Instructions 式微调数据集（Panza 风格；偏好对来自亲手修改）。 */
export function buildStyleDataset(workspace, { outFile = null } = {}) {
  const c = collectStyleCorpus(workspace);
  const records = [];
  for (const s of c.samples)
    records.push({
      messages: [
        { role: 'user', content: '请用我自己的写作风格写一段（不要解释，直接写）。' },
        { role: 'assistant', content: s.text },
      ],
    });
  for (const p of c.pieces.slice(0, 20))
    records.push({
      messages: [
        {
          role: 'user',
          content: `请用我自己的写作风格写一篇${p.category}类的文字（不要解释，直接写）。`,
        },
        { role: 'assistant', content: p.text },
      ],
    });
  for (const e of c.edits.slice(0, 30))
    records.push({
      messages: [
        { role: 'user', content: `把这句话改得像我会写的（只输出改后版本）：${e.original}` },
        { role: 'assistant', content: e.changed },
      ],
    });
  if (!records.length) {
    throw new Error('没有可用的风格素材：先贴旧稿（style-samples）、归档作品（library）或做 point-edit');
  }
  const file = outFile
    ? path.resolve(outFile)
    : path.join(workspace, 'vault', 'style-adapter-dataset.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const chars = records.reduce(
    (s, r) => s + r.messages.map((m) => m.content.length).reduce((a, b) => a + b, 0),
    0,
  );
  ws.logContext(
    workspace,
    'style-adapter',
    `微调数据集：${records.length} 条（样本 ${c.samples.length}、作品 ${c.pieces.length}、修改对 ${c.edits.length}），${chars} 字 → ${file}`,
  );
  return {
    file,
    records: records.length,
    chars,
    sources: { samples: c.samples.length, pieces: c.pieces.length, edits: c.edits.length },
  };
}

function deterministicAdapter(corpus) {
  const texts = [...corpus.samples.map((s) => s.text), ...corpus.pieces.map((p) => p.text)];
  const all = texts.join(' ');
  const sents = all.split(/[。！？.!?]+/).filter((s) => s.trim().length > 2);
  const lens = sents.map((s) => [...s.trim()].length);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const counts = {};
  for (const w of all.match(/[\u4e00-\u9fff]{2,4}/g) || []) counts[w] = (counts[w] || 0) + 1;
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
  return {
    voice: `句长 ${avg < 18 ? '偏短、利落' : avg > 34 ? '偏长、舒展' : '长短交错'}（平均 ${Math.round(avg)} 字）`,
    rhythm: avg < 18 ? '短句连排、节奏快' : avg > 34 ? '长句为主、气息长' : '长短错落',
    vocabulary: `高频词：${top.join('、') || '（未统计到）'}`,
    imagery: (all.match(/像|仿佛|如同/g) || []).length
      ? '善用比喻意象承载情感'
      : '意象使用克制，偏直陈',
    sentencePatterns: ['长短句交错', '关键处设问/反问'],
    doNot: ['AI 套话（在当今社会/总而言之/赋能…）', '同一个比喻重复使用', '空泛口号'],
    representativeSentence: sents[0] ? sents[0].trim().slice(0, 80) : '',
    editPairs: corpus.edits.slice(0, 3).map((e) => ({ original: e.original, changed: e.changed })),
    mode: 'fallback',
  };
}

function adapterPromptArgs(ctx) {
  const corpus = renderCorpusForAdapter(ctx.corpus);
  return `你是 Sculptor 的风格适配师。把下面这位作者的素材压缩成一张"风格适配卡"——让任何写手只看这张卡，就能写出像这位作者的文字。卡要具体到可执行，不要泛泛而谈。

【作者素材】
${corpus}

输出严格 JSON（全部用中文，总长 <= 600 字）：
{"voice":"语气与句长（具体）","rhythm":"节奏习惯（具体）","vocabulary":"用词与高频词","imagery":"意象与比喻习惯","sentencePatterns":["惯用句式/开口方式"],"doNot":["这位作者绝不会写的（<=4条）"],"representativeSentence":"最能代表他的一句原文","editPairs":[{"original":"","changed":""}]}`;
}

function renderCorpusForAdapter(corpus) {
  const out = [];
  for (const s of corpus.samples.slice(0, 3))
    out.push(`— 旧稿《${s.source}》—\n${s.text.slice(0, 700)}`);
  for (const p of corpus.pieces.slice(0, 2))
    out.push(`— 作品（${p.category}）—\n${p.text.slice(0, 500)}`);
  for (const e of corpus.edits.slice(0, 4))
    out.push(`— 亲手修改 —\n原文：${e.original}\n改后：${e.changed}`);
  return out.join('\n\n') || '（无）';
}

/** 把全部素材压缩成"风格适配卡"，落 vault/style-adapter.json + style-adapter.md。 */
export async function distillStyleAdapter(cfg, workspace) {
  const c = collectStyleCorpus(workspace);
  if (!c.samples.length && !c.pieces.length && !c.edits.length) {
    return { distilled: false, reason: 'no-corpus' };
  }
  let card;
  if (cfg.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是风格适配师，输出严格 JSON。' },
          { role: 'user', content: adapterPromptArgs({ corpus: c }) },
        ],
        { json: true, temperature: 0.3, maxTokens: 1500 },
      );
      const r = parseJsonContent(content, '风格适配卡');
      card = {
        voice: String(r.voice || ''),
        rhythm: String(r.rhythm || ''),
        vocabulary: String(r.vocabulary || ''),
        imagery: String(r.imagery || ''),
        sentencePatterns: Array.isArray(r.sentencePatterns) ? r.sentencePatterns.slice(0, 4) : [],
        doNot: Array.isArray(r.doNot) ? r.doNot.slice(0, 4) : [],
        representativeSentence: String(r.representativeSentence || ''),
        editPairs: Array.isArray(r.editPairs) ? r.editPairs.slice(0, 3) : [],
        mode: 'llm',
      };
    } catch {
      card = deterministicAdapter(c);
    }
  } else {
    card = deterministicAdapter(c);
  }
  card.distilledAt = ws.nowIso();
  card.sources = { samples: c.samples.length, pieces: c.pieces.length, edits: c.edits.length };
  const jsonFile = path.join(workspace, 'vault', 'style-adapter.json');
  ws.writeJson(jsonFile, card);
  const md = renderAdapterCard(card);
  const mdFile = path.join(workspace, 'vault', 'style-adapter.md');
  fs.writeFileSync(mdFile, md + '\n');
  ws.logContext(
    workspace,
    'style-adapter',
    `风格适配卡已蒸馏（${card.mode}）：${card.sources.samples} 样本 / ${card.sources.pieces} 作品 / ${card.sources.edits} 修改对 → ${mdFile}`,
  );
  return { distilled: true, card, jsonFile, mdFile };
}

export function renderAdapterCard(card) {
  return [
    '# 风格适配卡（作者本人 · 最高优先级）',
    '',
    `## 语气\n${card.voice || ''}`,
    '',
    `## 节奏\n${card.rhythm || ''}`,
    '',
    `## 用词\n${card.vocabulary || ''}`,
    '',
    `## 意象\n${card.imagery || ''}`,
    '',
    `## 惯用句式\n${(card.sentencePatterns || []).map((s) => `- ${s}`).join('\n') || '（无）'}`,
    '',
    `## 绝不会写\n${(card.doNot || []).map((s) => `- ${s}`).join('\n') || '（无）'}`,
    '',
    `## 代表句\n> ${card.representativeSentence || ''}`,
    '',
    ...(card.editPairs || []).map(
      (e) => `## 亲手修改对\n原文：${e.original}\n改后：${e.changed}`,
    ),
    '',
    `（蒸馏时间 ${card.distilledAt || ''} · 来源 ${card.sources?.samples || 0} 样本 / ${card.sources?.pieces || 0} 作品 / ${card.sources?.edits || 0} 修改对）`,
  ].join('\n');
}

/** 限量读取风格适配卡（写作/大纲/重写时注入；无卡返回空串）。 */
export function loadStyleAdapter(workspace, opts = {}) {
  const limit = typeof opts === 'number' ? opts : opts.limit ?? 700;
  const file = path.join(workspace, 'vault', 'style-adapter.md');
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '';
  }
}

/**
 * 提交微调任务（OpenAI 兼容 /files + /fine_tuning/jobs）。
 * 未配置 SCULPTOR_FT_ENDPOINT / SCULPTOR_FT_API_KEY 时返回指引（本地 LoRA 脚本路径）。
 */
export async function submitFineTune(cfg, workspace, { file = null, model = null } = {}) {
  const ds = file ? { file: path.resolve(file), records: 0 } : buildStyleDataset(workspace);
  if (!cfg.fineTuneEndpoint || !cfg.fineTuneApiKey) {
    return {
      submitted: false,
      dataset: ds.file,
      hint:
        '未配置微调端点。数据集已生成，两条路可选：\n' +
        `  1) 本地 LoRA（Panza 式，<100 样本）：python3 scripts/finetune/style_lora.py --dataset ${ds.file} --model Qwen/Qwen2.5-1.5B-Instruct --out ./lora-out\n` +
        '  2) API 微调：设置 SCULPTOR_FT_ENDPOINT 与 SCULPTOR_FT_API_KEY 后重跑（上传 /files → 创建 /fine_tuning/jobs）。',
    };
  }
  const content = fs.readFileSync(ds.file, 'utf8');
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/jsonl' }), 'style-dataset.jsonl');
  form.append('purpose', 'fine-tune');
  const headers = { Authorization: `Bearer ${cfg.fineTuneApiKey}` };
  const upRes = await fetch(`${cfg.fineTuneEndpoint}/files`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!upRes.ok) {
    throw new Error(`上传微调文件失败: ${upRes.status} ${(await upRes.text()).slice(0, 200)}`);
  }
  const up = await upRes.json();
  const fileId = up.id;
  const jobRes = await fetch(`${cfg.fineTuneEndpoint}/fine_tuning/jobs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || cfg.model, training_file: fileId }),
  });
  if (!jobRes.ok) {
    throw new Error(`创建微调任务失败: ${jobRes.status} ${(await jobRes.text()).slice(0, 200)}`);
  }
  const job = await jobRes.json();
  ws.logContext(
    workspace,
    'style-adapter',
    `微调任务已提交：${job.id || job.job_id || ''}（文件 ${fileId}）`,
  );
  return { submitted: true, fileId, jobId: job.id || job.job_id || '', dataset: ds.file };
}

/** 状态摘要：素材量 + 适配卡是否存在 + 数据集是否已生成。 */
export function adapterStatus(workspace) {
  const c = collectStyleCorpus(workspace);
  return {
    samples: c.samples.length,
    pieces: c.pieces.length,
    edits: c.edits.length,
    hasAdapter: fs.existsSync(path.join(workspace, 'vault', 'style-adapter.md')),
    hasDataset: fs.existsSync(path.join(workspace, 'vault', 'style-adapter-dataset.jsonl')),
  };
}
