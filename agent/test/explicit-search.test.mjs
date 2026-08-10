// v0.27.1：显式检索请求（"帮我查一查"）+ 引用式知识库收录验证。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const { clarifyStep } = await import(path.join(HERE, '..', 'src', 'clarify.js'));
const { captureKbMentions, listEntries } = await import(path.join(HERE, '..', 'src', 'knowledge.js'));
const { pendingDataNeeds, explicitSearchSuggestion } = await import(path.join(HERE, '..', 'src', 'rag.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));

const cfg = { ...loadConfig(), apiKey: '' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-search-test-'));

// 1) 无书名号、无"读过"确认的引用式提及 → 低置信收录
{
  const w = fs.mkdtempSync(path.join(tmp, 'kb-'));
  const captured = captureKbMentions(w, '我曾经在乡土中国中听到一段关于为什么语言变得简单的论述');
  const book = listEntries(w).find((e) => e.title === '乡土中国');
  assert(book, '《乡土中国》引用式提及已收录');
  assert.strictEqual(book.source, 'user-referenced', '来源标记 user-referenced');
  assert(book.confidence < 0.9, '低置信标注');
  assert(captured.length >= 1, '返回新收录 id');
  console.log('PASS 无书名号引用式提及 → 低置信收录（乡土中国）');
}

// 2) 书名号 + 引用语境 → 收录
{
  const w = fs.mkdtempSync(path.join(tmp, 'kb2-'));
  captureKbMentions(w, '在《乡土中国》里有段论述我很认同');
  const e = listEntries(w).find((x) => x.title === '乡土中国');
  assert(e && e.source === 'user-referenced', '《》引用语境收录为 user-referenced');
  console.log('PASS 书名号引用语境 → 收录');
}

// 3) 明确"读过" → 仍走 user-confirmed
{
  const w = fs.mkdtempSync(path.join(tmp, 'kb3-'));
  captureKbMentions(w, '我读过《乡土中国》');
  const e = listEntries(w).find((x) => x.title === '乡土中国');
  assert(e && e.source === 'user-confirmed', '确认信号仍走 user-confirmed');
  console.log('PASS 确认信号 → user-confirmed');
}

// 4) 显式检索意图：检查一下不误触发；查一查触发并排队
{
  const w = fs.mkdtempSync(path.join(tmp, 'rag-'));
  assert.strictEqual(await explicitSearchSuggestion(cfg, w, '你检查一下这句话', {}), '', '检查一下不触发检索');
  const s = await explicitSearchSuggestion(cfg, w, '在《乡土中国》中有一段关于语言变简单的论述，你可以帮我查一查吗', {});
  assert(s.includes('排队检索') || s.includes('直连检索') || s.includes('待办'), '返回检索提示');
  assert(pendingDataNeeds(w).some((p) => p.purpose === 'user-request'), '检索请求已排队');
  console.log('PASS 显式检索意图触发（检查一下不误触发）');
}

// 5) 全链路 clarifyStep：用户原话 → 提示 + 排队 + 知识库收录
{
  const w = fs.mkdtempSync(path.join(tmp, 'full-'));
  ws.ensureWorkspace(w, { create: true });
  const r = await clarifyStep(cfg, w, {
    lastInput:
      '对，我心中就是觉得这很差，是语言在变得匮乏。我曾经在乡土中国中听到一段关于为什么语言变得简单的论述，你可以帮我查一查吗。',
  });
  assert(r.searchSuggestion, 'clarifyStep 返回检索提示');
  const req = pendingDataNeeds(w).find((p) => p.purpose === 'user-request');
  assert(req && req.queries[0].includes('乡土中国'), '检索查询包含书名');
  assert(
    listEntries(w).some((e) => e.title === '乡土中国' && e.source === 'user-referenced'),
    '引用书已入知识库',
  );
  console.log('PASS 全链路：提示 + 排队 + 知识库收录');
}

// 6) 同查询去重
{
  const w = fs.mkdtempSync(path.join(tmp, 'dup-'));
  const state = {};
  await explicitSearchSuggestion(cfg, w, '帮我查一查乡土中国的语言论述', state);
  const s2 = await explicitSearchSuggestion(cfg, w, '帮我查一查乡土中国的语言论述', state);
  const pending = pendingDataNeeds(w).filter((p) => p.purpose === 'user-request');
  assert.strictEqual(pending.length, 1, '同查询只排队一次');
  assert(s2.includes('刚才已经') || s2.includes('待办'), '重复请求给出说明');
  console.log('PASS 同查询去重');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ explicit-search 全部通过');
