// 风格全程被动采集：用户的每一句话（对话语气、素材、修改理由）都是风格信号。
// 轻量确定性提取（无 LLM 开销），累积进 write-style.json 的置信度。
// 每个信号都带 evidence，让"风格被读到了"这件事对用户可见、可查。
import path from 'node:path';
import fs from 'node:fs';
import * as ws from './workspace.js';
import { STYLE_EXTRACTION_PROMPT } from './prompts.js';
import { chatWithRetry, parseJsonContent } from './llm.js';

export function extractStyleSignals(text) {
  const t = String(text || '').trim();
  const out = { write: {}, read: {} };
  if (!t) return out;
  const sentences = t
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lens = sentences.map((s) => [...s].length);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const shortRun = sentences.filter((s) => [...s].length <= 10).length;
  const push = (dim, value, delta, evidence) => {
    out.write[dim] = { value, delta, evidence };
  };
  const pushRead = (dim, value, delta, evidence) => {
    out.read[dim] = { value, delta, evidence };
  };
  if (sentences.length >= 2) {
    if (avg < 18) push('sentencePreference', '短句为主', 0.04, '对话/素材句长偏短');
    else if (avg > 40) push('sentencePreference', '长句为主', 0.04, '对话/素材句长偏长');
    if (sentences.length >= 3 && shortRun >= 2)
      push('rhythm', '短句连排、节奏快', 0.03, '出现连续短句');
  }
  if (/！|!/.test(t)) push('temperature', '情绪外放', 0.03, '使用感叹号');
  if (/[？?]/.test(t)) push('rhetoricalDevices', '善用设问/反问', 0.03, '使用问句');
  if (/不是[^，。]*而是|与其[^，。]*不如|虽然[^，。]*但是/.test(t))
    push('rhetoricalDevices', '善用转折/对照句式', 0.04, '使用"不是…而是/与其…不如"式对照');
  if (/[0-9０-９]|那天|那年|有一次|记得|具体|细节|画面|石阶|窗|门槛|灰|磨/.test(t))
    push('modifierDensity', '重具体细节', 0.03, '出现具体细节标记');
  if (/哈哈|其实|就是|反正|我觉得|说白了|有点|真的|的话|呗|嘛/.test(t))
    push('languageRegister', '口语化', 0.04, '口语词');
  if (/感动|难过|激动|震撼|泪|暖|疼|心疼|颤|沉默|安宁|触动的?/.test(t))
    push('emotionalSpectrum', '情感浓度高', 0.04, '情绪词');
  if (/像|仿佛|如同/.test(t)) push('imageryTendency', '善用比喻意象', 0.04, '比喻词');
  if (/(^|[。！？])\s*我[^，。]*[，,。]|我们/.test(t))
    push('narrativePerspective', '第一人称代入', 0.03, '第一人称叙述');
  else if (/(^|[。！？])\s*你/.test(t))
    push('narrativePerspective', '第二人称对话感', 0.03, '第二人称叙述');
  if (/那天|曾经|如今|后来|当年|一百年前|百年/.test(t))
    push('timeHandling', '重时间纵深', 0.03, '时间词与历史纵深');
  if (/我觉得|我认为|必须|其实|说到底|归根结底/.test(t))
    push('criticalStance', '立场外显', 0.03, '立场性表达');
  if (/总之|归根结底|就这样|说到底/.test(t)) push('endingPattern', '收束式结尾', 0.03, '结语标记');
  // 词汇特色：本段重复出现的实词（≥2 次）记为用户高频词
  const counts = {};
  for (const word of t.match(/[\u4e00-\u9fff]{2,4}/g) || []) counts[word] = (counts[word] || 0) + 1;
  const top = Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  if (top.length)
    push('vocabularyCharacter', `高频词：${top.join('、')}`, 0.03, '本段重复出现的实词');
  // 结构层信号（read-style）：段落节奏与信息密度
  if (t.length > 120 && t.length < 400)
    pushRead('infoDensity', '中短信息块，节奏适中', 0.03, '素材篇幅适中');
  else if (t.length >= 400) pushRead('infoDensity', '长信息块，偏密', 0.03, '素材篇幅较长');
  return out;
}

/** 把一段用户话语的风格信号累积进 write/read 风格档案（无 LLM，纯增量）。 */
export function applyStyleSignals(workspace, text) {
  const signals = extractStyleSignals(text);
  const writeFile = path.join(workspace, 'vault', 'write-style.json');
  const readFile = path.join(workspace, 'vault', 'read-style.json');
  const writeObj = ws.readJson(writeFile);
  const readObj = ws.readJson(readFile);
  const bump = (obj, dims) => {
    let n = 0;
    for (const [key, s] of Object.entries(dims)) {
      const dim = obj.dimensions?.[key] || obj.structure?.[key];
      if (!dim) continue;
      dim.value = s.value;
      dim.confidence = Math.min(1, (dim.confidence || 0) + s.delta);
      dim.evidence = dim.evidence || [];
      if (!dim.evidence.includes(s.evidence)) dim.evidence.push(s.evidence);
      n += 1;
    }
    return n;
  };
  const w = bump(writeObj, signals.write);
  const r = bump(readObj, signals.read);
  if (!w && !r) return { writeUpdated: 0, readUpdated: 0 };
  writeObj.learnedFrom = writeObj.learnedFrom || {};
  writeObj.learnedFrom.samples = (writeObj.learnedFrom.samples || 0) + 1;
  writeObj.lastUpdated = new Date().toISOString();
  ws.writeJson(writeFile, writeObj);
  readObj.learnedFrom = readObj.learnedFrom || {};
  readObj.learnedFrom.samples = (readObj.learnedFrom.samples || 0) + 1;
  readObj.lastUpdated = new Date().toISOString();
  ws.writeJson(readFile, readObj);
  return { writeUpdated: w, readUpdated: r };
}

