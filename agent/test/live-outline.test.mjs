// v0.30：实时大纲驱动验证——种子骨架、缺口驱动提问、确定性完成度、
// 大纲确认点、"再打磨"回路、用户随时拍板。
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

/** 核心字段 + 每节补上要点 → 大纲结构性完整（完成度 ≥80 且无待补节）。 */
function seedReadyOutline(state) {
  seedCore(state);
  const lo = ensureLiveOutline(state);
  lo.sections.forEach((s) => {
    if (!s.function) s.function = '展开';
    s.keyPoints = ['第一层写现场', '第二层写人物'];
    s.thesis = s.thesis || '历史是站得进去的现场';
  });
  state.liveOutline = lo;
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

// 2) 完成度确定性结算挂在大纲上（百分比/每节状态/全局缺口）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  const r = await clarifyStep(cfg, w, { lastInput: '' });
  st.liveOutline = (ws.readState(w)).liveOutline;
  assert(st.liveOutline.progress, 'liveOutline 带确定性完成度结算');
  assert(st.liveOutline.progress.total >= 3, '完成度覆盖全部节');
  assert(st.liveOutline.progress.perSection.every((p) => p.status === 'needs'), '未补要点 → 每节为待补');
  assert(st.liveOutline.nextGap && st.liveOutline.nextGap.missing.includes('要点'), 'nextGap 指向最早缺口');
  assert(r.outlineGap === true, '核心字段齐但大纲未满 → 缺口驱动提问');
  assert(r.question.includes('第 1 节') || r.question.includes('要点'), '问题指向最早未就绪的一节');
  console.log('PASS 完成度结算 + 缺口驱动提问');
}

// 3) 缺口回答直接落进对应节，大纲真实长大
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w3'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 拿到缺口题（第 1 节·要点）
  await clarifyStep(cfg, w, { lastInput: '第一层写现场的物件，第二层写人物的凝视' });
  const st2 = ws.readState(w);
  const sec0 = st2.liveOutline.sections[0];
  assert((sec0.keyPoints || []).length >= 2, '回答落进第 1 节 keyPoints');
  assert(st2.liveOutline.progress.ready >= 1, '第 1 节就绪，完成度上升');
  console.log('PASS 缺口回答落进对应节，完成度实时上升');
}

// 4) 用户对缺口说"没有" → 放弃该项换下一缺口，不车轱辘
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w4'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' });
  const r = await clarifyStep(cfg, w, { lastInput: '没有' });
  const st2 = ws.readState(w);
  assert((st2.liveOutline.sections[0].waived || []).includes('要点'), '放弃项被记录');
  assert(r.outlineGap === true && r.question.includes('第 2 节'), '换到下一缺口继续问');
  console.log('PASS 放弃缺口 → 换下一缺口，绝不死循环');
}

// 5) 核心字段齐 + 大纲结构性完整 → 出现"大纲确认"题（明确的开始写作确认点）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w5'), { create: true });
  let st = ws.readState(w);
  seedReadyOutline(st);
  ws.writeState(w, st);
  const r = await clarifyStep(cfg, w, { lastInput: '' });
  assert(r.question && r.question.includes('大纲'), '出现大纲确认题');
  assert(r.outlineConfirm === true, '标记 outlineConfirm');
  st = ws.readState(w);
  assert(st.liveOutline.progress.complete === true, '完成度判定为完整');
  assert(liveOutlineText(st).includes('北大红楼'), '大纲文本包含已确认主题');
  assert.strictEqual(st.lastField, 'outlineConfirm', '答案归类为大纲确认');
  console.log('PASS 大纲确认题出现（明确的开始写作确认点）');
}

// 6) 用户确认"大纲完成，开始写作" → 澄清完成，可进大纲生成
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w6'), { create: true });
  let st = ws.readState(w);
  seedReadyOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 先拿到确认题
  const r = await clarifyStep(cfg, w, { lastInput: '大纲完成，开始写作' });
  st = ws.readState(w);
  assert(st.confirmed.outlineConfirmed === true, '大纲已确认');
  assert(r.question === null && r.ready === true, '确认后不再追问，可进大纲');
  assert(missingNeed(st) === '', '无剩余缺口');
  console.log('PASS 大纲完成确认 → 自然进入大纲生成');
}

// 7) 缺口模式下用户随时拍板："大纲完成，开始写作"直接确认（大纲只是视图，不是唯一真源）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w7'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 缺口题
  const r = await clarifyStep(cfg, w, { lastInput: '大纲完成，开始写作' });
  const st2 = ws.readState(w);
  assert(st2.confirmed.outlineConfirmed === true, '缺口模式下用户拍板也生效');
  assert(r.question === null && r.ready === true, '拍板后不再追问');
  console.log('PASS 缺口模式下用户随时拍板');
}

// 8) 用户说"再打磨一下" → 记下修正、补一个打磨问题，然后恢复确认判断
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w8'), { create: true });
  let st = ws.readState(w);
  seedReadyOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 拿到确认题
  const r = await clarifyStep(cfg, w, { lastInput: '再打磨一下，第二节能加个例子' });
  st = ws.readState(w);
  assert(st.confirmed.outlineConfirmed !== true, '未误确认');
  assert((st.blueprint?.corrections || []).length >= 1, '修正已记录');
  assert(r.question && r.question.includes('打磨'), '确定性打磨问题，不退回无关模板');
  assert(st.justRefined === false, '打磨问题已问出，下一轮恢复确认判断');
  // 再跑一轮空输入 → 回到"大纲确认"判断
  const r2 = await clarifyStep(cfg, w, { lastInput: '' });
  assert(r2.question && r2.outlineConfirm === true, '打磨后可再次进入大纲确认');
  console.log('PASS 再打磨回路：修正入档 + 打磨问题 + 恢复确认');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ live-outline 全部通过');
