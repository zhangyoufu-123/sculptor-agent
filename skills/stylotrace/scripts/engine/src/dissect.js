// 感性解剖：5 维度报告（立场/局限/困惑/多视角/风格兑现度）。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import { DISSECT_PROMPT } from './prompts.js';
import * as ws from './workspace.js';

export async function dissect(cfg, wsDir, { file = null } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const target = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(target)) throw new Error(`找不到文本: ${target}`);
  const text = fs.readFileSync(target, 'utf8').slice(0, 20000);
  const ctx = {
    text,
    writeStyle: JSON.stringify(
      ws.readJson(path.join(workspace, 'vault', 'write-style.json')).dimensions || {},
      null,
      0,
    ).slice(0, 600),
    readStyle: JSON.stringify(
      ws.readJson(path.join(workspace, 'vault', 'read-style.json')).structure || {},
      null,
      0,
    ).slice(0, 600),
  };
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是感性解剖师，用感性语言输出严格 JSON。' },
      { role: 'user', content: DISSECT_PROMPT(ctx) },
    ],
    { json: true, temperature: 0.7, maxTokens: 3000 },
  );
  const report = parseJsonContent(content, '解剖报告');
  const outFile = path.join(workspace, 'vault', 'project-memory', `dissect-${Date.now()}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ ...report, target, generatedAt: ws.nowIso() }, null, 2) + '\n',
  );
  return { report, outFile };
}
