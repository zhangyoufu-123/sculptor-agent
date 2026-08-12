// v0.56 单测：文档互通管线——doc translate（原意解读+结构保留翻译+导出）与 doc restyle（风格重写+导出）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { docTranslate, docRestyle, renderDocReport } = await import(
  path.join(HERE, '..', 'src', 'doc-pipeline.js'),
);
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-docpipe-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
const input = path.join(tmp, 'input.md');
fs.writeFileSync(
  input,
  '# Title\n\n这是一段需要翻译的中文。\n\n- 条目一\n- 条目二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n',
  'utf8',
);
const cfg = { ...loadConfig(), apiKey: 'mock' };

// 1) doc translate：原意解读 + 结构保留翻译 + 导出 md（结构断言）
{
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const r = await docTranslate(cfg, w, { file: input, lang: 'en', out: path.join(tmp, 'out-en') });
  assert(r.ok, '翻译应成功');
  assert(r.interpretation.intent === '保留原文信息与结构', '应产出原意解读');
  const md = fs.readFileSync(path.join(tmp, 'out-en.md'), 'utf8');
  assert(md.includes('# Title'), '标题结构保留');
  assert(md.includes('This is a translated paragraph'), '译文内容存在');
  assert(md.includes('| 列A | 列B |') || md.includes('| A | B |'), '表格结构保留');
  assert(r.roundtrip && typeof r.roundtrip.kept === 'number', '应附带回译校验');
  assert(renderDocReport(r).includes('产物'), '报告应含产物清单');
  console.log('PASS doc translate（原意解读+结构保留+导出+回译校验）');
}

// 2) doc restyle：按指定风格方向重写并导出
{
  const r = await docRestyle(cfg, w, {
    file: input,
    style: '克制、短句、具体细节',
    out: path.join(tmp, 'out-style'),
  });
  assert(r.ok, '重写应成功');
  const md = fs.readFileSync(path.join(tmp, 'out-style.md'), 'utf8');
  assert(md.includes('旧石阶'), '重写结果存在');
  assert(md.includes('# Title'), '标题结构保留');
  assert(r.styleSource === '用户指定', '风格来源标注正确');
  console.log('PASS doc restyle（风格重写+结构保留+导出）');
}

// 3) 无密钥兜底：导出原文 md 并提示
{
  const r = await docTranslate({ ...loadConfig(), apiKey: '' }, w, { file: input, lang: 'ja' });
  assert(!r.ok, '无密钥应标记未完成');
  assert(fs.existsSync(path.join(tmp, 'input.ja.md')), '应导出原文 md 兜底');
  console.log('PASS 无密钥确定性兜底');
}

delete globalThis.fetch;
console.log('\n✓ 全部通过');
