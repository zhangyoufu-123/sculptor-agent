// sculptor setup — 自动接入：检测本机宿主 → 走各宿主原生命令注册 → 自动发现凭据。
// 遵循开源 agent 模式（caveman/TLDR：检测全部 agent，逐个走原生安装路径；
// Claude Code `claude mcp add`；OpenCode `opencode mcp add`；Codex 项目级配置）。
// 默认 project 级接入：只有本项目对话能调用，不污染其他项目。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_SKILL = path.resolve(AGENT_ROOT, '..', 'skills', 'sculptor');
const BUNDLED_ENGINE_MCP = path.resolve(
  AGENT_ROOT,
  '..',
  'integration',
  'engine-mcp',
  'src',
  'mcp',
);
const CLI_BIN = path.join(AGENT_ROOT, 'bin', 'sculptor.js');

function log(msg) {
  console.log(msg);
}

function which(cmd) {
  const r = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function readTomlSecret(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  return {
    apiKey: text.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1] || '',
    baseUrl: text.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || '',
    model: text.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '',
  };
}

function readEnvLocal(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function discoverCredentials(projectDir) {
  const creds = {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || '',
    model: process.env.DEEPSEEK_MODEL || '',
  };
  const envLocal = readEnvLocal(path.join(projectDir, '.env.local'));
  if (!creds.apiKey) creds.apiKey = envLocal.DEEPSEEK_API_KEY || '';
  if (!creds.baseUrl) creds.baseUrl = envLocal.DEEPSEEK_BASE_URL || '';
  if (!creds.model) creds.model = envLocal.DEEPSEEK_MODEL || '';
  const fromCodex = readTomlSecret(path.join(os.homedir(), '.codex', 'config.toml'));
  if (!creds.apiKey) creds.apiKey = fromCodex.apiKey;
  if (!creds.baseUrl) creds.baseUrl = fromCodex.baseUrl;
  if (!creds.model) creds.model = fromCodex.model;
  return creds;
}

function ensureEngineMCP(engineDir, report) {
  if (!engineDir || !fs.existsSync(engineDir)) {
    report.push('引擎仓库: 未检测到（将使用轻量引擎 sculptor mcp）');
    return null;
  }
  const serverFile = path.join(engineDir, 'src', 'mcp', 'server.ts');
  if (fs.existsSync(serverFile)) {
    report.push(`引擎 MCP: 已存在 ${serverFile}`);
    return serverFile;
  }
  if (!fs.existsSync(BUNDLED_ENGINE_MCP)) {
    report.push('引擎 MCP 集成包缺失，无法自动接入（将用轻量引擎）');
    return null;
  }
  fs.mkdirSync(path.join(engineDir, 'src', 'mcp'), { recursive: true });
  fs.copyFileSync(
    path.join(BUNDLED_ENGINE_MCP, 'server.ts'),
    path.join(engineDir, 'src', 'mcp', 'server.ts'),
  );
  fs.copyFileSync(
    path.join(BUNDLED_ENGINE_MCP, 'workspace.ts'),
    path.join(engineDir, 'src', 'mcp', 'workspace.ts'),
  );
  // 注册 npm script（幂等）
  const pkgFile = path.join(engineDir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.scripts = pkg.scripts || {};
      if (!pkg.scripts['sculptor:mcp']) {
        pkg.scripts['sculptor:mcp'] = 'tsx --tsconfig tsconfig.json src/mcp/server.ts';
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
        report.push('引擎 MCP: 已复制代码并注册 npm run sculptor:mcp');
      } else {
        report.push('引擎 MCP: 已复制代码（script 已存在）');
      }
    } catch {
      report.push('引擎 MCP: 已复制代码，但 package.json 无法解析');
    }
  }
  return serverFile;
}

function mcpEntry(engineServerFile) {
  if (
    engineServerFile &&
    fs.existsSync(
      path.join(
        path.dirname(path.dirname(path.dirname(engineServerFile))),
        'node_modules',
        '.bin',
        'tsx',
      ),
    )
  ) {
    const engineDir = path.dirname(path.dirname(path.dirname(engineServerFile)));
    return {
      command: path.join(engineDir, 'node_modules', '.bin', 'tsx'),
      args: ['--tsconfig', path.join(engineDir, 'tsconfig.json'), engineServerFile],
    };
  }
  return { command: process.execPath, args: [CLI_BIN, 'mcp'] };
}

