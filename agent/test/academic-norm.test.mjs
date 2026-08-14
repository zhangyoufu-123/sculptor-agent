// v0.55 单测：学术规范审计——把"格式/语言专项评审"标准做成可自动触发的质检。
// 确定性安全网：标点混用/口语化/摘要长度/引用顺序/图表顺序/关键词；
// LLM 主判断：学术规范深审（mock）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  scanPunctMix,
  scanColloquial,
  scanAbstractLength,
  scanCitationOrder,
  scanFigureTableOrder,
  scanKeywords,
  normScan,
  academicNorm,
  renderNormReport,
} = await import(path.join(HERE, '..', 'src', 'academic-norm.js'));
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));

// 1) 中英标点混用：半角括号紧贴中文 → 命中；全角括号 → 不误报
{
  const bad = '个人知识库(Personal Knowledge Base, PKB)用于检索。';
  const good = '个人知识库（Personal Knowledge Base, PKB）用于检索。';
  assert(scanPunctMix(bad).length >= 1, '半角括号紧贴中文应命中');
  assert(scanPunctMix(good).length === 0, '全角括号不应命中');
  assert(scanPunctMix('例如,这是中文').length >= 1, '英文逗号后接中文应命中');
  console.log('PASS 中英标点混用检测');
}

// 2) 正式文体口语化：仅学术/报告/公文触发；引号内不误伤；非正式文体不触发
{
  const t = '系统收走了用户提供的素材。';
  assert(scanColloquial(t, '学术论文').some((i) => i.evidence === '收走'), '正式文体应命中口语词');
  assert(scanColloquial(t, '散文').length === 0, '非正式文体不触发');
  assert(scanColloquial('他说的「说白了」我不认同。', '学术论文').length === 0, '引号内不误伤');
  console.log('PASS 正式文体口语化检测');
}

// 3) 摘要超长
{
  const long = '## 摘要\n' + '这是一段用于测试摘要长度的文字。'.repeat(30) + '\n## 1 引言\n';
  const short = '## 摘要\n问题。方法。发现。意义。\n## 1 引言\n';
  assert(scanAbstractLength(long).length >= 1, '超长摘要应命中');
  assert(scanAbstractLength(short).length === 0, '正常摘要不误报');
  console.log('PASS 摘要长度检测');
}

// 4) 引用编号顺序（顺序编码制）
{
  const bad = '见 [1]，再看 [3]，最后 [2]。';
  const good = '见 [1]，再看 [2]，最后 [3]。';
  const reref = '见 [1] 与 [2]，后文再引 [3]，最后重提 [2] 与 [1]。';
  assert(scanCitationOrder(bad).length >= 1, '编号倒序应命中');
  assert(scanCitationOrder(good).length === 0, '顺序正确不误报');
  assert(scanCitationOrder(reref).length === 0, '再次引用不误报（只校验首次出现）');
  console.log('PASS 引用编号顺序检测');
}

// 5) 图表顺序引用（图/表独立序列）
{
  assert(scanFigureTableOrder('图 4 图 5 图 6', '图').length === 0, '图顺序正确');
  assert(scanFigureTableOrder('图 7 图 4', '图').length >= 1, '图倒序应命中');
  assert(scanFigureTableOrder('表 2 表 1', '表').length >= 1, '表倒序应命中');
  console.log('PASS 图表顺序引用检测');
}

// 6) 关键词规范性
{
  assert(scanKeywords('关键词：写作智能体；个性化文本生成').length >= 1, '关键词过少应命中');
  assert(
    scanKeywords('关键词：写作 Agent；AI 味；深协作').some((i) => i.issue.includes('非标准')),
    '非标准术语应提示',
  );
  assert(
    scanKeywords('关键词：写作智能体；个性化文本生成；人机交互；检索增强生成；风格签名').length === 0,
    '规范关键词不误报',
  );
  console.log('PASS 关键词规范性检测');
}

// 7) 全链路（LLM mock）：确定性 + LLM 深审合并、落盘、渲染
{
  const cfg = { ...loadConfig(), apiKey: 'mock' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-norm-'));
  const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
  const text =
    '## 摘要\n' + '这是一段用于测试的摘要文字。'.repeat(35) +
    '\n## 1 引言\n个人知识库(Personal Knowledge Base, PKB)。系统收走了素材。见 [1] 与 [3] 再 [2]。';
  fs.writeFileSync(path.join(w, 'draft.md'), text, 'utf8');
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const content = respond(body.messages || []);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const r = await academicNorm(cfg, w, { genre: '学术论文' });
  assert(r.items.length >= 3, `确定性 + LLM 合并应≥3 条，实际 ${r.items.length}`);
  assert(r.items.some((i) => i.source === 'llm'), '应包含 LLM 判定的问题');
  assert(r.score === 88, 'LLM 评分应保留');
  assert(fs.existsSync(path.join(w, 'vault', 'norm-report.md')), '报告应落盘');
  const rendered = renderNormReport(r);
  assert(rendered.includes('问题清单'), '渲染应包含问题清单');
  console.log('PASS 学术规范审计全链路（确定性 + LLM 深审 + 落盘 + 渲染）');
  delete globalThis.fetch;
}

// 8) normScan 无 LLM 安全网：质量门静默调用路径
{
  const r = normScan('见 [2] 再 [1]。系统收走了它。', '学术论文');
  assert(r.items.length >= 2, '确定性安全网应命中引用顺序与口语化');
  console.log('PASS normScan 确定性安全网（质量门静默路径）');
}

console.log('\n✓ 全部通过');
