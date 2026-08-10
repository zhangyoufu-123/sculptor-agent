// v0.29：实时大纲驱动验证——种子骨架、大纲确认点、"再打磨"回路。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { respond } = await import(path.join(HERE, 'mock-llm.mjs'));
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const content = respond(body.messages || []);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
};

const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { clarifyStep, missingNeed, ensureLiveOutline, liveOutlineText } = await import(
  path.join(HERE, '..', 'src', 'clarify.js'),
);

const cfg = { ...loadConfig(), apiKey: 'mock' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-live-outline-'));

function seedCore(state) {
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
  };
  state.materials = ['石阶', '窗台积灰', '木楼梯的声响', '纪念牌上的字'];
}

// 1) 实时大纲必然存在（种子骨架 ≥3 节），首轮即返回
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
  const r = await clarifyStep(cfg, w, { lastInput: '我想写一篇关于北大红楼的散文' });
  const st = ws.readState(w);
  assert(st.liveOutline && st.liveOutline.sections.length >= 3, '实时大纲种子骨架 ≥3 节');
  assert(r.liveOutline && r.liveOutline.sections.length >= 3, 'clarifyStep 返回实时大纲');
  console.log('PASS 实时大纲种子骨架即时生成并返回');
}

// 2) 核心字段齐 → 出现"大纲确认"题（明确开始写作的确认点）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  let st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  const r = await clarifyStep(cfg, w, { lastInput: '' });
  assert(r.question && r.question.includes('大纲'), '出现大纲确认题');
  assert(r.outlineConfirm === true, '标记 outlineConfirm');
  st = ws.readState(w);
  assert(liveOutlineText(st).includes('北大红楼'), '大纲文本包含已确认主题');
  assert.strictEqual(st.lastField, 'outlineConfirm', '答案归类为大纲确认');
  console.log('PASS 大纲确认题出现（明确的开始写作确认点）');
}

// 3) 用户确认"大纲完成，开始写作" → 澄清完成，可进大纲生成
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w3'), { create: true });
  let st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 先拿到确认题
  const r = await clarifyStep(cfg, w, { lastInput: '大纲完成，开始写作' });
  st = ws.readState(w);
  assert(st.confirmed.outlineConfirmed === true, '大纲已确认');
  assert(r.question === null && r.ready === true, '确认后不再追问，可进大纲');
  assert(missingNeed(st) === '', '无剩余缺口');
  console.log('PASS 大纲完成确认 → 自然进入大纲生成');
}

// 4) 用户说"再打磨一下" → 记下修正、补一个打磨问题，然后恢复确认判断
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w4'), { create: true });
  let st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 拿到确认题
  const r = await clarifyStep(cfg, w, { lastInput: '再打磨一下，第二节能加个例子' });
  st = ws.readState(w);
  assert(st.confirmed.outlineConfirmed !== true, '未误确认');
  assert((st.blueprint?.corrections || []).length >= 1, '修正已记录');
  assert(r.question, '补出一个打磨问题，不重复确认题');
  assert(st.justRefined === false, '打磨问题已问出，下一轮恢复确认判断');
  // 再跑一轮空输入 → 回到"大纲确认"判断
  const r2 = await clarifyStep(cfg, w, { lastInput: '' });
  assert(r2.question && r2.outlineConfirm === true, '打磨后可再次进入大纲确认');
  console.log('PASS 再打磨回路：修正入档 + 打磨问题 + 恢复确认');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ live-outline 全部通过');