function ensureCodexProjectConfig(projectDir, entry, dry, report) {
  const cfgDir = path.join(projectDir, '.codex');
  const cfg = path.join(cfgDir, 'config.toml');
  const block = `\n[mcp_servers.sculptor-engine]\ncommand = "${entry.command}"\nargs = [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  if (dry) {
    report.push(`[dry-run] Codex 项目配置 → ${cfg}`);
    return;
  }
  fs.mkdirSync(cfgDir, { recursive: true });
  if (
    fs.existsSync(cfg) &&
    fs.readFileSync(cfg, 'utf8').includes('[mcp_servers.sculptor-engine]')
  ) {
    report.push('Codex: 项目配置已存在，跳过');
    return;
  }
  if (fs.existsSync(cfg)) {
    fs.copyFileSync(cfg, `${cfg}.bak.${Date.now()}`);
  }
  fs.appendFileSync(cfg, block);
  report.push(`Codex: 已写入项目级 MCP 配置（备份原文件）→ ${cfg}`);
}

function registerClaude(entry, dry, report) {
  const claude = which('claude');
  if (!claude) {
    report.push('Claude Code: 未检测到，跳过');
    return;
  }
  if (dry) {
    report.push(
      `[dry-run] claude mcp add sculptor-engine --transport stdio -- ${entry.command} ${entry.args.join(' ')}`,
    );
    return;
  }
  const r = spawnSync(
    claude,
    [
      'mcp',
      'add',
      'sculptor-engine',
      '--transport',
      'stdio',
      '--scope',
      'local',
      '--',
      entry.command,
      ...entry.args,
    ],
    { encoding: 'utf8' },
  );
  report.push(
    r.status === 0
      ? `Claude Code: 已注册（${r.stdout.trim().slice(0, 80) || 'ok'}）`
      : `Claude Code: 注册失败（${r.stderr.trim().slice(0, 120)}）`,
  );
}

function registerOpencode(entry, dry, report) {
  const opencode = which('opencode');
  if (!opencode) {
    report.push('OpenCode: 未检测到，跳过');
    return;
  }
  if (dry) {
    report.push(
      `[dry-run] opencode mcp add sculptor-engine -- ${entry.command} ${entry.args.join(' ')}`,
    );
    return;
  }
  const r = spawnSync(
    opencode,
    ['mcp', 'add', 'sculptor-engine', '--', entry.command, ...entry.args],
    { encoding: 'utf8' },
  );
  report.push(
    r.status === 0 ? 'OpenCode: 已注册' : `OpenCode: 注册失败（${r.stderr.trim().slice(0, 120)}）`,
  );
}

function ensureSkill(projectDir, dry, report) {
  if (!fs.existsSync(BUNDLED_SKILL)) {
    report.push('skill 包缺失，跳过');
    return;
  }
  const dest = path.join(projectDir, '.codex', 'skills', 'sculptor');
  if (dry) {
    report.push(`[dry-run] skill → ${dest}`);
    return;
  }
  if (fs.existsSync(dest)) {
    report.push(`skill: 已存在 ${dest}，跳过（如需更新请先删除）`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(BUNDLED_SKILL, dest, { recursive: true });
  report.push(`skill: 已安装 → ${dest}`);
}

function writeCredentials(engineDir, projectDir, creds, dry, report) {
  if (!creds.apiKey) {
    report.push('凭据: 未发现 DEEPSEEK_API_KEY（可在 .env.local 或环境变量里配置）');
    return;
  }
  const target =
    engineDir && fs.existsSync(engineDir)
      ? path.join(engineDir, '.env.local')
      : path.join(projectDir, '.env.local');
  if (dry) {
    report.push(`[dry-run] 凭据 → ${target}（来自本机已有配置，权限 0600）`);
    return;
  }
  const lines = [`DEEPSEEK_API_KEY=${creds.apiKey}`];
  if (creds.baseUrl) lines.push(`DEEPSEEK_BASE_URL=${creds.baseUrl}`);
  if (creds.model) lines.push(`DEEPSEEK_MODEL=${creds.model}`);
  fs.writeFileSync(target, lines.join('\n') + '\n', { mode: 0o600 });
  report.push(`凭据: 已写入 ${target}（0600，复用自本机已有配置）`);
}

export async function runSetup(flags = {}) {
  const dry = Boolean(flags['dry-run']);
  const projectDir = path.resolve(flags.dir || process.cwd());
  // 引擎仓库路径可配置：--engine 或环境变量 SCULPTOR_ENGINE_DIR；未配置时使用轻量引擎。
  const engineDir = flags.engine || process.env.SCULPTOR_ENGINE_DIR || '';
  const hosts = flags.hosts
    ? flags.hosts
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['codex', 'claude', 'opencode'];
  const report = [];

  log(`Sculptor 自动接入（${dry ? 'dry-run' : '执行'}）`);
  log(`项目: ${projectDir}（项目级接入，只有本项目对话可用）`);
  log('');

  const serverFile = ensureEngineMCP(engineDir, report);
  const entry = mcpEntry(serverFile);
  ensureCodexProjectConfig(projectDir, entry, dry, report);
  if (hosts.includes('claude')) registerClaude(entry, dry, report);
  if (hosts.includes('opencode')) registerOpencode(entry, dry, report);
  ensureSkill(projectDir, dry, report);
  const creds = discoverCredentials(projectDir);
  writeCredentials(engineDir, projectDir, creds, dry, report);

  log('── 接入报告 ──');
  for (const line of report) log(`• ${line}`);
  log('');
  if (dry) {
    log('dry-run 结束，未写入任何文件。');
  } else {
    log('完成。在该项目里新开对话即可使用；其他项目不受影响。');
  }
}
