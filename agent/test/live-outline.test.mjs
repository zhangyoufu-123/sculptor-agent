// v0.37：大纲是 LLM 从对话总结的呈现物——随对话更新、由 LLM/用户判断成形，
// 代码不预造骨架、不拿完成度框住 LLM；确定性兜底只保证不卡死。
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
const { generateOutline, normalizeParts } = await import(
  path.join(HERE, '..', 'src', 'outline.js'),
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
    blueprintConfirmed: true,
  };
  state.materials = ['石阶', '窗台积灰', '木楼梯的声响', '纪念牌上的字'];
}

// 1) 实时大纲从空开始，不预造"开头/主体/结尾"固定骨架（v0.57 后主题预填会立即长出
//    "素材/主题归纳"等内容节——内容是总结，不是骨架）；文本渲染不带完成度/状态机字样
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w1'), { create: true });
  const r = await clarifyStep(cfg, w, { lastInput: '我想写一篇关于北大红楼的散文' });
  const st = ws.readState(w);
  assert(st.liveOutline && Array.isArray(st.liveOutline.sections), '实时大纲必然存在');
  const heads = st.liveOutline.sections.map((s) => s.heading);
  assert(
    !heads.some((h) => /^(开头|主体|结尾|引言|正文|结论)$/.test(String(h).trim())),
    '不预造固定骨架（只允许内容节：素材/立意/主题归纳等）',
  );
  assert(r.liveOutline && Array.isArray(r.liveOutline.sections), 'clarifyStep 返回实时大纲');
  assert(!liveOutlineText(st).includes('完成度'), '文本不展示机器完成度');
  console.log('PASS 实时大纲只长内容节、无固定骨架、无完成度');
}

// 2) 核心字段齐 + LLM 判定 outlineComplete → 大纲由 LLM 总结（mock 返回 3 部分）+ 确认题出现
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w2'), { create: true });
  let st = ws.readState(w);
  seedCore(st);
  ws.writeState(w, st);
  let r = await clarifyStep(cfg, w, { lastInput: '' });
  st = ws.readState(w);
  // mock 在字段齐后返回 outlineUpdate + outlineComplete：大纲被总结成形
  assert(st.liveOutline.sections.length >= 3, `LLM 总结出大纲（${st.liveOutline.sections.length} 部分）`);
  // 下一轮：成形 → 确认题
  r = await clarifyStep(cfg, w, { lastInput: '' });
  assert(r.question && r.question.includes('确认这份大纲'), '成形后出现明确确认点');
  assert(r.outlineConfirm === true, '标记 outlineConfirm');
  console.log('PASS LLM 总结大纲并宣布成形 → 确认题（非确定性百分比）');
}

// 3) 用户确认"大纲完成，开始写作" → 澄清完成，可进大纲
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w3'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 总结成形
  await clarifyStep(cfg, w, { lastInput: '' }); // 拿到确认题
  const r = await clarifyStep(cfg, w, { lastInput: '大纲完成，开始写作' });
  const st2 = ws.readState(w);
  assert(st2.confirmed.outlineConfirmed === true, '大纲已确认');
  assert(r.question === null && r.ready === true, '确认后不再追问');
  assert(missingNeed(st2) === '', '无剩余缺口');
  console.log('PASS 用户确认 → 自然进入大纲生成');
}

// 4) 用户随时拍板："开始写作"在任何一轮都直接确认（大纲只是呈现物）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w4'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  const r = await clarifyStep(cfg, w, { lastInput: '开始写作' });
  const st2 = ws.readState(w);
  assert(st2.confirmed.outlineConfirmed === true, '用户拍板生效');
  assert(r.question === null && r.ready === true, '拍板后不再追问');
  console.log('PASS 用户随时拍板（大纲不限制用户）');
}

// 5) 低意愿 ×2 → 放行进大纲（逃生门，防死循环）
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w5'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ensureLiveOutline(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' });
  const r = await clarifyStep(cfg, w, { lastInput: '你决定' });
  const r2 = await clarifyStep(cfg, w, { lastInput: '你决定' });
  const st2 = ws.readState(w);
  assert(r2.question === null && r2.ready === true, '低意愿 ×2 放行');
  assert(st2.liveOutline.complete === true || st2.deferred === true, '不困住用户');
  console.log('PASS 低意愿逃生门');
}

// 6) 确认题上"再打磨" → 打磨问题 → "不用改了，开始写作"回到确认
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w6'), { create: true });
  const st = ws.readState(w);
  seedCore(st);
  ws.writeState(w, st);
  await clarifyStep(cfg, w, { lastInput: '' }); // 总结成形
  await clarifyStep(cfg, w, { lastInput: '' }); // 确认题
  const r = await clarifyStep(cfg, w, { lastInput: '再打磨一下，第二节能加个例子' });
  const st2 = ws.readState(w);
  assert((st2.blueprint?.corrections || []).length >= 1, '修正已记录');
  assert(r.question && r.question.includes('打磨'), '补出打磨问题');
  const r2 = await clarifyStep(cfg, w, { lastInput: '不用改了，开始写作' });
  const st3 = ws.readState(w);
  assert(st3.confirmed.outlineConfirmed === true, '打磨后拍板定稿');
  console.log('PASS 打磨回路：修正入档 + 拍板定稿');
}

// 7) 卷级分组（v0.42）：LLM 输出 parts → 只做展示分组，sections 保持完整平铺
{
  const w = ws.ensureWorkspace(path.join(tmp, 'w7'), { create: true });
  let st = ws.readState(w);
  seedCore(st);
  st.confirmed.targetWords = 12000; // 长文 → 触发卷级分组
  st.confirmed.genre = '小说';
  st.deferred = true; // 聚焦 parts 链路：跳过文体素材门槛（合法逃生路径）
  ws.writeState(w, st);
  const r = await generateOutline(cfg, w);
  const outline = r.outline;
  assert(Array.isArray(outline.sections) && outline.sections.length >= 3, 'sections 完整平铺');
  assert(Array.isArray(outline.parts) && outline.parts.length >= 2, 'parts 卷级分组存在');
  const flatHeadings = outline.sections.map((s) => s.heading);
  const partHeadings = outline.parts.flatMap((p) => p.sections);
  assert(
    partHeadings.every((h) => flatHeadings.includes(h)),
    '卷分组只引用真实存在的节',
  );
  assert(
    outline.parts.some((p) => p.title === '未分组') === false ||
      new Set(partHeadings).size === flatHeadings.length,
    '未分组节会自动收尾、不丢节',
  );
  const st2 = ws.readState(w);
  assert(st2.liveOutline?.parts?.length >= 2, 'liveOutline 携带卷级分组');
  assert(st2.summary.includes('卷'), '摘要体现卷数');
  console.log('PASS 卷级分组：展示分组不改变写作真源');
}

// 8) normalizeParts 兜底：空卷/错引用/部分分组都能收敛
{
  const parts = normalizeParts({
    sections: [
      { heading: 'A' },
      { heading: 'B' },
      { heading: 'C' },
    ],
    parts: [
      { title: '卷一', sections: ['A', '不存在的节'] },
      { title: '', sections: [] },
    ],
  });
  assert(parts && parts.length === 2, '空卷丢弃、错引用过滤');
  assert(parts[0].sections.join() === 'A', '有效引用保留');
  assert(parts[1].title === '未分组' && parts[1].sections.includes('B') && parts[1].sections.includes('C'), '未分组节收尾');
  console.log('PASS normalizeParts 容错');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ live-outline 全部通过');
