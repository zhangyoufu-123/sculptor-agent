// Stylotrace Agent 配置：全部来自环境变量，绝不读宿主配置，天然无冲突。
// 例外（凭据发现）：未显式配置 SCULPTOR_LLM_API_KEY 时，可自动复用宿主
// （Codex/Claude/OpenCode/env）已配置的 API —— 只读本机、绝不外发、绝不打印密钥。
import path from 'node:path';
import {
  discoverCredentials,
  loadWorkspaceCredentials,
  credentialsFile,
} from './credentials.js';

export function loadConfig(env = process.env) {
  const explicitKey = env.SCULPTOR_LLM_API_KEY || '';
  const mode = env.SCULPTOR_CREDENTIALS || 'auto';
  let apiKey = explicitKey;
  let baseUrl = env.SCULPTOR_LLM_BASE_URL || '';
  let model = env.SCULPTOR_LLM_MODEL || '';
  let credentialsSource = '';
  if (!explicitKey && mode !== 'off') {
    // 1) 工作区持久化凭据优先
    const wsHint = path.resolve(env.SCULPTOR_WORKSPACE || path.join(process.cwd(), '.sculptor'));
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
    visionModel: env.SCULPTOR_VISION_MODEL || '',
    fineTuneEndpoint: env.SCULPTOR_FT_ENDPOINT || '',
    fineTuneApiKey: env.SCULPTOR_FT_API_KEY || '',
    whisperCmd: env.SCULPTOR_WHISPER_CMD || '',
    whisperTimeoutMs: Number(env.SCULPTOR_WHISPER_TIMEOUT_MS || 300000),
    ragEndpoint: env.SCULPTOR_RAG_ENDPOINT || '',
    ragApiKey: env.SCULPTOR_RAG_API_KEY || '',
    searchProvider: env.SCULPTOR_SEARCH_PROVIDER || '',
    searchApiKey: env.SCULPTOR_SEARCH_API_KEY || '',
    embedBaseUrl: env.SCULPTOR_EMBED_BASE_URL || '',
    embedApiKey: env.SCULPTOR_EMBED_API_KEY || '',
    embedModel: env.SCULPTOR_EMBED_MODEL || '',
    perplexityEndpoint: env.SCULPTOR_PERPLEXITY_ENDPOINT || '',
    baselineText: env.SCULPTOR_BASELINE_TEXT || '',
    styleEma: Number(env.SCULPTOR_STYLE_EMA || 0.75),
    maxTokens: Number(env.SCULPTOR_LLM_MAX_TOKENS || 8000),
    timeoutMs: Number(env.SCULPTOR_LLM_TIMEOUT_MS || 300000),
    retries: Number(env.SCULPTOR_LLM_RETRIES || 4),
    targetWords: Number(env.SCULPTOR_TARGET_WORDS || 1000),
    quick: env.SCULPTOR_QUICK === '1' || env.SCULPTOR_QUICK === 'true',
    roundtrip: env.SCULPTOR_ROUNDTRIP !== '0',
    workspace: env.SCULPTOR_WORKSPACE || '',
  };
}
