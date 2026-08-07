// 风格全程被动采集：用户的每一句话（对话语气、素材、修改理由）都是风格信号。
// 轻量确定性提取（无 LLM 开销），累积进 write-style.json 的置信度。
// 每个信号都带 evidence，让"风格被读到了"这件事对用户可见、可查。
import path from 'node:path';
import fs from 'node:fs';
import * as ws from './workspace.js';
import { STYLE_EXTRACTION_PROMPT, CONVERSATION_STYLE_PROMPT } from './prompts.js';
import { chatWithRetry, parseJsonContent } from './llm.js';

// ── 风格方向（用户主动给出的整体改变方向）────────────────────────
// 用户说"整篇更克制/更豪迈/更口语…"时，记录进 write-style.json 的 styleDirections，
// 并提升相关维度置信。方向变化后若已有草稿，标记 needsRestyle → sculptor restyle 全文重写。
const STYLE_DIRECTION_RULES = [
  {
    re: /更?克制|收敛|平静些|冷静些|内敛|不煽情|少抒情|别太抒情/,
    phrase: '更克制收敛',
    dims: { temperature: { value: '克制内敛' }, emotionalSpectrum: { value: '情感浓度低' } },
    evidence: '用户要求更克制',
  },
  {
    re: /更?豪迈|激昂|澎湃|有气势|大气|磅礴/,
    phrase: '更豪迈有气势',
    dims: { temperature: { value: '情绪昂扬' }, emotionalSpectrum: { value: '情感浓度高' } },
    evidence: '用户要求更豪迈',
  },
  {
    re: /更?口语|接地气|亲切|像聊天|生活化/,
    phrase: '更口语化',
    dims: { languageRegister: { value: '口语化' } },
    evidence: '用户要求更口语',
  },
  {
    re: /更?简洁|利落|干脆|精炼|短一点/,
    phrase: '更简洁利落',
    dims: { sentencePreference: { value: '短句为主' }, modifierDensity: { value: '修饰克制' } },
    evidence: '用户要求更简洁',
  },
  {
    re: /更?细腻|细节|画面感|具体一点/,
    phrase: '更细腻有画面感',
    dims: { modifierDensity: { value: '重具体细节' } },
    evidence: '用户要求更细腻',
  },
  {
    re: /更?文艺|诗意|意象|唯美/,
    phrase: '更文艺诗意',
    dims: { imageryTendency: { value: '善用比喻意象' } },
    evidence: '用户要求更文艺',
  },
  {
    re: /更?理性|客观|冷静分析|克制情绪/,
    phrase: '更理性克制',
    dims: { emotionalSpectrum: { value: '情感浓度低' }, criticalStance: { value: '立场外显' } },
    evidence: '用户要求更理性',
  },
  {
    re: /更?幽默|轻松|活泼|俏皮/,
    phrase: '更轻松幽默',
    dims: { temperature: { value: '轻松诙谐' }, languageRegister: { value: '口语化' } },
    evidence: '用户要求更幽默',
  },
  {
    re: /历史感|厚重|沉稳|苍茫/,
    phrase: '更有历史厚重感',
    dims: { timeHandling: { value: '重时间纵深' } },
    evidence: '用户要求有历史感',
  },
];

/** 从用户话语里识别"整体风格方向"，返回匹配到的方向（确定性、零 LLM）。 */
export function extractStyleDirection(text) {
  const t = String(text || '');
  for (const rule of STYLE_DIRECTION_RULES) {
    if (rule.re.test(t)) return { phrase: rule.phrase, dims: rule.dims, evidence: rule.evidence };
  }
  return null;
}

/** 把风格方向落进 write-style.json（styleDirections + 相关维度置信提升）。 */
export function applyStyleDirection(workspace, text) {
  const d = extractStyleDirection(text);
  if (!d) return { applied: false };
  const writeFile = path.join(workspace, 'vault', 'write-style.json');
  const obj = ws.readJson(writeFile);
  obj.styleDirections = obj.styleDirections || [];
  obj.styleDirections.push({
    phrase: d.phrase,
    dims: Object.keys(d.dims),
    ts: ws.nowIso(),
    evidence: d.evidence,
  });
  if (obj.styleDirections.length > 20) obj.styleDirections = obj.styleDirections.slice(-20);
  let updated = 0;
  for (const [k, upd] of Object.entries(d.dims)) {
    const dim = obj.dimensions?.[k];
    if (!dim) continue;
    if (upd.value) dim.value = upd.value;
    dim.confidence = Math.min(1, (dim.confidence || 0) + 0.12);
    dim.evidence = dim.evidence || [];
    if (!dim.evidence.includes(d.evidence)) dim.evidence.push(d.evidence);
    updated += 1;
  }
  obj.learnedFrom = obj.learnedFrom || {};
  obj.learnedFrom.directions = (obj.learnedFrom.directions || 0) + 1;
  obj.lastUpdated = ws.nowIso();
  ws.writeJson(writeFile, obj);
  return { applied: true, phrase: d.phrase, updated };
}

