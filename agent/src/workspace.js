// 工作区管理：.stylotrace/ 下的 state、vault、context、requests。
// 所有写入只发生在工作区目录内——这是与其他 agent 无冲突的硬保证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);

export const PHASE_LABELS = {
  observe: '观察中',
  clarify: '澄清中',
  plan: '大纲中',
  write: '写作中',
  redteam: '红队审计中',
  deliver: '交付中',
};

export function resolveWorkspace(cfg, flagWorkspace) {
  return path.resolve(flagWorkspace || cfg.workspace || path.join(process.cwd(), '.stylotrace'));
}

export function ensureWorkspace(ws, { create = false } = {}) {
  const stateFile = path.join(ws, 'protocol', 'state.json');
  if (!fs.existsSync(stateFile)) {
    if (!create) throw new Error(`工作区不存在: ${ws}（先运行 stylotrace init）`);
    fs.mkdirSync(path.join(ws, 'protocol'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'vault', 'project-memory'), { recursive: true });
    const seed = (rel, template) => {
      const dest = path.join(ws, rel);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(TEMPLATE_DIR, template), dest);
    };
    seed('protocol/state.json', 'state.template.json');
    seed('vault/write-style.json', 'write-style.template.json');
    seed('vault/read-style.json', 'read-style.template.json');
    seed('vault/style-fingerprint.json', 'style-fingerprint.template.json');
    seed('vault/style-vector.json', 'style-vector.template.json');
    for (const f of ['protocol/requests.jsonl', 'protocol/context.jsonl', 'vault/edits.jsonl']) {
      const dest = path.join(ws, f);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, '');
    }
  }
  return ws;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n');
}

export function nowIso() {
  return new Date().toISOString();
}

