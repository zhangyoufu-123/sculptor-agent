// 凭据发现层：自动读取宿主（Codex / Claude Code / OpenCode）与常见环境变量里
// 已配置的 LLM API，让 Stylotrace 开箱即用，无需用户重复填 key。
// 原则：
//   1) 显式 STYLOTRACE_LLM_* 环境变量永远优先；
//   2) 绝不打印完整密钥——只显示来源与末 4 位；
//   3) 自动采用仅限 OpenAI 兼容（chat/completions）协议；Anthropic 等只检测提示；
//   4) 模式：STYLOTRACE_CREDENTIALS=auto（默认自动采用最佳候选）| ask（交互选择）| off（只用显式配置）。
// 用户选择可持久化到工作区 .stylotrace/credentials.json（0600）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 常见 OpenAI 兼容 API 环境变量候选（key → 默认端点/模型）
const ENV_CANDIDATES = [
  { key: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', protocol: 'openai' },
  { key: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', protocol: 'openai' },
  { key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', protocol: 'openai' },
  { key: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', protocol: 'openai' },
  { key: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'openai' },
  { key: 'ZHIPUAI_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', protocol: 'openai' },
  { key: 'GLM_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', protocol: 'openai' },
  { key: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', protocol: 'openai' },
  { key: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', protocol: 'anthropic' },
];

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 脱敏：只保留末 4 位。 */
export function redact(key) {
  const s = String(key || '');
  if (s.length <= 6) return '***';
  return `***${s.slice(-4)}`;
}

function toCandidate({ source, provider, baseUrl, apiKey, model, protocol = 'openai', wireApi = '' }) {
  return {
    source,
    provider: provider || '',
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(apiKey || ''),
    model: String(model || '').trim(),
    protocol,
    wireApi,
  };
}

/** 从环境变量发现候选。 */
export function discoverFromEnv(env = process.env) {
  const out = [];
  for (const c of ENV_CANDIDATES) {
    const key = env[c.key];
    if (!key) continue;
    // DeepSeek 允许通过 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL 覆盖默认端点与模型，
    // 避免 .env.local 里的 DEEPSEEK_MODEL 被硬编码默认值（deepseek-chat）吞掉。
    const baseUrl = c.key === 'DEEPSEEK_API_KEY' ? env.DEEPSEEK_BASE_URL || c.baseUrl : c.baseUrl;
    const model = c.key === 'DEEPSEEK_API_KEY' ? env.DEEPSEEK_MODEL || c.model : c.model;
    out.push(
      toCandidate({
        source: `env:${c.key}`,
        provider: c.key.replace(/_API_KEY$/, '').toLowerCase(),
        baseUrl,
        apiKey: key,
        model,
        protocol: c.protocol,
      }),
    );
  }
  return out;
}

/** 轻量解析 ~/.codex/config.toml 的 [model_providers.X] 块（无 TOML 依赖）。 */
export function discoverFromCodex(env = process.env, home = os.homedir()) {
  const file = path.join(home, '.codex', 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const topModel = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '';
  const activeProvider = text.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] || '';
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    const sec = line.match(/^\[model_providers\.([^\]]+)\]\s*$/);
    if (sec) {
      current = { name: sec[1].trim(), lines: [] };
      blocks.push(current);
    } else if (current && !/^\s*\[/.test(line)) {
      current.lines.push(line);
    } else if (/^\s*\[/.test(line)) {
      current = null;
    }
  }
  const candidates = [];
  for (const b of blocks) {
    const body = b.lines.join('\n');
    const baseUrl = body.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || '';
    const envKey = body.match(/env_key\s*=\s*"([^"]+)"/)?.[1] || '';
    const token = body.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1] || '';
    const wireApi = body.match(/wire_api\s*=\s*"([^"]+)"/)?.[1] || '';
    const key = envKey ? env[envKey] : token;
    if (!key || !baseUrl) continue;
    const protocol = wireApi === 'messages' ? 'anthropic' : 'openai';
    const cand = toCandidate({
      source: `codex-config:${b.name}`,
      provider: b.name,
      baseUrl,
      apiKey: key,
      model: topModel || '',
      protocol,
      wireApi,
    });
    if (b.name === activeProvider) cand.active = true;
    candidates.push(cand);
  }
  return candidates;
}

/** 从 Claude Code settings.json 的 env 块发现（Anthropic 协议，仅检测提示，不自动采用）。 */
export function discoverFromClaude(env = process.env, home = os.homedir()) {
  const settings = readJsonSafe(path.join(home, '.claude', 'settings.json'));
  const e = settings?.env || {};
  const key = e.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || '';
  if (!key) return [];
  return [
    toCandidate({
      source: 'claude-settings',
      provider: 'anthropic',
      baseUrl: e.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      apiKey: key,
      model: e.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      protocol: 'anthropic',
    }),
  ];
}

/** 从 OpenCode 配置发现（provider 的 envKey/baseURL，轻量扫描）。 */
export function discoverFromOpenCode(env = process.env, home = os.homedir()) {
  const config = readJsonSafe(path.join(home, '.config', 'opencode', 'opencode.json'));
  const out = [];
  const providers = config?.provider || config?.providers || {};
  for (const [name, p] of Object.entries(providers || {})) {
    const envKey = p?.envKey || p?.env_key || '';
    const key = envKey ? env[envKey] : p?.apiKey || '';
    const baseUrl = p?.baseURL || p?.baseUrl || p?.url || '';
    if (!key || !baseUrl) continue;
    out.push(
      toCandidate({
        source: `opencode-config:${name}`,
        provider: name,
        baseUrl,
        apiKey: key,
        model: p?.model || '',
      }),
    );
  }
  return out;
}

/**
 * 极简扁平 YAML 解析：只取顶层 `KEY: value` 映射（跳过注释、空行与缩进块）。
 * 零依赖，仅供 DSH 凭据文件（严格 CredentialRef→string 映射）使用。
 */
export function parseFlatYaml(text) {
  const map = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line || /^\s/.test(rawLine)) continue; // 空行 / 注释 / 缩进块(非顶层)
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) map[m[1]] = value;
  }
  return map;
}

