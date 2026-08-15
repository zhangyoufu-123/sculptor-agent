// synthesize.js — 项目/上下文自动提炼写作（面向 DSH 程序员生态的核心能力）
//
// 目标：程序员不想自己写实验报告/产品介绍/技术综述/README/技术博客时，
// 把"项目里已经做出来的东西"提炼成文章——不需要用户逐项交代要求。
//
// 输入最小化：只给项目目录（缺省 = 当前目录）和可选的主题/文体，其余
// （项目素材、git 历史、会话上下文、风格档案）全部自动收集；LLM 负责
// 提炼"作者真正想表达什么"，并按作者已有写作风格成稿。
//
// 设计原则（与 README 主张一致）：
//   1) 从项目与上下文提炼，不编造事实——不确定处标【待核实】；
//   2) 有风格档案就用作者风格写（写作者想要的方向，而非通用范文）；
//   3) LLM 不可用时确定性兜底：从 README/package.json 组装结构化骨架，
//      标注「确定性模式（无 LLM）」，绝不崩溃；
//   4) 产出落盘到工作区 synthesized/，可导出 docx / html / md。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chatWithRetry } from './llm.js';
import * as ws from './workspace.js';
import { exportDocx, docxAvailable, exportHtml } from './io.js';

/** 支持的提炼文体（程序员场景 + 通用场景）。 */
export const SYNTHESIZE_TARGETS = {
  report: { label: '实验报告', title: '实验报告', hint: '背景/方法/结果/分析/结论，可复现、有数据支撑' },
  product: { label: '产品介绍', title: '产品介绍', hint: '它解决什么问题/给谁用/怎么用/亮点，读者是使用者与决策者' },
  review: { label: '技术综述', title: '技术综述', hint: '领域现状/本项目位置/关键方法与取舍/未来方向，有出处' },
  readme: { label: 'README', title: 'README', hint: '项目是什么/快速开始/主要能力/架构/许可证，开发者为读者' },
  blog: { label: '技术博客', title: '技术博客', hint: '有观点、有故事、有代码或数据佐证，写给同行看' },
  article: { label: '文章', title: '文章', hint: '通用长文：议论文/散文/致辞等，按主题与作者风格成稿' },
};

/** 扫描时跳过的目录（避免把依赖/构建产物当素材）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.stylotrace', 'dist', 'build', '.next', '.nuxt',
  'venv', '.venv', '__pycache__', '.codex', '.claude', '.agents', '.dsh',
  'web-data', 'api-data', '.idea', '.vscode', 'coverage', 'target', 'out',
]);

/** 信号文件：这些文件的优先级最高（README/包清单/文档）。 */
const SIGNAL_FILES = ['README.md', 'README', 'readme.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'docker-compose.yml'];

function safeRead(file, maxBytes = 40000) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 有界收集项目素材：信号文件 + 顶层文档 + 受限深度的 md 文档。 */
export function collectProjectMaterial(project, { maxFiles = 24, maxBytes = 300000 } = {}) {
  const out = [];
  const seen = new Set(); // 按 realpath 去重（macOS 大小写不敏感 + 多路扫描会重复命中同一文件）
  let budget = maxBytes;
  const push = (file) => {
    if (out.length >= maxFiles || budget <= 0) return;
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {}
    if (seen.has(real)) return;
    const text = safeRead(file, Math.min(40000, budget));
    if (!text) return;
    seen.add(real);
    budget -= text.length;
    out.push({ file: path.relative(project, file), text });
  };
  // 信号文件（README/清单优先）
  for (const name of SIGNAL_FILES) {
    const f = path.join(project, name);
    if (fs.existsSync(f)) push(f);
  }
  // 顶层 docs/ 目录
  const docsDir = path.join(project, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).sort()) {
      if (name.endsWith('.md') || name.endsWith('.mdx')) push(path.join(docsDir, name));
    }
  }
  // 受限深度遍历：*.md / *.txt（跳过 SKIP_DIRS）
  const walk = (dir, depth) => {
    if (depth > 3 || out.length >= maxFiles || budget <= 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(md|mdx|txt)$/i.test(e.name)) push(full);
    }
  };
  walk(project, 0);
  return out;
}

