// Sculptor Agent 配置：全部来自环境变量，绝不读宿主配置，天然无冲突。
export function loadConfig(env = process.env) {
  return {
    baseUrl: (env.SCULPTOR_LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env.SCULPTOR_LLM_API_KEY || '',
    model: env.SCULPTOR_LLM_MODEL || 'deepseek-v4-flash',
    visionModel: env.SCULPTOR_VISION_MODEL || '',
    fineTuneEndpoint: env.SCULPTOR_FT_ENDPOINT || '',
    fineTuneApiKey: env.SCULPTOR_FT_API_KEY || '',
    whisperCmd: env.SCULPTOR_WHISPER_CMD || '',
    whisperTimeoutMs: Number(env.SCULPTOR_WHISPER_TIMEOUT_MS || 300000),
    ragEndpoint: env.SCULPTOR_RAG_ENDPOINT || '',
    ragApiKey: env.SCULPTOR_RAG_API_KEY || '',
    maxTokens: Number(env.SCULPTOR_LLM_MAX_TOKENS || 8000),
    timeoutMs: Number(env.SCULPTOR_LLM_TIMEOUT_MS || 300000),
    targetWords: Number(env.SCULPTOR_TARGET_WORDS || 1000),
    quick: env.SCULPTOR_QUICK === '1' || env.SCULPTOR_QUICK === 'true',
    workspace: env.SCULPTOR_WORKSPACE || '',
  };
}
