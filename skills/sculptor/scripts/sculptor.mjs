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
 *   audience <工作区>         读者群像：8 个"第一读者"的感性反馈（交付前强制）
 *   restyle <工作区> [--direction 方向] [--section N] [--force]
 *                             按新风格方向重写整篇草稿（缺省用档案最近一条方向）
 *
 * 纯 Node 标准库，零依赖，跨平台（Codex / Claude Code / OpenCode 环境均有 Node）。
 * 读者群像 / 重写需要 LLM：配置 SCULPTOR_LLM_API_KEY（默认 DeepSeek 端点）；
 * 未配置或调用失败时，读者群像退化为确定性兜底，重写会给出明确错误提示。
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
  sculptor.mjs audience <工作区> [--quick] [--file x.md]
                                             8 个"第一读者"的感性反馈（交付前强制）
  sculptor.mjs restyle <工作区> [--direction 方向] [--section N] [--force]
                                             按新风格方向重写整篇（缺省用档案最近一条方向）
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
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
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
  const ws = path.resolve(
    path.dirname(stateFile || path.resolve('.sculptor/protocol/state.json')),
    '..',
  );
  console.log(
    `风格金库: write ${styleDimSummary(path.join(ws, 'vault', 'write-style.json'))} · read ${styleDimSummary(path.join(ws, 'vault', 'read-style.json'))}`,
  );
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
    learnedFrom: {
      writeEdits: write.learnedFrom?.edits || 0,
      readEdits: read.learnedFrom?.edits || 0,
    },
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
    summary: truncate(
      data.summary ||
        data.question ||
        data.message ||
        data.text ||
        inner.message ||
        inner.text ||
        '',
      800,
    ),
  };

  if (evName.includes('session') && evName.includes('start')) {
    appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] session-start 已记录');
  } else if (evName.includes('user') && (evName.includes('prompt') || evName.includes('message'))) {
    entry.summary = truncate(
      inner.message || inner.text || data.message || data.text || data.question || '',
      1200,
    );
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
  console.log(
    `  风格: write ${styleDimSummary(path.join(vault, 'write-style.json'))} · read ${styleDimSummary(path.join(vault, 'read-style.json'))}`,
  );
  console.log(`  观察日志: ${countLines(path.join(ws, 'protocol/context.jsonl'))} 条`);
  console.log(`  反向请求: ${countLines(path.join(ws, 'protocol/requests.jsonl'))} 条`);
  console.log(`  定点修改记录: ${countLines(path.join(vault, 'edits.jsonl'))} 条`);
  console.log(
    `  风格指纹: ${fs.existsSync(path.join(vault, 'style-fingerprint.json')) ? '已生成' : '未生成'}`,
  );
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
  out.push(
    `进度: ${out.filter((x) => x.startsWith('✓')).length}/${CHECKLIST_ROWS.length}（* 可选维度，用户连续两次说"你决定"可跳过）`,
  );
  out.push(line);
  console.log(out.join('\n'));
}

// ── quote ────────────────────────────────────────────

function cmdQuote(raw) {
  const q = String(raw || '')
    .trim()
    .replace(/^〔[^〕]*引用[^〕]*〕\s*/, '');
  if (!q) die('用法: sculptor.mjs quote <原句>');
  console.log(`〔Sculptor 引用〕《${q}》`);
  console.log('修改指令：<在这里写你要怎么改，例如：这句太文艺，收一点>');
}

// ── LLM 调用（零依赖，OpenAI 兼容 chat/completions）────────────────

