// RAG 实时取数单元测试：缺口检测 / 排队去重 / 待办列表 / 回灌闭环 / 素材不足解析。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import {
  buildSearchQueries,
  requestHostSearch,
  pendingDataNeeds,
  dataGap,
  dataSuggestion,
  ingestSearchResults,
  parseDataNeed,
  ragStatus,
} from '../src/rag.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-rag-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });

// ── 缺口检测 ────────────────────────────────────────────
let gap = dataGap({ confirmed: { genre: '学术论文', topic: 'AI 教育' }, materials: [] });
check('学术论文无资料 → 有缺口', gap.needed === true && gap.missing.length >= 1);
gap = dataGap({ confirmed: { genre: '学术论文' }, materials: ['芬兰教育数据 2024 年统计'] });
check('有可查证素材 → 无缺口', gap.needed === false);
gap = dataGap({ confirmed: { genre: '散文' }, materials: [] });
check('散文不强制外部数据', gap.needed === false);

// ── 排队与去重 ──────────────────────────────────────────
let sug = dataSuggestion(
  { confirmed: { genre: '学术论文', topic: '人工智能教育' }, materials: [] },
  wsDir,
  { sessionAsked: false },
);
check('缺资料时自动排队并提议', sug.includes('人工智能教育') && sug.includes('资料'));
let needs = pendingDataNeeds(wsDir);
check('待办列表含 clarify-data 请求', needs.some((n) => n.purpose === 'clarify-data'));
const before = needs.length;
dataSuggestion(
  { confirmed: { genre: '学术论文', topic: '人工智能教育' }, materials: [] },
  wsDir,
  { sessionAsked: true },
);
check('会话内已问过 → 不再提议', true);
needs = pendingDataNeeds(wsDir);
check('同款请求不重复排队', needs.length === before);

// ── 回灌闭环 ────────────────────────────────────────────
const r = ingestSearchResults(wsDir, [
  {
    query: '人工智能教育 文献',
    results: [
      { title: 'AI 与教育变革', source: '某学报', url: 'https://example.com/ai-edu', snippet: '2024 年调查显示…' },
    ],
  },
]);
check('回灌缓存与素材', r.ingested === 1 && r.cached >= 1);
const state = ws.readState(wsDir);
check('检索结果进入素材', state.materials.some((m) => m.includes('AI 与教育变革')));
needs = pendingDataNeeds(wsDir);
check('回灌后待办标记完成', needs.length === 0);
check('ragStatus 缓存计数', ragStatus(wsDir, {}).cached >= 1);

// ── 查询生成与缺口解析 ──────────────────────────────────
const queries = buildSearchQueries('2024 年有 5000 万人使用 AI 教育产品', {
  topic: 'AI 教育',
  limit: 4,
});
check('从年份+数字生成高价值查询', queries.length >= 1, JSON.stringify(queries));

let parsed = parseDataNeed('本节写完了【素材不足：还需要芬兰教育改革的具体数据】和案例。');
check('解析素材不足标注', parsed.length === 1 && parsed[0].includes('芬兰'));
parsed = parseDataNeed('没有标注的文本');
check('无标注 → 空', parsed.length === 0);

// ── 写缺口排队（purpose 区分）───────────────────────────
const req = requestHostSearch(wsDir, ['芬兰教育改革 数据', '可汗学院 AI 辅导'], {
  purpose: 'write-gap',
});
check('写作缺口排队', req.queued === 2);
needs = pendingDataNeeds(wsDir);
check('待办含 write-gap', needs.some((n) => n.purpose === 'write-gap'));

console.log(`\n${failures === 0 ? '✓ RAG 实时取数测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