/** 最近一条风格方向（restyle 缺省方向来源）。 */
export function latestStyleDirection(workspace) {
  try {
    const obj = ws.readJson(path.join(workspace, 'vault', 'write-style.json'));
    const dirs = obj.styleDirections || [];
    return dirs.length ? dirs[dirs.length - 1] : null;
  } catch {
    return null;
  }
}

/** 导出人类可读的风格档案文档（vault/style-profile.md）：维度 + 方向 + 样本 + 编辑对。 */
export function renderStyleProfile(workspace) {
  const vault = path.join(workspace, 'vault');
  const write = ws.readJson(path.join(vault, 'write-style.json'));
  const read = ws.readJson(path.join(vault, 'read-style.json'));
  const lines = [];
  lines.push('# 我的写作风格档案', '', `生成时间：${ws.nowIso()}`, '');
  lines.push('## 语言层（write-style）');
  for (const [k, d] of Object.entries(write.dimensions || {})) {
    if (!d || !(d.confidence || 0)) continue;
    lines.push(
      `- ${k}：${d.value || '（未定）'}（置信 ${((d.confidence || 0) * 100).toFixed(0)}%）${
        d.evidence?.length ? `；依据：${d.evidence.slice(-1)[0]}` : ''
      }`,
    );
  }
  lines.push('', '## 结构层（read-style）');
  for (const [k, d] of Object.entries(read.structure || {})) {
    if (!d || !(d.confidence || 0)) continue;
    lines.push(
      `- ${k}：${d.value || '（未定）'}（置信 ${((d.confidence || 0) * 100).toFixed(0)}%）`,
    );
  }
  const dirs = write.styleDirections || [];
  lines.push('', '## 风格方向变化（按时间）');
  if (!dirs.length) lines.push('- （暂无）');
  for (const d of dirs) lines.push(`- ${d.ts}：${d.phrase}（影响：${d.dims.join('、')}）`);
  let samples = [];
  try {
    samples = fs.readdirSync(path.join(vault, 'style-samples')).filter((f) => f.endsWith('.md'));
  } catch {}
  lines.push('', '## 旧稿样本');
  lines.push(samples.length ? samples.map((f) => `- ${f}`).join('\n') : '- （暂无）');
  lines.push('', '## 亲手修改记录');
  lines.push(
    `- 共 ${ws.countLines(path.join(vault, 'edits.jsonl'))} 条（见 edits.jsonl，这是最强的风格信号）`,
  );
  const vector = write.vector || {};
  const assoc = vector.personalDataset?.topAssociations || [];
  const tech = vector.personalDataset?.topTechniques || [];
  if (assoc.length || tech.length) {
    lines.push('', '## 联想与惯用技巧');
    if (assoc.length) lines.push(`- 联想库：${assoc.join('、')}`);
    if (tech.length) lines.push(`- 惯用技巧：${tech.join('、')}`);
  }
  return lines.join('\n');
}

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

/** 从 context.jsonl 收集用户发言（对话级风格提炼的语料）。 */
export function collectUserUtterances(workspace, { max = 30, maxChars = 120 } = {}) {
  const logFile = path.join(workspace, 'protocol', 'context.jsonl');
  const out = [];
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const summary = String(rec.summary || '');
        const m = summary.match(/→\s*(.+)$/);
        const text = rec.event === 'user' ? summary : m ? m[1] : '';
        const clean = String(text || '').trim();
        if (clean.length >= 4 && !/^(对|好|可以|嗯|ok|是的|就这样|继续|你决定)$/i.test(clean)) {
          out.push(clean.slice(0, maxChars));
        }
      } catch {}
    }
  } catch {}
  return out.slice(-max);
}

/**
 * 对话级整体风格提炼：澄清收尾时把用户全部发言（素材/感受/修改意见/确认）
 * 做一次 LLM 综合，提炼"人想写的（write）"与"人想听的（read）"双风格，
 * 并合并进 write/read 档案（高置信维度 + 联想库 + 技术偏好）。
 * 失败静默（不阻塞流程）；apiKey 守卫；提炼结果全部带证据。
 */
