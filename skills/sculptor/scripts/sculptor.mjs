#!/usr/bin/env node
/**
 * Sculptor CLI — P1 工具链
 *
 * 子命令：
 *   init [目录]               初始化 .sculptor 工作区
 *   panel [state.json]        渲染玻璃面板（白话进度）
 *   absorb <vault目录> <edit.json>   把一次定点修改吸收进风格档案
 *   fingerprint <vault目录>   刷新风格指纹（压缩守卫用）
 *   hook <工作区> [payload]   观察者日志入口（宿主 hook 调用，可从 stdin 读 JSON）
 *   status <工作区>           显示工作区摘要
 *   checklist <工作区>        渲染需求访谈确认清单（主题→…→风格底稿）
 *   quote <原句>              生成可粘贴的〔Sculptor 引用〕块
 *
 * 纯 Node 标准库，零依赖，跨平台（Codex / Claude Code / OpenCode 环境均有 Node）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PHASE_LABELS = {
  observe: '观察中',
  clarify: '澄清中',
  plan: '大纲中',
  write: '写作中',
  redteam: '红队审计中',
  deliver: '交付中',
};

const USAGE = `Sculptor CLI — 玻璃面板 / 定点修改吸收 / 压缩指纹 / 观察日志

用法:
  sculptor.mjs init [目录]                    初始化 .sculptor 工作区
  sculptor.mjs panel [state.json]             渲染玻璃面板（白话进度）
  sculptor.mjs absorb <vault目录> <edit.json> 把一次定点修改吸收进风格档案
  sculptor.mjs fingerprint <vault目录>        刷新风格指纹（压缩守卫用）
  sculptor.mjs hook <工作区> [payload]        观察者日志入口（宿主 hook 调用，可从 stdin 读 JSON）
  sculptor.mjs status <工作区>                显示工作区摘要
  sculptor.mjs checklist <工作区>             渲染需求访谈确认清单
  sculptor.mjs quote <原句>                   生成〔Sculptor 引用〕块
`;

function die(msg, code = 1) {
  console.error(`[sculptor] ${msg}`);
  process.exit(code);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    die(`无法读取 ${file}: ${err.message}`);
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n');
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(s, n = 1000) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…[截断 ${s.length - n} 字符]` : s;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ── init ──────────────────────────────────────────────

function cmdInit(dir) {
  const ws = path.resolve(dir || '.', '.sculptor');
  fs.mkdirSync(path.join(ws, 'protocol'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'vault', 'project-memory'), { recursive: true });
  const seed = (rel, template) => {
    const dest = path.join(ws, rel);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(SKILL_ROOT, template), dest);
    }
  };
  seed('protocol/state.json', 'protocol/state.template.json');
  seed('vault/write-style.json', 'vault/write-style.template.json');
  seed('vault/read-style.json', 'vault/read-style.template.json');
  seed('vault/style-fingerprint.json', 'vault/style-fingerprint.template.json');
  for (const f of ['protocol/requests.jsonl', 'protocol/context.jsonl', 'vault/edits.jsonl']) {
    const dest = path.join(ws, f);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, '');
  }
  console.log(`Sculptor 工作区已初始化 → ${ws}`);
  console.log('  protocol/state.json      玻璃面板状态');
  console.log('  protocol/context.jsonl   观察者日志（宿主 hook 写入）');
  console.log('  protocol/requests.jsonl  反向请求队列');
  console.log('  vault/                   双风格档案 + 风格指纹');
}

// ── panel ─────────────────────────────────────────────

function styleDimSummary(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dims = obj.dimensions || obj.structure || {};
    const entries = Object.values(dims);
    const learned = entries.filter((d) => d && (d.confidence || 0) >= 0.6).length;
    return `已学 ${learned}/${entries.length} 维`;
  } catch {
    return '未初始化';
  }
}

function cmdPanel(stateFile) {
  const s = readJson(stateFile || path.resolve('.sculptor/protocol/state.json'));
  const line = '─'.repeat(46);
  const phase = PHASE_LABELS[s.phase] || s.phase || '未知';
  console.log(`\n${line}`);
  console.log('Sculptor 玻璃面板');
  console.log(line);
  console.log(`阶段: ${phase}${s.projectId ? `    项目: ${s.projectId}` : ''}`);
  if (s.updatedAt) console.log(`更新: ${s.updatedAt}`);
  if (s.summary) console.log(`现在在做什么: ${s.summary}`);
  const confirmed = Object.entries(s.confirmed || {});
  if (confirmed.length) {
    console.log('已确认:');
    for (const [k, v] of confirmed) console.log(`  · ${k} — ${v}`);
  }
  const materials = s.materials || [];
  if (materials.length) {
    console.log('素材:');
    for (const m of materials) console.log(`  ✓ ${m}`);
  }
  const pending = s.pending || [];
  console.log(pending.length ? '待确认:' : '待确认: （无）');
  for (const p of pending) console.log(`  ? ${p}`);
  if (s.nextStep) console.log(`下一步: ${s.nextStep}`);
  const ws = path.resolve(path.dirname(stateFile || path.resolve('.sculptor/protocol/state.json')), '..');
  console.log(`风格金库: write ${styleDimSummary(path.join(ws, 'vault', 'write-style.json'))} · read ${styleDimSummary(path.join(ws, 'vault', 'read-style.json'))}`);
  console.log(line);
}

// ── absorb ────────────────────────────────────────────

function cmdAbsorb(vaultDir, editFile) {
  const edit = readJson(editFile);
  if (!edit.target && !edit.changed) die('edit.json 至少需要 target 或 changed');
  const writeFile = path.join(vaultDir, 'write-style.json');
  const readFile = path.join(vaultDir, 'read-style.json');
  if (!fs.existsSync(writeFile) || !fs.existsSync(readFile)) {
    die(`vault 目录缺少 write-style.json 或 read-style.json: ${vaultDir}`);
  }

  const record = {
    ts: nowIso(),
    target: edit.target || '',
    original: edit.original || '',
    changed: edit.changed || '',
    intent: edit.intent || '',
    evidence: edit.evidence || '',
  };
  appendLine(path.join(vaultDir, 'edits.jsonl'), JSON.stringify(record));

  const applyDims = (file, dims, side) => {
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
      const ev = edit.evidence || edit.intent || `${side}:${key}`;
      if (ev && !dim.evidence.includes(ev)) dim.evidence.push(truncate(ev, 120));
      updated += 1;
    }
    obj.learnedFrom = obj.learnedFrom || {};
    obj.learnedFrom.edits = (obj.learnedFrom.edits || 0) + 1;
    obj.lastUpdated = nowIso();
    writeJson(file, obj);
    return updated;
  };

  const writeUpdated = applyDims(writeFile, edit.writeDims, 'write');
  const readUpdated = applyDims(readFile, edit.readDims, 'read');
  console.log(`已吸收定点修改 → ${vaultDir}`);
  console.log(`  write-style: ${writeUpdated} 维更新 · read-style: ${readUpdated} 维更新`);
  console.log(`  修改记录已追加: ${record.target}`);
}

// ── fingerprint ───────────────────────────────────────

function cmdFingerprint(vaultDir) {
  const write = readJson(path.join(vaultDir, 'write-style.json'));
  const read = readJson(path.join(vaultDir, 'read-style.json'));
  const high = [];
  for (const [obj, style, key] of [[write, 'write', 'dimensions'], [read, 'read', 'structure']]) {
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
    learnedFrom: { writeEdits: write.learnedFrom?.edits || 0, readEdits: read.learnedFrom?.edits || 0 },
  };
  writeJson(path.join(vaultDir, 'style-fingerprint.json'), fingerprint);
  console.log(`风格指纹已刷新: ${high.length} 个高置信度维度（confidence ≥ 0.6）`);
}

// ── hook ──────────────────────────────────────────────

function cmdHook(workspace, payloadArg) {
  if (!fs.existsSync(workspace)) {
    console.log('[hook] 工作区不存在，无操作');
    return;
  }
  let payload = payloadArg;
  if (!payload) {
    try {
      payload = fs.readFileSync(0, 'utf8').trim();
    } catch {
      payload = '';
    }
  }
  let data = {};
  try {
    data = payload ? JSON.parse(payload) : {};
  } catch {
    data = { raw: truncate(payload, 300) };
  }
  const inner = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const ev =
    data.hook_event_name ||
    data.event ||
    data.event_type ||
    data.type ||
    inner.event ||
    inner.type ||
    'unknown';
  const evName = String(ev).toLowerCase();
  const contextFile = path.join(workspace, 'protocol/context.jsonl');
  const vaultDir = path.join(workspace, 'vault');

  const entry = {
    ts: nowIso(),
    event: evName,
    summary: truncate(data.summary || data.question || data.message || data.text || inner.message || inner.text || '', 800),
  };

  if (evName.includes('session') && evName.includes('start')) {
    appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] session-start 已记录');
  } else if (evName.includes('user') && (evName.includes('prompt') || evName.includes('message'))) {
    entry.summary = truncate(inner.message || inner.text || data.message || data.text || data.question || '', 1200);
    appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] 用户消息已记录');
  } else if (evName.includes('assistant')) {
    entry.summary = truncate(inner.message || inner.text || data.message || data.text || '', 800);
    appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] AI 消息已记录');
  } else if (evName.includes('compact') || evName.includes('summarize')) {
    appendLine(contextFile, JSON.stringify(entry));
    cmdFingerprint(vaultDir);
    console.log('[hook] 压缩前守卫已执行');
  } else if (evName.includes('stop') || evName.includes('end')) {
    appendLine(contextFile, JSON.stringify(entry));
    cmdFingerprint(vaultDir);
    console.log('[hook] 会话结束，风格指纹已刷新');
  } else {
    console.log(`[hook] 事件「${evName}」忽略（无操作）`);
  }
}

// ── status ────────────────────────────────────────────

function cmdStatus(ws) {
  if (!fs.existsSync(ws)) die(`工作区不存在: ${ws}`);
  const stateFile = path.join(ws, 'protocol/state.json');
  const vault = path.join(ws, 'vault');
  let phase = '未初始化';
  try {
    phase = PHASE_LABELS[readJson(stateFile).phase] || '未知';
  } catch {}
  console.log(`Sculptor 工作区: ${ws}`);
  console.log(`  阶段: ${phase}`);
  console.log(`  风格: write ${styleDimSummary(path.join(vault, 'write-style.json'))} · read ${styleDimSummary(path.join(vault, 'read-style.json'))}`);
  console.log(`  观察日志: ${countLines(path.join(ws, 'protocol/context.jsonl'))} 条`);
  console.log(`  反向请求: ${countLines(path.join(ws, 'protocol/requests.jsonl'))} 条`);
  console.log(`  定点修改记录: ${countLines(path.join(vault, 'edits.jsonl'))} 条`);
  console.log(`  风格指纹: ${fs.existsSync(path.join(vault, 'style-fingerprint.json')) ? '已生成' : '未生成'}`);
}

// ── checklist ────────────────────────────────────────

const CHECKLIST_ROWS = [
  { key: 'topic', label: '主题', required: true },
  { key: 'stance', label: '立场/目的', required: true },
  { key: 'audience', label: '读者与场合', required: true },
  { key: 'materials', label: '具体素材（≥2 条）', required: true, count: 2 },
  { key: 'theme', label: '核心立意', required: true },
  { key: 'arguments', label: '支撑论点（≥2 个）', required: true, count: 2 },
  { key: 'emotion', label: '情感曲线', required: false },
  { key: 'ending', label: '结尾姿态', required: false },
  { key: 'styleSample', label: '风格底稿（同文体旧稿）', required: false },
];

function cmdChecklist(ws) {
  if (!fs.existsSync(ws)) die(`工作区不存在: ${ws}`);
  const s = readJson(path.join(ws, 'protocol/state.json'));
  const c = s.confirmed || {};
  const mats = s.materials || [];
  const args = c.arguments || [];
  const line = '─'.repeat(46);
  const out = [line, 'Sculptor 需求访谈 · 确认清单', line];
  for (const row of CHECKLIST_ROWS) {
    let done = false;
    let note = '';
    if (row.key === 'materials') {
      done = mats.length >= (row.count || 1);
      note = `${mats.length}/${row.count}`;
    } else if (row.key === 'arguments') {
      done = args.length >= (row.count || 1);
      note = `${args.length}/${row.count}`;
    } else if (row.key === 'styleSample') {
      done = Boolean(c.styleSample);
      note = c.styleNote ? '已记录' : '';
    } else if (row.key === 'emotion') {
      done = Boolean(c.emotionalCurve);
      note = c.emotionalCurve ? '已确认' : '';
    } else if (row.key === 'ending') {
      done = Boolean(c.endingTaste);
      note = c.endingTaste ? '已确认' : '';
    } else {
      done = Boolean(c[row.key]);
      note = c[row.key] ? '已确认' : '';
    }
    const mark = done ? '✓' : '…';
    out.push(`${mark} ${row.label}${note ? `（${note}）` : ''}${done ? '' : ' — 待确认'}`);
  }
  out.push(line);
  out.push(`进度: ${out.filter((x) => x.startsWith('✓')).length}/${CHECKLIST_ROWS.length}（* 可选维度，用户连续两次说"你决定"可跳过）`);
  out.push(line);
  console.log(out.join('\n'));
}

// ── quote ────────────────────────────────────────────

function cmdQuote(raw) {
  const q = String(raw || '').trim().replace(/^〔[^〕]*引用[^〕]*〕\s*/, '');
  if (!q) die('用法: sculptor.mjs quote <原句>');
  console.log(`〔Sculptor 引用〕《${q}》`);
  console.log('修改指令：<在这里写你要怎么改，例如：这句太文艺，收一点>');
}

// ── main ──────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'init':
    cmdInit(args[0]);
    break;
  case 'panel':
    cmdPanel(args[0]);
    break;
  case 'absorb':
    if (args.length < 2) die('用法: sculptor.mjs absorb <vault目录> <edit.json>');
    cmdAbsorb(args[0], args[1]);
    break;
  case 'fingerprint':
    if (args.length < 1) die('用法: sculptor.mjs fingerprint <vault目录>');
    cmdFingerprint(args[0]);
    break;
  case 'hook':
    if (args.length < 1) die('用法: sculptor.mjs hook <工作区> [payload]');
    cmdHook(args[0], args[1]);
    break;
  case 'status':
    if (args.length < 1) die('用法: sculptor.mjs status <工作区>');
    cmdStatus(args[0]);
    break;
  case 'checklist':
    if (args.length < 1) die('用法: sculptor.mjs checklist <工作区>');
    cmdChecklist(args[0]);
    break;
  case 'quote':
    if (args.length < 1) die('用法: sculptor.mjs quote <原句>');
    cmdQuote(args.join(' '));
    break;
  case '-h':
  case '--help':
    console.log(USAGE);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
