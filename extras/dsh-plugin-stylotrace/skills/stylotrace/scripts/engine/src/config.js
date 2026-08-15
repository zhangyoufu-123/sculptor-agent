// Stylotrace Agent 配置：全部来自环境变量，绝不读宿主配置，天然无冲突。
// 例外（凭据发现）：未显式配置 STYLOTRACE_LLM_API_KEY 时，可自动复用宿主
// （Codex/Claude/OpenCode/env）已配置的 API —— 只读本机、绝不外发、绝不打印密钥。
import path from 'node:path';
import {
  discoverCredentials,
  loadWorkspaceCredentials,
  credentialsFile,
} from './credentials.js';

export function loadConfig(env = process.env) {
  const explicitKey = env.STYLOTRACE_LLM_API_KEY || '';
  const mode = env.STYLOTRACE_CREDENTIALS || 'auto';
  let apiKey = explicitKey;
  let baseUrl = env.STYLOTRACE_LLM_BASE_URL || '';
  let model = env.STYLOTRACE_LLM_MODEL || '';
  let credentialsSource = '';
  if (!explicitKey && mode !== 'off') {
    // 1) 工作区持久化凭据优先
    const wsHint = path.resolve(env.STYLOTRACE_WORKSPACE || path.join(process.cwd(), '.stylotrace'));
    const saved = loadWorkspaceCredentials(wsHint);
    // 2) 宿主发现（auto 模式自动采用最佳 OpenAI 兼容候选）
    const candidates = discoverCredentials(env);
    const best = candidates.find((c) => c.protocol === 'openai') || null;
    const chosen = saved && saved.apiKey ? saved : mode === 'auto' ? best : null;
    if (chosen) {
      apiKey = chosen.apiKey;
      baseUrl = baseUrl || chosen.baseUrl;
      model = model || chosen.model;
      credentialsSource = saved && saved.apiKey ? `workspace:${credentialsFile(wsHint)}` : chosen.source;
    }
  }
  return {
    baseUrl: (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: model || 'deepseek-v4-flash',
    credentialsSource,
    visionModel: env.STYLOTRACE_VISION_MODEL || '',
    fineTuneEndpoint: env.STYLOTRACE_FT_ENDPOINT || '',
    fineTuneApiKey: env.STYLOTRACE_FT_API_KEY || '',
    whisperCmd: env.STYLOTRACE_WHISPER_CMD || '',
    whisperTimeoutMs: Number(env.STYLOTRACE_WHISPER_TIMEOUT_MS || 300000),
    ragEndpoint: env.STYLOTRACE_RAG_ENDPOINT || '',
    ragApiKey: env.STYLOTRACE_RAG_API_KEY || '',
    searchProvider: env.STYLOTRACE_SEARCH_PROVIDER || '',
    searchApiKey: env.STYLOTRACE_SEARCH_API_KEY || '',
    embedBaseUrl: env.STYLOTRACE_EMBED_BASE_URL || '',
    embedApiKey: env.STYLOTRACE_EMBED_API_KEY || '',
    embedModel: env.STYLOTRACE_EMBED_MODEL || '',
    perplexityEndpoint: env.STYLOTRACE_PERPLEXITY_ENDPOINT || '',
    baselineText: env.STYLOTRACE_BASELINE_TEXT || '',
    styleEma: Number(env.STYLOTRACE_STYLE_EMA || 0.75),
    maxTokens: Number(env.STYLOTRACE_LLM_MAX_TOKENS || 8000),
    timeoutMs: Number(env.STYLOTRACE_LLM_TIMEOUT_MS || 300000),
    retries: Number(env.STYLOTRACE_LLM_RETRIES || 4),
    targetWords: Number(env.STYLOTRACE_TARGET_WORDS || 1000),
    quick: env.STYLOTRACE_QUICK === '1' || env.STYLOTRACE_QUICK === 'true',
    roundtrip: env.STYLOTRACE_ROUNDTRIP !== '0',
    workspace: env.STYLOTRACE_WORKSPACE || '',
  };
}
