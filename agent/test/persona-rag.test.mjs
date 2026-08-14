// v0.22 单测：人物风格肖像（侧写）+ 内置库 RAG 化（联网资产/思想检索闭环）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import {
  buildPersona,
  personaBrief,
  personaStatus,
  personaToVector,
} from '../src/persona.js';
import {
  queueAssetSearch,
  ingestAssetResults,
  webAssetBrief,
  webRecommendation,
  unifiedBrief,
  pendingDataNeeds,
} from '../src/rag.js';
import { addEntry, listEntries } from '../src/knowledge.js';
import { readPersona } from '../src/persona.js';
import { vectorSummary } from '../src/style-vector.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-v22-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });

// ── 风格肖像（无 LLM → 确定性兜底，仍可查询）────────────
addEntry(wsDir, { title: '《我与地坛》', type: 'book', author: '史铁生', note: '关于生死与亲情' });
addEntry(wsDir, { title: '《活着》', type: 'book', author: '余华', note: '承受与讲述' });
fs.appendFileSync(
  path.join(wsDir, 'vault', 'edits.jsonl'),
  JSON.stringify({ original: '总而言之，历史很重要', changed: '那栋楼还站在原地', reason: '去 AI 腔' }) + '\n',
);

const persona = await buildPersona({ apiKey: '' }, wsDir);
check('侧写生成（确定性兜底）', persona.fallback === true && Boolean(persona.summary));
check('人类可读肖像可查询', fs.existsSync(path.join(wsDir, 'vault', 'persona.md')));
check('侧写状态 built', personaStatus(wsDir).built === true);
const brief = personaBrief(wsDir, { limit: 10 });
check('侧写可注入写作', brief.length > 0 && brief.includes('总评'));
const p2 = readPersona(wsDir);
check('侧写统计了素材来源', p2.evidence.knowledge >= 2);

const vt = await personaToVector({ apiKey: '' }, wsDir);
check('侧写映射回风格向量', vt.refreshed === true);
const vs = vectorSummary(wsDir);
check('向量因侧写更新（persona 信号累计）', vs && vs.byKind?.persona === 1, JSON.stringify(vs.byKind));

// ── 内置库 RAG 化：排队 → 回灌 → 缓存优先 → 书目入知识库 ──
let queued = queueAssetSearch(wsDir, '苦难 生命 散文 写作', { purpose: 'asset-search' });
check('资产联网排队', queued.queued === 1);
queued = queueAssetSearch(wsDir, '苦难 生命 散文 写作', { purpose: 'asset-search' });
check('同款资产请求不重复排队', queued.queued === 0);
check('待办列表可见', pendingDataNeeds(wsDir).some((n) => n.purpose === 'asset-search'));

const beforeKb = listEntries(wsDir).length;
const ing = ingestAssetResults(
  wsDir,
  [
    {
      query: '苦难 生命 散文',
      results: [
        { title: '《病隙碎笔》', source: '某书评', snippet: '史铁生在病中写生命' },
        { title: '苦难与生命的意义', source: '某期刊', snippet: '从文学与哲学角度…' },
      ],
    },
  ],
  { purpose: 'asset-search' },
);
check('联网资产回灌缓存', ing.ingested === 1 && ing.cached >= 1);
check('《书名》书目自动入知识库', ing.kbAdded >= 1 && listEntries(wsDir).length === beforeKb + 1);

const webBrief = webAssetBrief(wsDir, '苦难 生命 散文', { limit: 3 });
check('缓存优先注入（联网资料）', webBrief.some((x) => x.includes('联网资料')), JSON.stringify(webBrief.slice(0, 1)));
const unified = unifiedBrief(wsDir, '苦难 生命 散文');
check('统一素材包含资产与知识库', unified.includes('你读过的') && unified.includes('写作资产'));

// ── 联网荐书（thought-search）──────────────────────────
queueAssetSearch(wsDir, '与「苦难与生命」主题相近的经典书籍与理论', { purpose: 'thought-search' });
ingestAssetResults(
  wsDir,
  [
    {
      query: '与「苦难与生命」主题相近的经典书籍与理论',
      results: [{ title: '《西西弗神话》', source: '加缪', snippet: '荒诞中推石上山，意义来自反抗' }],
    },
  ],
  { purpose: 'thought-search' },
);
const webRec = webRecommendation(wsDir, '苦难与生命');
check('联网荐书给出作品与理由', webRec.includes('西西弗神话') && webRec.includes('知识库'), webRec.slice(0, 60));

console.log(`\n${failures === 0 ? '✓ v0.22 测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
