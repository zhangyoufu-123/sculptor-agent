// CJS preload：把 globalThis.fetch 指向本地 mock LLM。
// 用法：node --require ./test/preload-fetch.cjs <sculptor-bin> <命令...>
// 用途：离线安装验证 / CI（沙箱无外网时跑通全流程）。
const { pathToFileURL } = require('node:url');
const path = require('node:path');

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const { respond } = await import(pathToFileURL(path.join(__dirname, 'mock-llm.mjs')).href);
  const content = respond(body.messages || []);
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
  };
};