export async function extractStyleFromConversation(cfg, workspace, { texts = null } = {}) {
  if (!cfg.apiKey) return { extracted: false, reason: 'no-key' };
  const corpus = texts || collectUserUtterances(workspace);
  if (!corpus.length) return { extracted: false, reason: 'no-utterances' };
  let content;
  try {
    content = await chatWithRetry(
      cfg,
      [
        { role: 'system', content: '你是风格提炼师，输出严格 JSON。' },
        { role: 'user', content: CONVERSATION_STYLE_PROMPT(corpus) },
      ],
      { json: true, temperature: 0.25, maxTokens: 3000 },
    );
  } catch {
    return { extracted: false, reason: 'llm-failed' };
  }
  let r;
  try {
    r = parseJsonContent(content, '对话风格提炼');
  } catch {
    return { extracted: false, reason: 'parse-failed' };
  }
  const writeFile = path.join(workspace, 'vault', 'write-style.json');
  const readFile = path.join(workspace, 'vault', 'read-style.json');
  const writeObj = ws.readJson(writeFile);
  const readObj = ws.readJson(readFile);
  let updated = 0;
  for (const [k, d] of Object.entries(r.writeStyle || {})) {
    const dim = writeObj.dimensions?.[k];
    if (!dim || !d || typeof d !== 'object') continue;
    if (d.value) dim.value = String(d.value);
    const conf = Number(d.confidence) || 0;
    dim.confidence = Math.max(dim.confidence || 0, Math.min(1, conf));
    dim.evidence = dim.evidence || [];
    const ev = `对话整体提炼：${String(d.evidence || d.value || '').slice(0, 80)}`;
    if (ev && !dim.evidence.includes(ev)) dim.evidence.push(ev);
    updated += 1;
  }
  for (const [k, d] of Object.entries(r.readStyle || {})) {
    const dim = readObj.structure?.[k];
    if (!dim || !d || typeof d !== 'object') continue;
    if (d.value) dim.value = String(d.value);
    const conf = Number(d.confidence) || 0;
    dim.confidence = Math.max(dim.confidence || 0, Math.min(1, conf));
    dim.evidence = dim.evidence || [];
    const ev = `对话整体提炼：${String(d.evidence || d.value || '').slice(0, 80)}`;
    if (ev && !dim.evidence.includes(ev)) dim.evidence.push(ev);
    updated += 1;
  }
  writeObj.vector = writeObj.vector || {};
  writeObj.vector.personalDataset = writeObj.vector.personalDataset || {};
  const mergeTop = (key, arr) => {
    const cur = writeObj.vector.personalDataset[key] || [];
    const merged = [...new Set([...cur, ...(Array.isArray(arr) ? arr : [])])].slice(0, 6);
    writeObj.vector.personalDataset[key] = merged;
  };
  mergeTop('topAssociations', r.associations);
  mergeTop('topTechniques', r.techniques);
  if (r.preferences?.length) mergeTop('topVocabulary', []);
  writeObj.vector.writingDeviation = writeObj.vector.writingDeviation || {};
  writeObj.vector.writingDeviation.notableDirections = writeObj.vector.writingDeviation.notableDirections || [];
  if (r.preferences?.length) {
    for (const p of r.preferences.slice(0, 4)) {
      if (!writeObj.vector.writingDeviation.notableDirections.includes(p)) {
        writeObj.vector.writingDeviation.notableDirections.push(p);
      }
    }
  }
  if (r.writeReadGap) {
    writeObj.vector.writeReadGap = String(r.writeReadGap);
  }
  writeObj.learnedFrom = writeObj.learnedFrom || {};
  writeObj.learnedFrom.conversations = (writeObj.learnedFrom.conversations || 0) + 1;
  writeObj.lastUpdated = ws.nowIso();
  readObj.learnedFrom = readObj.learnedFrom || {};
  readObj.learnedFrom.conversations = (readObj.learnedFrom.conversations || 0) + 1;
  readObj.lastUpdated = ws.nowIso();
  ws.writeJson(writeFile, writeObj);
  ws.writeJson(readFile, readObj);
  ws.logContext(
    workspace,
    'style',
    `对话整体提炼：更新 ${updated} 维（write ${Object.keys(r.writeStyle || {}).length} + read ${Object.keys(r.readStyle || {}).length}）`,
  );
  return { extracted: true, updated, writeReadGap: r.writeReadGap || '' };
}