/** 风格档案白话摘要（用户可见）：已学维度 + 最近证据。 */
export function styleProgress(workspace) {
  const files = {
    write: path.join(workspace, 'vault', 'write-style.json'),
    read: path.join(workspace, 'vault', 'read-style.json'),
  };
  const byStyle = {};
  for (const [style, file] of Object.entries(files)) {
    let obj;
    try {
      obj = ws.readJson(file);
    } catch {
      byStyle[style] = { learned: 0, total: 0, top: [] };
      continue;
    }
    const dims = obj.dimensions || obj.structure || {};
    const total = Object.keys(dims).length;
    const top = Object.entries(dims)
      .filter(([, d]) => d && (d.confidence || 0) > 0)
      .sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0))
      .slice(0, 5)
      .map(([k, d]) => ({
        dim: k,
        value: d.value,
        confidence: Number((d.confidence || 0).toFixed(2)),
        evidence: (d.evidence || []).slice(-2),
      }));
    byStyle[style] = {
      learned: top.filter((x) => x.confidence >= 0.5).length,
      total,
      top,
    };
  }
  return byStyle;
}

/** 从观察者日志回填风格信号（Phase 0 / 压缩恢复时使用）。 */
export function backfillFromContext(workspace) {
  const logFile = path.join(workspace, 'protocol', 'context.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { applied: 0, skipped: 0 };
  }
  let applied = 0;
  let skipped = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const summary = String(rec.summary || '');
      const m = summary.match(/→\s*(.+)$/);
      const userText = rec.event === 'user' ? summary : m ? m[1] : '';
      if (!userText) {
        skipped += 1;
        continue;
      }
      const r = applyStyleSignals(workspace, userText);
      if (r.writeUpdated + r.readUpdated > 0) applied += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { applied, skipped };
}

/**
 * 从用户贴的风格底稿（vault/style-samples/*.md）提取 14 维风格。
 * 提取过的不重复提取（learnedFrom.samplesExtracted 记录）。失败不阻塞流程。
 */
export async function extractStyleFromSamples(workspace, cfg) {
  const dir = path.join(workspace, 'vault', 'style-samples');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    return { extracted: 0, skipped: 0 };
  }
  const writeFile = path.join(workspace, 'vault', 'write-style.json');
  const obj = ws.readJson(writeFile);
  obj.learnedFrom = obj.learnedFrom || {};
  const done = obj.learnedFrom.samplesExtracted || [];
  const pending = files.filter((f) => !done.includes(f));
  let extracted = 0;
  let skipped = 0;
  for (const f of pending) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    if (text.length < 40) {
      done.push(f);
      skipped += 1;
      continue;
    }
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是风格分析师，输出严格 JSON。' },
          { role: 'user', content: STYLE_EXTRACTION_PROMPT(text) },
        ],
        { json: true, temperature: 0.3, maxTokens: 2500 },
      );
      const r = parseJsonContent(content, '风格提取');
      for (const [k, d] of Object.entries(r.dimensions || {})) {
        const dim = obj.dimensions?.[k];
        if (!dim || !d) continue;
        if (d.value) dim.value = d.value;
        dim.confidence = Math.max(dim.confidence || 0, Math.min(1, Number(d.confidence) || 0));
        dim.evidence = dim.evidence || [];
        for (const ev of d.evidence || []) {
          if (ev && !dim.evidence.includes(ev)) dim.evidence.push(String(ev).slice(0, 120));
        }
      }
      obj.vector = obj.vector || {};
      obj.vector.personalDataset = obj.vector.personalDataset || {};
      if (Array.isArray(r.associations))
        obj.vector.personalDataset.topAssociations = r.associations;
      if (Array.isArray(r.techniques)) obj.vector.personalDataset.topTechniques = r.techniques;
      if (r.attentionFocus) obj.vector.attentionFocus = r.attentionFocus;
      obj.lastUpdated = ws.nowIso();
      done.push(f);
      extracted += 1;
    } catch {
      skipped += 1; // 提取失败不阻塞，留待下次 --extract
    }
  }
  obj.learnedFrom.samplesExtracted = done;
  ws.writeJson(writeFile, obj);
  return { extracted, skipped };
}
