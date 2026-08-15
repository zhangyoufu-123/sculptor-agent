#!/usr/bin/env node
/**
 * dsh-plugin-stylotrace — 多宿主安装 / 自检 CLI
 *
 * 同一个技能包装入所有 Agent 宿主,DSH 插件本体(MCP 桥)则由 dsh plugin add 负责:
 *
 *   stylotrace-plugin install [--all] [--project <dir>] [--global]
 *   stylotrace-plugin status
 *   stylotrace-plugin doctor
 *
 * 目标宿主:
 *   dsh      $DSH_HOME/skills/stylotrace        (默认 ~/.dsh/skills)
 *            <project>/.dsh/skills/stylotrace
 *   agents   ~/.agents/skills/stylotrace        (Codex/Claude/OpenCode 共享的 agents 根)
 *   codex    ~/.codex/skills/stylotrace         (--global) 或 <project>/.codex/skills/stylotrace
 *   claude   ~/.claude/skills/stylotrace
 *   opencode ~/.config/opencode/skills/stylotrace
 *
 * 未来 DeepSeek 开放 curated agent 上传时,本包 skills/stylotrace 即为可直接上传的
 * 完整 Agent 清单(SKILL.md + 引擎 + references + protocol),无需再改结构。
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SKILL_DIR = path.join(PKG_DIR, 'skills', 'stylotrace')
const ENGINE_BIN = path.join(SKILL_DIR, 'scripts', 'engine', 'bin', 'stylotrace.js')

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

const HOSTS = {
  dsh: {
    label: 'DSH(用户级)',
    install: () => [path.join(DSH_HOME, 'skills', 'stylotrace')],
  },
  'dsh-project': {
    label: 'DSH(项目级)',
    install: (project) => (project ? [path.join(project, '.dsh', 'skills', 'stylotrace')] : []),
  },
  agents: {
    label: '~/.agents(共享)',
    install: () => [path.join(HOME, '.agents', 'skills', 'stylotrace')],
  },
  codex: {
    label: 'Codex',
    install: (project, global) =>
      global
        ? [path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills', 'stylotrace')]
        : project
          ? [path.join(project, '.codex', 'skills', 'stylotrace')]
          : [],
  },
  claude: {
    label: 'Claude Code',
    install: (project, global) =>
      global ? [path.join(HOME, '.claude', 'skills', 'stylotrace')] : [],
  },
  opencode: {
    label: 'OpenCode',
    install: (project, global) =>
      global
        ? [path.join(HOME, '.config', 'opencode', 'skills', 'stylotrace')]
        : project
          ? [path.join(project, '.opencode', 'skills', 'stylotrace')]
          : [],
  },
}

function log(...args) { console.log(...args) }
function err(...args) { console.error(...args) }

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
  // 保留可执行位(引擎 bin / hook 脚本)
  for (const p of ['scripts/engine/bin/stylotrace.js', 'hooks/stylotrace-hook.sh']) {
    try { fs.chmodSync(path.join(dest, p), 0o755) } catch { /* ignore */ }
  }
}

function installHost(name, project, globalFlag) {
  const targets = HOSTS[name].install(project, globalFlag)
  for (const dest of targets) {
    if (!fs.existsSync(SKILL_DIR)) {
      err(`错误: 本包内未找到技能包 ${SKILL_DIR}(请先运行 npm run vendor)`)
      process.exit(1)
    }
    copyDir(SKILL_DIR, dest)
    log(`[ok] ${HOSTS[name].label} → ${dest}`)
  }
  if (targets.length === 0) log(`[skip] ${HOSTS[name].label}(未命中目标,需要 --global 或 --project)`)
}

function install(argv) {
  const flags = new Set(argv)
  const all = flags.has('--all')
  const globalFlag = flags.has('--global')
  const projectIdx = argv.indexOf('--project')
  const project = projectIdx >= 0 ? argv[projectIdx + 1] : process.cwd()

  const pick = (name) => all || flags.has(`--${name}`)
  if (pick('dsh')) installHost('dsh', project, globalFlag)
  if (all || flags.has('--dsh-project')) installHost('dsh-project', project, globalFlag)
  if (pick('agents')) installHost('agents', project, globalFlag)
  if (pick('codex')) installHost('codex', project, globalFlag)
  if (pick('claude')) installHost('claude', project, globalFlag)
  if (pick('opencode')) installHost('opencode', project, globalFlag)
  if (!all && ![...flags].some((f) => f.startsWith('--') && HOSTS[f.slice(2)])) {
    log('未指定宿主,默认安装全部(--all)')
    install(['--all', ...argv.filter((a) => a.startsWith('--'))])
  }
}

function status() {
  log('=== Stylotrace 技能安装状态 ===')
  const probe = (label, p) => log(`  ${fs.existsSync(p) ? '✓' : '·'} ${label} → ${p}`)
  probe(HOSTS.dsh.label, path.join(DSH_HOME, 'skills', 'stylotrace'))
  probe('DSH(项目级)', path.join(process.cwd(), '.dsh', 'skills', 'stylotrace'))
  probe(HOSTS.agents.label, path.join(HOME, '.agents', 'skills', 'stylotrace'))
  probe(HOSTS.codex.label, path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills', 'stylotrace'))
  probe(HOSTS.claude.label, path.join(HOME, '.claude', 'skills', 'stylotrace'))
  probe(HOSTS.opencode.label, path.join(HOME, '.config', 'opencode', 'skills', 'stylotrace'))
  log(`\nMCP 桥: ${fs.existsSync(ENGINE_BIN) ? '引擎就绪' : '引擎缺失(运行 npm run vendor)'}`)
}

/**
 * doctor — 启动引擎的 MCP stdio 服务器,完成 initialize + tools/list 握手,
 * 验证工具面完整可用(不调用任何 LLM)。
 */
async function doctor() {
  if (!fs.existsSync(ENGINE_BIN)) {
    err(`错误: 引擎缺失 ${ENGINE_BIN}(请先运行 npm run vendor)`)
    process.exit(1)
  }
  log(`引擎: ${ENGINE_BIN}`)
  const child = spawn(process.execPath, [ENGINE_BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 1

  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时: ${method}`)) } }, 15000)
    })

  try {
    const init = await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-plugin-stylotrace-doctor', version: '0.1.0' },
    })
    log(`握手: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`)
    const tools = await call('tools/list', {})
    const names = tools.result.tools.map((t) => t.name)
    log(`工具面: ${names.length} 个`)
    log(`  ${names.join(' / ')}`)
    child.kill()
    process.exit(0)
  } catch (e) {
    err(`doctor 失败: ${e.message}`)
    child.kill()
    process.exit(1)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'install': install(rest); break
  case 'status': status(); break
  case 'doctor': await doctor(); break
  case 'help': case '--help': case '-h':
    log(`用法:
  stylotrace-plugin install [--all|--dsh|--agents|--codex|--claude|--opencode] [--project <dir>] [--global]
  stylotrace-plugin status
  stylotrace-plugin doctor`)
    break
  default:
    err(`未知命令: ${cmd || '(空)'}`)
    process.exit(1)
}