export function truncate(s, n = 1000) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…[截断 ${s.length - n} 字符]` : s;
}

export function countLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ── state ──────────────────────────────────────────────

export function readState(ws) {
  return readJson(path.join(ws, 'protocol', 'state.json'));
}

export function writeState(ws, state) {
  state.updatedAt = nowIso();
  writeJson(path.join(ws, 'protocol', 'state.json'), state);
}

export function logContext(ws, event, summary) {
  appendLine(
    path.join(ws, 'protocol', 'context.jsonl'),
    JSON.stringify({ ts: nowIso(), event, summary: truncate(summary, 1200) }),
  );
}

export function queueRequest(ws, req) {
  appendLine(
    path.join(ws, 'protocol', 'requests.jsonl'),
    JSON.stringify({ ts: nowIso(), status: 'pending', ...req }),
  );
}

// ── vault ──────────────────────────────────────────────

export function styleDimSummary(file) {
  try {
    const obj = readJson(file);
    const dims = obj.dimensions || obj.structure || {};
    const entries = Object.values(dims);
    const learned = entries.filter((d) => d && (d.confidence || 0) >= 0.6).length;
    return `已学 ${learned}/${entries.length} 维`;
  } catch {
    return '未初始化';
  }
}

/**
 * 吸收一段喜欢的文段进风格样本库（vault/style-samples/*.md）。
 * 用途：读到网络/他人的好文段（"喜欢这段的文风/引用"）时保存下来，
 * 供 extractStyleFromSamples 提取 14 维风格、供 buildStyleShot 检索为少样本。
 * 这是"借别人笔法"与"收藏引用"的落点——存样即学。
 */
export function absorbSample(ws, text, { author = '', source = '', note = '' } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('文段为空');
  const dir = path.join(ws, 'vault', 'style-samples');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sample-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
  const head = [
    '# 风格样本',
    author ? `> 作者：${author}` : '',
    source ? `> 出处：${source}` : '',
    note ? `> 备注：${note}` : '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(file, `${head}\n\n${t}\n`, 'utf8');
  return file;
}

export function absorbEdit(ws, edit) {
  if (!edit.target && !edit.changed) throw new Error('edit 至少需要 target 或 changed');
  const vaultDir = path.join(ws, 'vault');
  const writeFile = path.join(vaultDir, 'write-style.json');
  const readFile = path.join(vaultDir, 'read-style.json');
  if (!fs.existsSync(writeFile) || !fs.existsSync(readFile)) {
    throw new Error(`vault 不完整: ${vaultDir}`);
  }
  appendLine(
    path.join(vaultDir, 'edits.jsonl'),
    JSON.stringify({
      ts: nowIso(),
      target: edit.target || '',
      original: edit.original || '',
      changed: edit.changed || '',
      intent: edit.intent || '',
      evidence: edit.evidence || '',
      ctxBefore: String(edit.ctxBefore || '').slice(-160),
      ctxAfter: String(edit.ctxAfter || '').slice(0, 160),
    }),
  );

  const applyDims = (file, dims) => {
    if (!dims || !Object.keys(dims).length) return 0;
    const obj = readJson(file);
    let updated = 0;
    for (const [key, upd] of Object.entries(dims)) {
      const dim = obj.dimensions?.[key] ?? obj.structure?.[key];
      if (!dim) continue;
      const delta = typeof upd === 'number' ? upd : (upd.delta ?? 0.15);
      if (upd && typeof upd === 'object' && upd.value !== undefined) dim.value = upd.value;
      dim.confidence = Math.min(1, (dim.confidence || 0) + delta);
      dim.evidence = dim.evidence || [];
      const ev = edit.evidence || edit.intent || `${key}`;
      if (ev && !dim.evidence.includes(ev)) dim.evidence.push(truncate(ev, 120));
      updated += 1;
    }
    obj.learnedFrom = obj.learnedFrom || {};
    obj.learnedFrom.edits = (obj.learnedFrom.edits || 0) + 1;
    obj.lastUpdated = nowIso();
    writeJson(file, obj);
    return updated;
  };

  const w = applyDims(writeFile, edit.writeDims);
  const r = applyDims(readFile, edit.readDims);
  return { writeUpdated: w, readUpdated: r };
}

export function refreshFingerprint(ws) {
  const vaultDir = path.join(ws, 'vault');
  const write = readJson(path.join(vaultDir, 'write-style.json'));
  const read = readJson(path.join(vaultDir, 'read-style.json'));
  const high = [];
  for (const [obj, style, key] of [
    [write, 'write', 'dimensions'],
    [read, 'read', 'structure'],
  ]) {
    for (const [name, d] of Object.entries(obj[key] || {})) {
      if (d && (d.confidence || 0) >= 0.6) {
        high.push({
          style,
          dim: name,
          value: d.value,
          confidence: d.confidence,
          evidence: (d.evidence || []).slice(0, 3),
        });
      }
    }
  }
  const vector = write.vector || {};
  let sv = {};
  try {
    sv = readJson(path.join(vaultDir, 'style-vector.json'));
  } catch {
    // 风格向量尚未初始化时跳过
  }
  const now = Date.now();
  const dynamicDims = [];
  for (const [group, dims] of Object.entries(sv.dynamic || {})) {
    for (const [key, d] of Object.entries(dims || {})) {
      if (!d || !(d.w || 0)) continue;
      const ageDays = d.lastTs ? (now - new Date(d.lastTs).getTime()) / 86400000 : 0;
      const eff = (d.w || 0) * Math.exp(-Math.max(0, ageDays) / 120);
      if (eff >= 0.05) {
        dynamicDims.push({ group, key, weight: Number(eff.toFixed(2)), count: d.count || 0 });
      }
    }
  }
  const fingerprint = {
    schemaVersion: '0.1',
    generatedAt: nowIso(),
    highConfidenceDimensions: high,
    vectorTop: {
      associations: (vector.personalDataset?.topAssociations || []).slice(0, 5),
      techniques: (vector.personalDataset?.topTechniques || []).slice(0, 5),
      attentionTargets: Object.entries(vector.attentionFocus || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k]) => k),
    },
    styleVector: {
      mode: sv.continuous?.mode || 'sparse',
      signals: sv.learnedFrom?.signals || 0,
      dynamicDims: dynamicDims.sort((a, b) => b.weight - a.weight).slice(0, 8),
      perplexity: sv.perplexity || { proxy: true, samples: 0 },
      preferencePairs: (sv.preferencePairs || []).length,
    },
    learnedFrom: {
      writeEdits: write.learnedFrom?.edits || 0,
      readEdits: read.learnedFrom?.edits || 0,
    },
  };
  writeJson(path.join(vaultDir, 'style-fingerprint.json'), fingerprint);
  return fingerprint;
}

// ── panel / status ─────────────────────────────────────

export function renderPanel(stateFile) {
  const statePath = path.resolve(
    stateFile || path.join(process.cwd(), '.stylotrace', 'protocol', 'state.json'),
  );
  const s = readJson(statePath);
  const line = '─'.repeat(46);
  const phase = PHASE_LABELS[s.phase] || s.phase || '未知';
  const out = [];
  out.push(`\n${line}`, 'Stylotrace 玻璃面板', line);
  out.push(`阶段: ${phase}${s.projectId ? `    项目: ${s.projectId}` : ''}`);
  if (s.updatedAt) out.push(`更新: ${s.updatedAt}`);
  if (s.summary) out.push(`现在在做什么: ${s.summary}`);
  const confirmed = Object.entries(s.confirmed || {});
  if (confirmed.length) {
    out.push('已确认:');
    for (const [k, v] of confirmed) out.push(`  · ${k} — ${v}`);
  }
  const materials = s.materials || [];
  if (materials.length) {
    out.push('素材:');
    for (const m of materials) out.push(`  ✓ ${m}`);
  }
  const pending = s.pending || [];
  out.push(pending.length ? '待确认:' : '待确认: （无）');
  for (const p of pending) out.push(`  ? ${p}`);
  if (s.nextStep) out.push(`下一步: ${s.nextStep}`);
  const ws = path.resolve(path.dirname(statePath), '..');
  out.push(
    `风格金库: write ${styleDimSummary(path.join(ws, 'vault', 'write-style.json'))} · read ${styleDimSummary(path.join(ws, 'vault', 'read-style.json'))}`,
  );
  for (const [label, file] of [
    ['语言层', 'write-style.json'],
    ['结构层', 'read-style.json'],
  ]) {
    try {
      const obj = readJson(path.join(ws, 'vault', file));
      const dims = obj.dimensions || obj.structure || {};
      const top = Object.entries(dims)
        .filter(([, d]) => d && (d.confidence || 0) >= 0.4)
        .sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0))
        .slice(0, 3)
        .map(([k, d]) => `${k}→${d.value}（${(d.confidence * 100).toFixed(0)}%）`);
      if (top.length) out.push(`  ${label}: ${top.join('、')}`);
    } catch {}
  }
  out.push(line);
  return out.join('\n');
}

export function statusReport(ws) {
  let phase = '未初始化';
  try {
    phase = PHASE_LABELS[readState(ws).phase] || '未知';
  } catch {}
  return [
    `Stylotrace 工作区: ${ws}`,
    `  阶段: ${phase}`,
    `  风格: write ${styleDimSummary(path.join(ws, 'vault', 'write-style.json'))} · read ${styleDimSummary(path.join(ws, 'vault', 'read-style.json'))}`,
    `  观察日志: ${countLines(path.join(ws, 'protocol', 'context.jsonl'))} 条`,
    `  反向请求: ${countLines(path.join(ws, 'protocol', 'requests.jsonl'))} 条`,
    `  定点修改记录: ${countLines(path.join(ws, 'vault', 'edits.jsonl'))} 条`,
    `  风格指纹: ${fs.existsSync(path.join(ws, 'vault', 'style-fingerprint.json')) ? '已生成' : '未生成'}`,
  ].join('\n');
}