/**
 * 从 DSH（DeepSeek Harness）凭据文件发现：$DSH_HOME/.credentials.yaml。
 * 该文件是严格的 CredentialRef→string 扁平映射（如 `DEEPSEEK_API_KEY: sk-xxx`），
 * 由 DSH 的 Models 页面/凭据层管理，权限 0600。让 Stylotrace 装在 DSH 里时
 * 开箱即用，无需用户重复填 key。
 */
export function discoverFromDsh(env = process.env, home = os.homedir()) {
  const dshHome = env.DSH_HOME || path.join(home, '.dsh');
  let text = '';
  try {
    text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
  } catch {
    return [];
  }
  const mapping = parseFlatYaml(text);
  const out = [];
  for (const c of ENV_CANDIDATES) {
    const key = mapping[c.key];
    if (!key) continue;
    const baseUrl = c.key === 'DEEPSEEK_API_KEY' ? mapping.DEEPSEEK_BASE_URL || c.baseUrl : c.baseUrl;
    const model = c.key === 'DEEPSEEK_API_KEY' ? mapping.DEEPSEEK_MODEL || c.model : c.model;
    out.push(
      toCandidate({
        source: `dsh-credentials:${c.key}`,
        provider: c.key.replace(/_API_KEY$/, '').toLowerCase(),
        baseUrl,
        apiKey: key,
        model,
        protocol: c.protocol,
      }),
    );
  }
  return out;
}

/** 汇总全部候选，OpenAI 兼容的排前，返回排序列表。 */
export function discoverCredentials(env = process.env, { home = os.homedir() } = {}) {
  const all = [
    ...discoverFromEnv(env),
    ...discoverFromCodex(env, home),
    ...discoverFromClaude(env, home),
    ...discoverFromOpenCode(env, home),
    ...discoverFromDsh(env, home),
  ];
  const score = (c) => {
    let s = c.protocol === 'openai' ? 100 : 0;
    if (c.active) s += 50;
    if (c.source.startsWith('env:')) s += 30;
    if (c.source.startsWith('codex-config:')) s += 20;
    if (c.source.startsWith('dsh-credentials:')) s += 25;
    return s;
  };
  return all.sort((a, b) => score(b) - score(a));
}

/** 工作区凭据文件路径（.stylotrace/credentials.json）。 */
export function credentialsFile(workspace) {
  return path.join(workspace, 'credentials.json');
}

export function loadWorkspaceCredentials(workspace) {
  return readJsonSafe(credentialsFile(workspace));
}

/** 保存用户选定的凭据（0600）。 */
export function saveCredentials(workspace, credentials) {
  const file = credentialsFile(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        model: credentials.model,
        source: credentials.source || 'manual',
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return file;
}

export function clearCredentials(workspace) {
  const file = credentialsFile(workspace);
  try {
    fs.rmSync(file, { force: true });
  } catch {}
  return file;
}

/** 候选的脱敏描述（不泄露密钥）。 */
export function describeCandidate(c) {
  const compat = c.protocol === 'openai' ? '' : '（Anthropic 协议，当前不自动采用）';
  return `[${c.source}] ${c.baseUrl} · model=${c.model || '（沿用默认）'} · key=${redact(c.apiKey)}${c.active ? ' · 当前激活' : ''}${compat}`;
}
