// 风格脉搏（Style Pulse）：把"风格评估"从交付前的一次性大考，拆成每轮交互的轻量采集与反馈——
// 澄清每轮、大纲生成、每节写作、用户每次修改，都即时采集/评估/给出一条可执行的建议。
// 全程确定性优先（零 LLM、几十毫秒），让用户在过程中就感到"AI 一直在读我"，
// 而不是写完后被一堆评估环节轰炸。深度全稿评估仍保留（sculptor style-eval，手动跑）。
// 用户修改建议（"这句太文艺了/更口语/结尾收一点"）是评估反馈的核心来源：落档案 + 记脉搏。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';
import { extractStyleSignals } from './style.js';
import { audit } from './redteam.js';

const PULSES_FILE = 'style-pulses.jsonl';

function readProfile(workspace) {
  try {
    const obj = ws.readJson(path.join(workspace, 'vault', 'write-style.json'));
    return Object.entries(obj.dimensions || {})
      .filter(([, d]) => d && (d.confidence || 0) >= 0.4 && d.value)
      .reduce((acc, [k, d]) => ({ ...acc, [k]: d }), {});
  } catch {
    return {};
  }
}

function sampleCount(workspace) {
  try {
    return fs.readdirSync(path.join(workspace, 'vault', 'style-samples')).filter((f) => f.endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

function editCount(workspace) {
  return ws.countLines(path.join(workspace, 'vault', 'edits.jsonl'));
}

/** 记录一条脉搏：只追加 jsonl（state 由调用方用 pushPulseToState 合并，避免被后续 writeState 覆盖）。 */
export function recordPulse(workspace, pulse) {
  const entry = { ts: ws.nowIso(), ...pulse };
  const file = path.join(workspace, 'vault', PULSES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/** 把一条脉搏合并进 state 对象（不落盘，由调用方随自己的 writeState 一起保存）。 */
export function pushPulseToState(state, pulse) {
  if (!state || !pulse) return state;
  state.stylePulses = state.stylePulses || [];
  state.stylePulses.push({
    ts: pulse.ts,
    phase: pulse.phase,
    score: pulse.score,
    summary: pulse.summary || pulse.suggestion || '',
  });
  if (state.stylePulses.length > 12) state.stylePulses = state.stylePulses.slice(-12);
  return state;
}

function pulsesFromJsonl(workspace, limit) {
  try {
    const lines = fs
      .readFileSync(path.join(workspace, 'vault', PULSES_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 澄清每轮：采集了多少风格信号 + 还缺什么 + 一条建议。 */
export function pulseAfterClarify(workspace, text) {
  const signals = extractStyleSignals(text);
  const learned = Object.keys(signals.write).length + Object.keys(signals.read).length;
  let suggestion = '';
  if (!sampleCount(workspace) && !editCount(workspace)) {
    suggestion = '贴一段同文体旧稿（300 字以上）会让风格档案立刻有底';
  } else if (learned === 0) {
    suggestion = '';
  }
  const summary = learned
    ? `本轮捕获 ${learned} 个风格信号：${[...Object.keys(signals.write), ...Object.keys(signals.read)]
        .slice(0, 4)
        .join('、')}`
    : '本轮暂无新风格信号';
  return recordPulse(workspace, {
    phase: 'clarify',
    summary,
    suggestion,
    dims: [...Object.keys(signals.write), ...Object.keys(signals.read)],
  });
}

/** 大纲生成后：结构与你的收束/层次习惯是否一致（确定性）。 */
export function pulseAfterOutline(workspace, outline) {
  const profile = readProfile(workspace);
  const sections = outline?.sections || [];
  const issues = [];
  const lastFunc = sections.at(-1)?.function || '';
  const endingPref = profile.endingPattern?.value || '';
  if (endingPref && !/收束|留白|安宁|平静|决心|希望|升华/.test(lastFunc)) {
    issues.push(`结尾节功能「${lastFunc || '（无）'}」与你的收束习惯「${endingPref}」不一致`);
  }
  const funcs = new Set(sections.map((s) => s.function || ''));
  if (sections.length >= 3 && funcs.size < Math.max(2, sections.length * 0.5)) {
    issues.push('各节功能单一化，缺少铺垫/转折/升华层次');
  }
  const noThesis = sections.filter((s) => !s.thesis).length;
  if (noThesis) issues.push(`${noThesis} 节未挂论点`);
  const score = Math.max(0.3, 1 - issues.length * 0.25);
  return recordPulse(workspace, {
    phase: 'outline',
    score: Number(score.toFixed(2)),
    summary: issues.length ? `大纲脉搏 ${(score * 100).toFixed(0)} 分：${issues[0]}` : `大纲脉搏 ${(score * 100).toFixed(0)} 分：结构贴合你的习惯`,
    issues: issues.slice(0, 3),
    suggestion: issues[0] || '',
  });
}

/** 每节写作后：句长/黑名单/重复比喻的即时保真（确定性，几十毫秒）。 */
export function pulseAfterWrite(workspace, text, { section = {}, index = 0, previous = null } = {}) {
  const rep = audit(text);
  const sents = String(text || '')
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lens = sents.map((s) => [...s].length);
  const std = Math.sqrt(
    lens.reduce((a, b) => a + (b - (lens.reduce((x, y) => x + y, 0) / Math.max(1, lens.length))) ** 2, 0) /
      Math.max(1, lens.length),
  );
  const penalties =
    rep.blacklistHits.length * 0.12 + rep.repeatedMetaphors.length * 0.12 + rep.repeatedPatterns.length * 0.08;
  const rhythmPenalty = std < 8 ? 0.08 : 0;
  const score = Math.max(0.2, Math.min(0.98, 0.9 - penalties - rhythmPenalty));
  const drifted = [
    ...rep.blacklistHits.map((h) => `AI 套话「${h.phrase}」`),
    ...rep.repeatedMetaphors.map((m) => `重复比喻「${m.vehicle}」`),
    ...rep.repeatedPatterns.map((p) => `重复句式「${p.pattern}」`),
  ].slice(0, 3);
  let suggestion = '';
  if (drifted.length) suggestion = `本节有 ${drifted.length} 处痕迹：${drifted[0]}`;
  else if (previous?.suggestion) suggestion = `上一节问题（${previous.suggestion}）本节已注意`;
  else if (score >= 0.85) suggestion = '本节贴合你的档案，继续保持';
  const summary = `第 ${index} 节「${section.heading || ''}」风格脉搏 ${(score * 100).toFixed(0)} 分`;
  return recordPulse(workspace, {
    phase: 'write',
    section: section.heading || '',
    index,
    score: Number(score.toFixed(2)),
    summary,
    drifted,
    suggestion,
  });
}

/** 最近一条写作脉搏（state 缓存优先，jsonl 兜底；供下一节提示词注入）。 */
export function recentWritePulse(workspace) {
  try {
    const state = ws.readState(workspace);
    const fromState = (state.stylePulses || []).filter((p) => p.phase === 'write').slice(-1)[0];
    if (fromState) return fromState;
  } catch {
    // 落到 jsonl 兜底
  }
  return pulsesFromJsonl(workspace, 20)
    .reverse()
    .find((p) => p.phase === 'write') || null;
}

export function renderPulse(p) {
  const parts = [`[${p.phase}] ${p.summary || ''}`];
  if (p.suggestion) parts.push(`建议：${p.suggestion}`);
  return parts.join(' — ');
}

export function recentPulses(workspace, { limit = 8 } = {}) {
  try {
    const state = ws.readState(workspace);
    const fromState = (state.stylePulses || []).slice(-limit);
    if (fromState.length) return fromState;
  } catch {
    // 落到 jsonl 兜底
  }
  return pulsesFromJsonl(workspace, limit);
}

// ── 用户修改建议 = 评估反馈 ──────────────────────────────
// "这句太文艺了/太啰嗦/更口语/结尾收一点"直接反映上一版哪里不像你，
// 比任何模型评估都准：落档案（收紧/修正维度）+ 记一条 correction 脉搏。
const CORRECTION_RULES = [
  { re: /太?文艺|太?诗意|抒情|唯美|意象|比喻堆/, phrase: '意象与抒情收一点', dims: { imageryTendency: { delta: -0.12, value: '意象克制' } } },
  { re: /啰嗦|冗长|注水|废话|太长|拖沓/, phrase: '更简洁精炼', dims: { modifierDensity: { delta: -0.12, value: '修饰克制' }, sentencePreference: { value: '短句为主' } } },
  { re: /太?口语|太?生硬|太?书面/, phrase: '语感更自然', dims: { languageRegister: { delta: -0.1, value: '自然口语' } } },
  { re: /空泛|空洞|假大空|不具体|没细节|画面感不够/, phrase: '更具体有细节', dims: { modifierDensity: { value: '重具体细节' } } },
  { re: /结尾|收束|余味/, phrase: '按你的收束习惯调结尾', dims: { endingPattern: { delta: 0.1 } } },
  { re: /开头|第一句|开场/, phrase: '开头更抓人', dims: { sentencePreference: { delta: 0.08 } } },
  { re: /太?煽情|太?激动|情绪太重/, phrase: '情绪更克制', dims: { emotionalSpectrum: { delta: -0.12, value: '情感浓度低' } } },
  { re: /太?冷|太?平|没感情|太干/, phrase: '情绪更饱满', dims: { emotionalSpectrum: { delta: 0.12, value: '情感浓度高' } } },
];

export function extractCorrectionSignals(text) {
  const t = String(text || '');
  for (const rule of CORRECTION_RULES) {
    if (rule.re.test(t)) {
      return { phrase: rule.phrase, dims: rule.dims, matched: true };
    }
  }
  return { phrase: '', dims: {}, matched: false };
}

/** 把一条修改建议落进风格档案（证据 + 置信微调，不越权覆盖）并记 correction 脉搏。 */
export function applyCorrectionFeedback(workspace, text) {
  const c = extractCorrectionSignals(text);
  if (!c.matched) return { applied: false, phrase: '' };
  const file = path.join(workspace, 'vault', 'write-style.json');
  const obj = ws.readJson(file);
  obj.learnedFrom = obj.learnedFrom || {};
  obj.learnedFrom.corrections = (obj.learnedFrom.corrections || 0) + 1;
  let updated = 0;
  for (const [key, upd] of Object.entries(c.dims)) {
    const dim = obj.dimensions?.[key];
    if (!dim) continue;
    const delta = typeof upd === 'number' ? upd : upd.delta ?? 0.1;
    dim.confidence = Math.max(0, Math.min(1, (dim.confidence || 0) + delta));
    if (upd && typeof upd === 'object' && upd.value !== undefined) dim.value = upd.value;
    dim.evidence = dim.evidence || [];
    const ev = `用户修改建议：${text.trim().slice(0, 60)}`;
    if (!dim.evidence.includes(ev)) dim.evidence.push(ev);
    updated += 1;
  }
  obj.lastUpdated = ws.nowIso();
  ws.writeJson(file, obj);
  const pulse = recordPulse(workspace, {
    phase: 'correction',
    summary: `用户修改建议「${c.phrase}」已吸收进档案（${updated} 维）`,
    suggestion: c.phrase,
    dims: Object.keys(c.dims),
  });
  try {
    const state = ws.readState(workspace);
    pushPulseToState(state, pulse);
    ws.writeState(workspace, state);
  } catch {}
  return { applied: true, phrase: c.phrase, updated };
}
