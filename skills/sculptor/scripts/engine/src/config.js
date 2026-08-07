// Sculptor Agent 配置：全部来自环境变量，绝不读宿主配置，天然无冲突。
export function loadConfig(env = process.env) {
  return {
    baseUrl: (env.SCULPTOR_LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env.SCULPTOR_LLM_API_KEY || '',
    model: env.SCULPTOR_LLM_MODEL || 'deepseek-v4-flash',
    visionModel: env.SCULPTOR_VISION_MODEL || '',
    maxTokens: Number(env.SCULPTOR_LLM_MAX_TOKENS || 8000),
    timeoutMs: Number(env.SCULPTOR_LLM_TIMEOUT_MS || 300000),
    targetWords: Number(env.SCULPTOR_TARGET_WORDS || 1000),
    workspace: env.SCULPTOR_WORKSPACE || '',
  };
}
