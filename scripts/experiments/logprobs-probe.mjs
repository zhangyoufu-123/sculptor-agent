#!/usr/bin/env node
// logprobs 探测（v0.68，B6 前置）：验证当前 LLM API 是否返回逐 token logprobs，
// 以决定 V2（词级候选重排）是否可行；不支持就明确降级并文档化。
// 用法：node scripts/experiments/logprobs-probe.mjs
// 凭据与模型：复用 agent/src/config.js 的发现逻辑（含 .env.local 的 DEEPSEEK_*）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 加载仓库根目录 .env.local（若存在），让 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL 等进入 process.env；
// 已存在的环境变量优先，不覆盖。
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const { loadConfig } = await import(path.join(ROOT, 'agent', 'src', 'config.js'));
const { redact } = await import(path.join(ROOT, 'agent', 'src', 'credentials.js'));
const cfg = loadConfig();

const base = cfg.baseUrl.replace(/\/+$/, '');
const url = `${base}/chat/completions`;
const headers = {
  'Content-Type': 'application/json',
  ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
};

console.log('baseUrl:', cfg.baseUrl);
console.log('model:', cfg.model);
console.log('apiKey:', cfg.apiKey ? redact(cfg.apiKey) : '(none)');

async function call(body, label) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  console.log(`\n--- ${label} ---`);
  console.log('HTTP', res.status);
  if (!res.ok) {
    console.log('error:', text.slice(0, 600));
    return null;
  }
  const choice = data?.choices?.[0];
  const content = choice?.logprobs?.content;
  const has = Array.isArray(content) && content.length > 0;
  console.log('choice keys:', choice ? Object.keys(choice).join(', ') : '(none)');
  console.log('logprobs keys:', choice?.logprobs ? Object.keys(choice.logprobs).join(', ') : '(null)');
  console.log(
    'reasoning_content len:',
    Array.isArray(choice?.logprobs?.reasoning_content) ? choice.logprobs.reasoning_content.length : 'n/a',
  );
  console.log('content len:', Array.isArray(content) ? content.length : 'n/a');
  console.log('message.content:', JSON.stringify(choice?.message?.content ?? '')?.slice(0, 120));
  console.log('logprobs.content present:', has);
  if (has) console.log('sample:', JSON.stringify(content[0]).slice(0, 600));
  return data;
}

const messages = [{ role: 'user', content: '用一个字回答颜色：红' }];

// 1) 显式请求 logprobs
await call(
  { model: cfg.model, messages, max_tokens: 2, temperature: 0, logprobs: true, top_logprobs: 5 },
  'with logprobs',
);

// 2) 基线：不带 logprobs，确认模型本身可用（区分"参数不支持"与"模型无效"）
await call({ model: cfg.model, messages, max_tokens: 2, temperature: 0 }, 'baseline (no logprobs)');

console.log('\n结论：若上面两项都 200 且 with logprobs 的 logprobs.content 为 true，则 V2 词级重排可行；');
console.log('若 with logprobs 返回 4xx 错误或 logprobs.content 为空，则当前 API 不支持逐 token logprobs，V2 需降级。');
