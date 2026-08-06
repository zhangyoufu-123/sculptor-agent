// LLM 客户端：OpenAI 兼容 chat/completions（DeepSeek / GLM / OpenAI / 本地服务均可）。
// 可靠性：超时、指数退避重试、空响应重试（推理模型可能把 token 用尽）。
export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class LlmEmptyError extends LlmError {
  constructor(message = 'LLM 返回空内容（推理模型可能把 token 用尽）') {
    super(message, { retryable: true });
    this.name = 'LlmEmptyError';
  }
}

export async function chat(cfg, messages, opts = {}) {
  const { maxTokens = cfg.maxTokens, temperature = 0.8, json = false } = opts;
  const url = `${cfg.baseUrl}/chat/completions`;
  const body = { model: cfg.model, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LlmError(`网络请求失败: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`LLM API ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LlmEmptyError();
  }
  return content;
}

export async function chatWithRetry(cfg, messages, opts = {}) {
  const retries = opts.retries ?? 4;
  const baseDelay = opts.baseDelay ?? 1500;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await chat(cfg, messages, opts);
    } catch (err) {
      lastErr = err;
      if (!err.retryable) throw err;
      if (i === retries - 1) break;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** i));
    }
  }
  throw lastErr;
}

// 从 LLM 文本中提取 JSON（容忍代码围栏与前后缀）。
export function parseJsonContent(content, label = 'LLM 输出') {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    throw new LlmError(`${label} 不是合法 JSON: ${cleaned.slice(0, 200)}`);
  }
}