/** 最近 git 提交（一行一个）。 */
export function gitLog(project, n = 15) {
  try {
    const r = spawnSync('git', ['-C', project, 'log', '--oneline', `-${n}`], {
      encoding: 'utf8', timeout: 5000,
    });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** 工作区风格档案简报（语言层 write-style，若有）。 */
export function styleBrief(workspace) {
  const file = path.join(workspace, 'write-style.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dims = d.dimensions || d;
    const entries = Array.isArray(dims)
      ? dims
      : Object.entries(dims || {}).map(([k, v]) => ({ key: k, ...(typeof v === 'object' ? v : { value: v }) }));
    const lines = entries
      .filter((x) => x && (x.confidence || 0) >= 0.3)
      .slice(0, 10)
      .map((x) => `- ${x.key}: ${x.value ?? x.label ?? ''}${x.confidence ? `（置信 ${Math.round(x.confidence * 100)}%）` : ''}`);
    return lines.length ? `作者写作风格档案：\n${lines.join('\n')}` : '';
  } catch {
    return '';
  }
}

const TARGET_PROMPTS = {
  report: '一份实验报告：背景与目标、方法、结果（有数据就用数据）、分析、结论与展望。要求可复现、如实呈现，不确定处标【待核实】。',
  product: '一份产品介绍：它解决什么问题、给谁用、核心亮点、怎么用、与同类相比的取舍。读者是使用者与决策者，克制不吹嘘，不确定处标【待核实】。',
  review: '一份技术综述：领域现状、本项目的定位与关键方法、技术取舍与理由、已知局限与未来方向。有出处，不确定处标【待核实】。',
  readme: '一份 README：项目是什么、快速开始、主要能力、架构、配置与许可证。面向开发者，直接可用，不确定处标【待核实】。',
  blog: '一篇技术博客：有观点、有故事、有代码或数据佐证，写给同行看。像作者本人会写的样子，不确定处标【待核实】。',
  article: '一篇文章：按主题与作者的写作风格成稿，结构完整，有作者本人的表达习惯，不确定处标【待核实】。',
};

/** LLM 提炼写作（主路径）。 */
export async function synthesizeWithLlm(cfg, { target, projectRoot, material, log, style, topic, stateNotes }) {
  const t = SYNTHESIZE_TARGETS[target] || SYNTHESIZE_TARGETS.article;
  const materialText = material
    .map((m) => `--- ${m.file} ---\n${m.text.slice(0, 6000)}`)
    .join('\n\n')
    .slice(0, 60000);
  const user = [
    `项目目录：${projectRoot}`,
    topic ? `主题/意图：${topic}` : '',
    stateNotes ? `会话上下文（作者此前表达过的想法）：${stateNotes}` : '',
    log ? `最近提交（观察项目在做什么）：\n${log}` : '',
    style ? `\n${style}` : '',
    '\n项目素材：\n' + (materialText || '（未收集到项目素材，请基于以上上下文写作）'),
    `\n请写${t.label}。${TARGET_PROMPTS[target] || TARGET_PROMPTS.article}`,
    '要求：从项目与上下文里提炼作者真正想表达的东西，不编造项目里没有的事实；直接用作者的风格写，不要 AI 腔；直接输出 Markdown 正文，不要前言与解释。',
  ].filter(Boolean).join('\n');
  const r = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是写作提炼官：先读懂项目与作者，再动笔。你写出来的东西要像作者本人会写的，而不是通用范文。' },
      { role: 'user', content: user },
    ],
    { maxTokens: 4000, temperature: 0.8 },
  );
  return r.trim();
}

