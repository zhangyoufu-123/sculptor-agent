#!/usr/bin/env node
// Sculptor Agent CLI 入口。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { chat } from './llm.js';
import * as ws from './workspace.js';
import { clarifyOnce, clarifyInteractive } from './clarify.js';
import { generateOutline } from './outline.js';
import { writeSection } from './write.js';
import { redteam, audit } from './redteam.js';
import { dissect } from './dissect.js';
import { runMcpServer } from './mcp.js';
import { runSetup } from './setup.js';
import { pointEdit } from './point-edit.js';
import { probeTask } from './observer.js';

const HELP = `Sculptor Agent v0.3 — 完整写作 Agent（独立运行 + MCP 协作）

用法:
  sculptor init [目录]                初始化工作区（默认 ./.sculptor）
  sculptor clarify [工作区]           交互澄清（一次一问）
  sculptor clarify --once [工作区]    单步澄清：应用 stdin 的回答，输出下一个问题
  sculptor outline [工作区]           生成大纲（素材门槛未过会报错）
  sculptor write [--from N] [工作区]  按大纲逐节写作到 draft.md
  sculptor write --section N [工作区] 只写第 N 节
  sculptor redteam [--fix] [工作区]   反 AI 审计（可选 LLM 修订）
  sculptor redteam --file x.md        直接审计任意文件
  sculptor dissect [--file x.md] [工作区]  感性解剖 5 维度
  sculptor absorb <工作区> <edit.json>   吸收定点修改进风格档案
  sculptor fingerprint <工作区>       刷新压缩守卫风格指纹
  sculptor panel [state.json]         渲染玻璃面板
  sculptor status [工作区]            工作区摘要
  sculptor doctor [--ping]            自检（可选连通性测试）
  sculptor mcp                       启动 MCP stdio 服务器（供 Codex/Claude Code/OpenCode 调用）
  sculptor setup [--dry-run] [--dir 项目] [--engine 引擎路径] [--hosts codex,claude,opencode]
                                     自动接入：检测宿主→原生注册→装 skill→复用本机凭据
  sculptor point-edit "<引用/原文>" "<修改指令>" [--dir 项目] [--file 文件]
                                     深度定点修改：只改选中的那一处，吸收进风格档案
  sculptor probe "<任务描述>"         生态位探测：该不该让 Sculptor 主动介入

环境变量（可选，默认指向 DeepSeek）:
  SCULPTOR_LLM_BASE_URL  SCULPTOR_LLM_API_KEY  SCULPTOR_LLM_MODEL
  SCULPTOR_LLM_MAX_TOKENS  SCULPTOR_LLM_TIMEOUT_MS  SCULPTOR_WORKSPACE
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      if (val !== true) i += 1;
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

function printError(err) {
  console.error(`[sculptor] ${err.message}`);
  process.exitCode = 1;
}

async function doctor(cfg, { ping = false } = {}) {
  const report = [];
  report.push(`Node: ${process.version} ${Number(process.versions.node.split('.')[0]) >= 18 ? '✓' : '✗（需要 ≥18）'}`);
  report.push(`LLM 端点: ${cfg.baseUrl}（模型 ${cfg.model}）${cfg.apiKey ? '✓ 已配置密钥' : '⚠ 未配置密钥（可用 mock 或本地服务）'}`);
  const w = ws.resolveWorkspace(cfg, '');
  report.push(`工作区: ${w} ${fs.existsSync(w) ? '✓' : '（未初始化）'}`);
  if (fs.existsSync(`${w}/vault/write-style.json`)) {
    report.push(`风格档案: write ${ws.styleDimSummary(`${w}/vault/write-style.json`)} · read ${ws.styleDimSummary(`${w}/vault/read-style.json`)}`);
  }
  if (ping) {
    try {
      const r = await chat(cfg, [{ role: 'user', content: 'ping' }], { maxTokens: 16, temperature: 0 });
      report.push(`LLM 连通: ✓（${r.trim().slice(0, 40)}）`);
    } catch (err) {
      report.push(`LLM 连通: ✗ ${err.message.slice(0, 120)}`);
      process.exitCode = 1;
    }
  }
  console.log(report.join('\n'));
}

export async function runCli(argv, io = {}) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();
  const { flags, positional } = parseArgs(rest);
  const workspace = flags.workspace || positional[0] || '';

  try {
    switch (cmd) {
      case 'init': {
        const dir = flags.dir || positional[0] || '';
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, dir), { create: true });
        console.log(`Sculptor 工作区已初始化 → ${w}`);
        break;
      }
      case 'panel': {
        const f = positional[0] || `${workspace || path.join(process.cwd(), '.sculptor')}/protocol/state.json`;
        console.log(ws.renderPanel(f));
        break;
      }
      case 'status': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        console.log(ws.statusReport(w));
        break;
      }
      case 'clarify': {
        const w = ws.resolveWorkspace(cfg, workspace);
        if (flags.once) {
          const r = await clarifyOnce(cfg, w, { input: io.input });
          console.log(JSON.stringify(r, null, 2));
        } else {
          await clarifyInteractive(cfg, w);
        }
        break;
      }
      case 'outline': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await generateOutline(cfg, w);
        console.log(`《${r.outline.title}》 ${r.outline.sections.length} 节\n`);
        r.outline.sections.forEach((s, i) => console.log(`${i + 1}. ${s.heading}（${s.function}）\n   ${(s.keyPoints || []).join(' / ')}`));
        break;
      }
      case 'write': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const index = flags.section !== undefined ? Number(flags.section) : null;
        const r = await writeSection(cfg, w, { index, force: Boolean(flags.force) });
        console.log(`已写入 ${r.sections} 节 → ${r.draftFile}`);
        for (const s of r.report) {
          console.log(`  ${s.index}. ${s.heading}：目标 ${s.target} 字 / 实际 ${s.actual} 字${s.expanded ? '（已扩写）' : ''}`);
        }
        console.log(`合计 ${r.total} 字（目标 ${cfg.targetWords} 字）`);
        break;
      }
      case 'redteam': {
        const w = ws.resolveWorkspace(cfg, workspace);
        if (flags.file) {
          const text = fs.readFileSync(flags.file, 'utf8');
          const report = audit(text);
          console.log(JSON.stringify(report, null, 2));
          process.exitCode = report.passed ? 0 : 1;
        } else {
          const r = await redteam(cfg, w, { fix: Boolean(flags.fix) });
          console.log(JSON.stringify(r.report, null, 2));
          process.exitCode = r.report.passed ? 0 : 1;
        }
        break;
      }
      case 'dissect': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await dissect(cfg, w, { file: flags.file || null });
        console.log(JSON.stringify(r.report, null, 2));
        break;
      }
      case 'absorb': {
        if (positional.length < 2) throw new Error('用法: sculptor absorb <工作区> <edit.json>');
        const w = ws.resolveWorkspace(cfg, positional[0]);
        const edit = JSON.parse(fs.readFileSync(positional[1], 'utf8'));
        const r = ws.absorbEdit(w, edit);
        console.log(`write ${r.writeUpdated} 维 + read ${r.readUpdated} 维已更新`);
        break;
      }
      case 'fingerprint': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const fp = ws.refreshFingerprint(w);
        console.log(`风格指纹已刷新: ${fp.highConfidenceDimensions.length} 个高置信度维度`);
        break;
      }
      case 'doctor':
        await doctor(cfg, { ping: Boolean(flags.ping) });
        break;
      case 'mcp':
        await runMcpServer(io);
        break;
      case 'setup':
        await runSetup(flags);
        break;
      case 'point-edit': {
        if (positional.length < 2) throw new Error('用法: sculptor point-edit "<引用/原文>" "<修改指令>" [--dir 项目] [--file 文件]');
        const r = await pointEdit(cfg, ws.resolveWorkspace(cfg, flags.workspace || ''), {
          quote: positional[0],
          instruction: positional[1],
          dir: flags.dir,
          file: flags.file,
        });
        console.log(`已定点修改: ${r.file}`);
        console.log(`- ${r.quote}`);
        console.log(`+ ${r.replacement}`);
        console.log(`风格吸收: write ${r.writeUpdated} 维 + read ${r.readUpdated} 维`);
        break;
      }
      case 'probe': {
        const text = flags.text || positional.join(' ');
        if (!text) throw new Error('用法: sculptor probe "<任务描述>"');
        console.log(JSON.stringify(probeTask(text), null, 2));
        break;
      }
      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    printError(err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
