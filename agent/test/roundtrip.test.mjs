// v0.32：翻译/回译校验——信息点核对 + 风格对比；LLM 不可用时确定性兜底。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { roundtripCheck, renderRoundtrip } = await import(
  path.join(HERE, '..', 'src', 'roundtrip.js'),
);
const { exportLatex } = await import(path.join(HERE, '..', 'src', 'io.js'));

const cfg = { ...loadConfig(), apiKey: 'mock' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-roundtrip-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
const TEXT =
  '我站在北大红楼门口，石阶被磨亮了一百年。历史从不缺席，它只等一个人走进去。纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚。';

// 1) 全链路：分析 → 直译 → 回译 → 信息点核对 → 风格对比
{
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const r = await roundtripCheck(cfg, w, { text: TEXT });
  assert(r.keyPoints.length >= 3, '提取出信息点');
  assert(r.forward.includes('stone'), '中译英完成');
  assert(r.back.includes('石阶'), '回译完成');
  assert(r.intent && r.intent.summary.includes('作者追忆'), '原意解读完成（以理解作者原意为第一标准）');
  assert(renderRoundtrip(r).includes('原意理解'), '报告含原意理解段');
  assert(Array.isArray(r.content.kept) && Array.isArray(r.content.lost), '信息点核对字段完整');
  assert.strictEqual(r.content.lost.length, 0, 'mock 回译无信息丢失');
  assert.strictEqual(r.verdict, 'pass', '判定通过');
  assert(r.style.original && r.style.back, '风格对比两侧指标齐全');
  assert(typeof r.style.original.sentenceLengthStddev === 'number', '风格指标可计算');
  assert(renderRoundtrip(r).includes('内容保真'), '报告渲染正常');
  console.log('PASS 回译校验全链路（分析→直译→回译→核对→风格对比）');
}

// 2) LLM 不可用 → 确定性兜底，不抛错、可出报告
{
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const r = await roundtripCheck(cfg, w, { text: TEXT });
  assert(r.keyPoints.length >= 1, '兜底提取信息点');
  assert.strictEqual(r.forward, '', '直译为空');
  assert(r.content.hint.includes('翻译未完成'), '明确提示跳过核对');
  assert(r.style.original, '原文风格指标仍在');
  console.log('PASS LLM 不可用 → 确定性兜底不中断');
}

// 3) 读工作区 draft.md
{
  const w2 = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  fs.writeFileSync(path.join(w2, 'draft.md'), '# 测试\n\n石阶被磨亮了一百年。\n');
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const r = await roundtripCheck(cfg, w2, {});
  assert(r.source === 'draft.md' && r.chars > 0, '默认读工作区草稿');
  console.log('PASS 默认读取工作区 draft.md');
}

// 3) 数学公式特殊格式导出：markdown（含 $$…$$）→ LaTeX（公式原样保留）
{
  const md = path.join(tmp, 'math.md');
  const tex = path.join(tmp, 'math.tex');
  fs.writeFileSync(
    md,
    '# 标题\n\n$$d(A,B) = \\sqrt{\\sum_{j=1}^{8} \\left(v_j^A - v_j^B\\right)^2}$$\n\n正文包含 & 符号。\n',
  );
  exportLatex(fs.readFileSync(md, 'utf8'), tex);
  const out = fs.readFileSync(tex, 'utf8');
  assert(out.includes('\\documentclass'), '生成 LaTeX 文档骨架');
  assert(out.includes('\\sqrt{\\sum'), '数学公式原样保留');
  assert(out.includes('\\section*{标题}'), '标题映射为 section');
  assert(out.includes('\\&'), '特殊符号转义');
  console.log('PASS LaTeX 导出（数学公式原样 + 特殊符号转义）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ roundtrip 全部通过');