async function llmChat(messages, { maxTokens = 1200, temperature = 0.9, json = false } = {}) {
  const baseUrl = (process.env.SCULPTOR_LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(
    /\/+$/,
    '',
  );
  const apiKey = process.env.SCULPTOR_LLM_API_KEY || '';
  if (!apiKey) throw new Error('未配置 SCULPTOR_LLM_API_KEY，无法调用 LLM');
  const body = {
    model: process.env.SCULPTOR_LLM_MODEL || 'deepseek-v4-flash',
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number(process.env.SCULPTOR_LLM_TIMEOUT_MS || 120000),
  );
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回空内容');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(content) {
  const cleaned = String(content || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    return null;
  }
}

// ── audience（读者群像：交付前强制）────────────────────────────────

const AUDIENCE_PERSONAS = [
  {
    id: 'teacher',
    name: '老教师',
    role: '教了一辈子书，最讨厌说教，也最怕空话',
    lens: '真诚不真诚、有没有具体的人与事',
  },
  {
    id: 'editor',
    name: '挑剔编辑',
    role: '每天审稿，一眼看出重复、注水、结构散',
    lens: '段落功能、重复句式、开头三行留不留得住人',
  },
  {
    id: 'student',
    name: '中学生',
    role: '被作业逼着读，读到一半会偷偷刷手机',
    lens: '第一句抓不抓人、有没有画面、会不会睡着',
  },
  {
    id: 'critic',
    name: '挑剔评论家',
    role: '不放过立意与论证的漏洞',
    lens: '核心立意是否成立、论点有没有展开',
  },
  {
    id: 'parent',
    name: '焦虑家长',
    role: '关心孩子读到的价值观',
    lens: '导向、情绪、结尾留下的态度',
  },
  {
    id: 'historyFan',
    name: '历史爱好者',
    role: '较真细节，出戏立刻打回',
    lens: '事实、年代、人名、场景是否经得起查证',
  },
  {
    id: 'casual',
    name: '随性读者',
    role: '在地铁上随便点开，读不完就划走',
    lens: '前 30 秒、有没有一个瞬间让我停下来',
  },
  {
    id: 'youngWriter',
    name: '年轻作家',
    role: '一边读一边偷学笔法，也最敏感 AI 味',
    lens: '哪句像模板、哪句有作者自己的指纹',
  },
];

function audienceSections(text) {
  const parts = String(text || '').split(/\n(?=## )/);
  if (parts.length > 1) {
    return parts.map((p) => {
      const m = p.match(/^##\s*(.+)$/m);
      return { heading: m ? m[1].trim() : '（开头）', body: p };
    });
  }
  const paras = String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.map((p, i) => ({
    heading: i === 0 ? '开头' : i === paras.length - 1 ? '结尾' : `第 ${i + 1} 段`,
    body: p,
  }));
}

function audienceFallback(persona, text, sections) {
  const cjk = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const clean = (s) =>
    String(s || '')
      .replace(/^#+\s*.*$/gm, '')
      .trim();
  const firstPara = clean(sections[0]?.body);
  const lastPara = clean(sections[sections.length - 1]?.body);
  const moments = [];
  if (persona.id === 'student' || persona.id === 'casual') {
    moments.push({
      at: firstPara.slice(0, 30) || '开头',
      thought: cjk < 60 ? '开头有点短，还没抓住我。' : '开头有画面，我愿往下读。',
    });
  }
  if (persona.id === 'historyFan') {
    moments.push({
      at: String(text).slice(0, 40),
      thought: '里面的数字和年代我得去核一下，不核不敢信。',
    });
  }
  if (persona.id === 'teacher') {
    moments.push({
      at: lastPara.slice(0, 30) || '结尾',
      thought: '结尾有没有落到具体的人身上？光有道理不够。',
    });
  }
  if (persona.id === 'parent') {
    moments.push({
      at: lastPara.slice(0, 30) || '结尾',
      thought: '我想知道孩子读完后心里留下的是勇气还是空洞的道理。',
    });
  }
  if (persona.id === 'critic') {
    moments.push({ at: '', thought: '立意我看到了，但每个论点是不是都有实例撑着？' });
  }
  if (!moments.length) {
    moments.push({
      at: firstPara.slice(0, 20) || '开头',
      thought: '第一次读，我先看有没有让我停下来的句子。',
    });
  }
  return {
    persona: persona.name,
    role: persona.role,
    impression: `（离线兜底反馈）我是${persona.name}：${persona.lens}。${cjk < 300 ? '篇幅偏短，还没来得及进入' : cjk >= 1500 ? '信息量不小，有几处需要停一停' : '整体能读下去，但有几处想停下来'}。`,
    moments,
    advice: `写给你自己的细节比写给读者的道理更有力——${persona.lens.split('、')[0]}。`,
  };
}

async function audienceOne(persona, text, sections) {
  const prompt = `你是「${persona.name}」——${persona.role}。你第一次读到下面这篇文章，请完全屏蔽"作者视角"和客套，只记录真实的心理活动：
要求：1. impression 读完全文后最直接的第一印象（两三句话，不点评文笔，只讲感受）；2. moments 列 2-3 个让你停下来/走神/皱眉/心跳加快的具体位置，at 引用原文片段（10-30 字），thought 写当时心里在想什么；3. advice 最想对作者说的一句话。
你特别在意：${persona.lens}。
【文章】
${String(text).slice(0, 12000)}
输出严格 JSON：
{"impression":"","moments":[{"at":"原文片段","thought":"当时心里想"}],"advice":""}`;
  try {
    const content = await llmChat(
      [
        { role: 'system', content: '你是一个真实的第一读者，输出严格 JSON。' },
        { role: 'user', content: prompt },
      ],
      { json: true, maxTokens: 1000, temperature: 0.9 },
    );
    const r = parseJsonLoose(content);
    if (!r) throw new Error('JSON 解析失败');
    return {
      persona: persona.name,
      role: persona.role,
      impression: String(r.impression || ''),
      moments: Array.isArray(r.moments) ? r.moments.slice(0, 4) : [],
      advice: String(r.advice || ''),
    };
  } catch {
    return audienceFallback(persona, text, sections);
  }
}

async function cmdAudience(wsDir, { quick = false, file = null } = {}) {
  const draftFile = file ? path.resolve(file) : path.join(path.resolve(wsDir), 'draft.md');
  if (!fs.existsSync(draftFile))
    die(`找不到要审阅的文稿: ${draftFile}（先 write，或 --file 指定）`);
  const text = fs.readFileSync(draftFile, 'utf8');
  const sections = audienceSections(text);
  const selected = quick ? AUDIENCE_PERSONAS.slice(0, 3) : AUDIENCE_PERSONAS;
  const reactions = [];
  for (const p of selected) reactions.push(await audienceOne(p, text, sections));
  const line = '─'.repeat(46);
  console.log(`\n${line}`);
  console.log('Sculptor 读者群像 · 第一次阅读反馈');
  console.log(line);
  for (const r of reactions) {
    console.log(`\n【${r.persona}】${r.role ? `（${r.role}）` : ''}`);
    if (r.impression) console.log(`读完后: ${r.impression}`);
    for (const m of r.moments || []) console.log(`  · 「${m.at}」\n    → ${m.thought}`);
    if (r.advice) console.log(`最想对作者说: ${r.advice}`);
  }
  console.log(`\n${line}`);
  console.log('哪些位置触动了读者');
  console.log(line);
  const heat = new Map();
  for (const s of sections) {
    const hits = reactions.flatMap((r) =>
      (r.moments || [])
        .filter((m) => m.at && s.body.includes(m.at))
        .map((m) => `${r.persona}: ${m.thought}`),
    );
    if (hits.length) heat.set(s.heading, hits);
  }
  for (const [heading, hits] of heat) {
    console.log(`「${heading}」`);
    for (const h of hits) console.log(`  · ${h}`);
  }
  console.log(line);
  appendLine(
    path.join(path.resolve(wsDir), 'protocol', 'context.jsonl'),
    JSON.stringify({
      ts: nowIso(),
      event: 'audience',
      summary: `读者群像 ${reactions.length} 人（skill 形态）`,
    }),
  );
}

// ── restyle（按新风格方向重写整篇）─────────────────────────────────

function latestDirection(wsDir) {
  try {
    const obj = readJson(path.join(path.resolve(wsDir), 'vault', 'write-style.json'));
    const dirs = obj.styleDirections || [];
    return dirs.length ? dirs[dirs.length - 1] : null;
  } catch {
    return null;
  }
}

async function cmdRestyle(wsDir, { direction = '', section = null, force = false } = {}) {
  const ws = path.resolve(wsDir);
  const draftFile = path.join(ws, 'draft.md');
  if (!fs.existsSync(draftFile)) die('没有 draft.md，先写草稿');
  const state = readJson(path.join(ws, 'protocol', 'state.json'));
  const outline = state.outline;
  if (!outline?.sections?.length) die('没有大纲，无法分节重写（先 outline）');
  const stored = latestDirection(ws);
  const dirText = String(direction || '').trim() || stored?.phrase || '';
  if (!dirText)
    die('没有可用的风格方向：用 --direction 给出一句话（如"更克制一点"），或先告诉 AI 你想怎么改');
  const existing = fs.readFileSync(draftFile, 'utf8');
  const parts = existing.split(/\n(?=## )/);
  if (parts.length !== outline.sections.length)
    die(`draft 分节数（${parts.length}）与大纲（${outline.sections.length}）不一致，无法安全重写`);
  const start = section === null ? 0 : section;
  const end = section === null ? outline.sections.length - 1 : section;
  for (let i = start; i <= end; i++) {
    const s = outline.sections[i];
    const heading = s.heading;
    const body = String(parts[i] || '')
      .replace(/^## .*\n\n/, '')
      .trim();
    if (!body) continue;
    const prompt = `你是 Sculptor 的改写者。把下面这一节按【新风格方向】整体重写：保留原文的论点、素材与结构功能，只换表达方式、节奏与口吻；整篇按新方向统一，不许只有这一节变。
【本节】${heading}（功能：${s.function || ''}${s.thesis ? `；论点：${s.thesis}` : ''}）
【目标字数】约 ${s.words || 300} 字
【新风格方向】${dirText}
【原文】
${body}
重写要求：黑名单（在当今社会/随着/近年来/众所周知/值得注意的是/总而言之/赋能）禁用；同一个比喻只出现一次；"虽然…但是…""不是…而是…"不重复；段落长短错落；字数与原文相当（±15%）。
只输出重写后的正文。`;
    const content = await llmChat(
      [
        { role: 'system', content: '你是按用户风格方向重写正文的改写者，只输出正文。' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 3500, temperature: 0.8 },
    );
    parts[i] = `## ${heading}\n\n${content.trim()}\n`;
    console.log(`已重写第 ${i + 1}/${outline.sections.length} 节：${heading}`);
  }
  fs.writeFileSync(draftFile, parts.join(''));
  state.needsRestyle = false;
  state.lastRestyleAt = nowIso();
  writeJson(path.join(ws, 'protocol', 'state.json'), state);
  console.log(`已按「${dirText}」重写 ${end - start + 1} 节 → ${draftFile}`);
}

// ── main ──────────────────────────────────────────────

async function main() {
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
    case 'audience': {
      if (args.length < 1) die('用法: sculptor.mjs audience <工作区> [--quick] [--file x.md]');
      const flags = {};
      const pos = [];
      for (const a of args) {
        if (a === '--quick') flags.quick = true;
        else if (a === '--file') flags.file = true;
        else if (flags.file === true) flags.file = a;
        else pos.push(a);
      }
      await cmdAudience(pos[0], {
        quick: Boolean(flags.quick),
        file: typeof flags.file === 'string' ? flags.file : null,
      });
      break;
    }
    case 'restyle': {
      const flags = { direction: '', section: null, force: false };
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--direction') flags.direction = args[++i] || '';
        else if (a === '--section') flags.section = Number(args[++i]);
        else if (a === '--force') flags.force = true;
        else pos.push(a);
      }
      if (pos.length < 1)
        die('用法: sculptor.mjs restyle <工作区> [--direction 方向] [--section N] [--force]');
      await cmdRestyle(pos[0], flags);
      break;
    }
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`[sculptor] ${err.message}`);
  process.exit(1);
});