/** 确定性兜底：从 README/package.json 组装结构化骨架（无 LLM 也可用）。 */
export function synthesizeDeterministic({ target, projectRoot, material, log, topic }) {
  const t = SYNTHESIZE_TARGETS[target] || SYNTHESIZE_TARGETS.article;
  const readme = material.find((m) => /^readme/i.test(m.file));
  const pkg = material.find((m) => m.file === 'package.json');
  let pkgInfo = {};
  try {
    pkgInfo = pkg ? JSON.parse(pkg.text) : {};
  } catch {}
  const name = pkgInfo.name || path.basename(projectRoot);
  const desc = pkgInfo.description || (readme ? readme.text.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() : '') || '（README 缺失）';
  const deps = pkgInfo.dependencies ? Object.keys(pkgInfo.dependencies) : [];
  const readmeBody = readme ? readme.text.slice(0, 8000) : '';
  const lines = [
    `# ${topic || name}`,
    '',
    `> ${t.label}（确定性模式生成，未使用 LLM；数据来自项目素材，请人工核对）`,
    '',
    '## 项目概览',
    '',
    desc,
    '',
    '## 项目素材（自动化提取）',
    '',
    ...material.slice(0, 10).map((m) => `- \`${m.file}\``),
    '',
  ];
  if (deps.length) {
    lines.push('## 依赖', '', ...deps.map((d) => `- ${d}`), '');
  }
  if (readmeBody) {
    lines.push('## README 摘录', '', '```markdown', readmeBody.slice(0, 3000), '```', '');
  }
  if (log) {
    lines.push('## 最近提交', '', '```', log, '```', '');
  }
  lines.push('---', '本文由 Stylotrace 确定性模式自动提炼生成。配置 LLM 后运行 `stylotrace synthesize --target ' + target + '` 可得到 LLM 成稿。');
  return lines.join('\n');
}

/**
 * 项目/上下文自动提炼写作（统一入口）。
 * @param cfg 引擎配置（含 LLM）
 * @param wsDir 工作区目录
 * @param opts { project?, target?, topic?, format? }
 * @returns { mode, files, article, projectRoot, target }
 */
export async function synthesize(cfg, wsDir, opts = {}) {
  const { project = '', target = 'report', topic = '', format = 'md' } = opts;
  const workspace = ws.ensureWorkspace(wsDir);
  const targetKey = SYNTHESIZE_TARGETS[target] ? target : 'article';
  const projectRoot = project && fs.existsSync(project)
    ? path.resolve(project)
    : process.cwd();

  const material = collectProjectMaterial(projectRoot);
  const log = gitLog(projectRoot);
  const style = styleBrief(workspace);
  const state = ws.readState(workspace);
  const stateNotes = [state?.intent, state?.topic, state?.purpose].filter(Boolean).join('；');

  let article = '';
  let mode = 'llm';
  try {
    article = await synthesizeWithLlm(cfg, { target: targetKey, projectRoot, material, log, style, topic, stateNotes });
    if (!article) throw new Error('LLM 空输出');
  } catch (e) {
    mode = 'deterministic';
    article = synthesizeDeterministic({ target: targetKey, projectRoot, material, log, topic });
  }

  const slug = (topic || targetKey).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || targetKey;
  const outDir = path.join(workspace, 'synthesized');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${targetKey}-${slug}`);
  const files = [];
  fs.writeFileSync(`${base}.md`, article, 'utf8');
  files.push(`${base}.md`);
  if ((format === 'docx' || format === 'both') && docxAvailable()) {
    try { exportDocx(article, `${base}.docx`); files.push(`${base}.docx`); } catch {}
  }
  if ((format === 'html' || format === 'both')) {
    try { exportHtml(article, `${base}.html`); files.push(`${base}.html`); } catch {}
  }
  return { mode, files, article, projectRoot, target: targetKey };
}

export const SYNTHESIZE_RENDER = (r) =>
  `[${r.mode === 'llm' ? 'LLM 提炼' : '确定性模式'}] ${r.target} 已生成 → ${r.files.join(', ')}\n` +
  `素材来源: ${r.projectRoot}${r.mode === 'deterministic' ? '（未配置 LLM，请核对事实）' : ''}`;
