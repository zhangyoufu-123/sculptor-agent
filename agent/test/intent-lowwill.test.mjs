// v0.26 意图理解接线验证：低意愿早退（确定性护栏）+ 意图兜底不阻塞。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { clarifyStep } = await import(path.join(HERE, '..', 'src', 'clarify.js'));
const { understandIntent } = await import(path.join(HERE, '..', 'src', 'intent.js'));
const { detectGenre } = await import(path.join(HERE, '..', 'src', 'genre.js'));

const cfg = { ...loadConfig(), apiKey: '' };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-intent-test-'));

// 0) 对话回复护栏：口语"你决定"不是公文文种"决定"，"写一份…决定"才是。
assert(detectGenre('你决定，继续吧') === null, '口语"你决定"不触发公文文种');
assert(detectGenre('写一份关于安全生产的决定') === '决定', '明确写作请求仍能识别文种');
console.log('PASS 对话回复不误判文体（"你决定"≠公文"决定"）');

// 1) 意图兜底：无 LLM 时也能产出理解摘要，不抛错、不阻塞。
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
  const state = ws.readState(w);
  state.lastInput = '写一篇关于夏天离别的散文，一千字左右，写给自己的纪念';
  state.confirmed = { topic: '夏天离别', targetWords: 1000, genre: '散文' };
  const intent = await understandIntent(cfg, w, state);
  assert(typeof intent.summary === 'string' && intent.summary.includes('夏天离别'), '意图兜底摘要包含主题');
  assert(state.intent === intent, '意图写入 state.intent');
  console.log('PASS 意图兜底不阻塞、写入 state.intent');
}

// 2) 低意愿早退：核心字段已齐 + 连续两次"你决定" → 不再追问，直接可进大纲。
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  const state = ws.readState(w);
  state.phase = 'clarify';
  state.confirmed = {
    topic: '北大红楼',
    genre: '散文',
    targetWords: 800,
    stance: '历史是站得进去的现场',
    audience: '自己',
    theme: '历史不是展品',
    arguments: ['现场感来自具体的人', '细节是过去的证词'],
    emotionalCurve: '先好奇，再触动，最后安宁',
    endingTaste: '心安则上',
    styleSample: true,
    blueprintConfirmed: true,
  };
  state.materials = ['石阶', '窗台积灰', '木楼梯的声响', '纪念牌上的字'];
  state.lowWill = 1; // 上次已说一次"你决定"
  ws.writeState(w, state);
  const r = await clarifyStep(cfg, w, { lastInput: '你决定，继续吧' });
  assert(r.question === null, '低意愿早退：不再出新问题');
  assert(r.ready === true, '低意愿早退：核心字段已齐');
  console.log('PASS 低意愿早退：连续两次"你决定"直接放行进大纲');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ intent-lowwill 全部通过');
