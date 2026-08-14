// v0.56 单测：文档互通管线——doc translate（原意解读+结构保留翻译+导出）与 doc restyle（风格重写+导出）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { docTranslate, docRestyle, renderDocReport } = await import(
  path.join(HERE, '..', 'src', 'doc-pipeline.js'),
);
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));

function py(script, args = []) {
  return execFileSync('python3', ['-c', script, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-docpipe-'));
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

// 4) docx 块级翻译：run 级格式保留（真实 docx → 翻译回填 → 验证样式/加粗/表格）
{
  const src = path.join(tmp, 'sample.docx');
  py(
    'import sys\nfrom docx import Document\n' +
    'd=Document()\nd.add_heading("标题",0)\np=d.add_paragraph()\nr=p.add_run("加粗内容")\nr.bold=True\n' +
    'd.add_paragraph("普通内容")\nt=d.add_table(rows=2,cols=2)\nt.cell(0,0).text="A1"\nt.cell(0,1).text="B1"\nt.cell(1,0).text="A2"\nt.cell(1,1).text="B2"\n' +
    'd.save(sys.argv[1])',
    [src],
  );
  const r = await docTranslate(cfg, w, { file: src, lang: 'en', out: path.join(tmp, 'docx-en') });
  assert(r.ok && r.mode === 'docx-block', `应走 docx 块级管线，实际 ${r.mode}`);
  assert(r.replaced > 0, '应有块被回填');
  assert(fs.existsSync(path.join(tmp, 'docx-en.docx')), '应产出 docx');
  // 用 python-docx 验证：段落数不变、样式/加粗保留、文本被替换
  const info = JSON.parse(py(
    'import json,sys\nfrom docx import Document\n' +
    'd=Document(sys.argv[1])\n' +
    'paras=[{"text":p.text,"style":p.style.name,"bold":bool(p.runs and p.runs[0].bold)} for p in d.paragraphs]\n' +
    't=d.tables[0] if d.tables else None\n' +
    'cells=[[c.text for c in row.cells] for row in t.rows] if t else []\n' +
    'print(json.dumps({"paras":paras,"cells":cells},ensure_ascii=False))',
    [path.join(tmp, 'docx-en.docx')],
  ));
  assert(info.paras.length === 3, '段落数不变');
  assert(info.paras[0].text === 'EN:标题' && info.paras[0].style === 'Title', '标题翻译且样式保留');
  assert(info.paras[1].text === 'EN:加粗内容' && info.paras[1].bold === true, '加粗 run 保留');
  assert(info.paras[2].text === 'EN:普通内容', '普通段落翻译');
  assert(info.cells[0][0] === 'EN:A1' && info.cells[1][1] === 'EN:B2', '表格单元格翻译');
  console.log('PASS docx 块级翻译（run 级格式保留：标题样式/加粗/表格）');
}

// 5) docx 块级风格重写：同样保留格式
{
  const r = await docRestyle(cfg, w, { file: path.join(tmp, 'sample.docx'), style: '克制短句', out: path.join(tmp, 'docx-style') });
  assert(r.ok && r.mode === 'docx-block', '应走 docx 块级管线');
  const info = JSON.parse(py(
    'import json,sys\nfrom docx import Document\n' +
    'd=Document(sys.argv[1])\nprint(json.dumps({"p":d.paragraphs[1].text,"style":d.paragraphs[0].style.name,"cell":d.tables[0].cell(0,0).text},ensure_ascii=False))',
    [path.join(tmp, 'docx-style.docx')],
  ));
  assert(info.p === 'RS:加粗内容' && info.style === 'Title' && info.cell === 'RS:A1', '重写回填且格式保留');
  console.log('PASS docx 块级风格重写（格式保留）');
}

delete globalThis.fetch;
console.log('\n✓ 全部通过');
