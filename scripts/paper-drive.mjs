#!/usr/bin/env node
// 论文写作驱动（真实 LLM）：以项目真实素材回答导演澄清，让 Sculptor 亲自写
// 《SCULPTOR：以"作者建模"为中心的深度协作写作 Agent》参赛论文。
// 用法: node scripts/paper-drive.mjs [工作区]   （需网络 + 已配置 SCULPTOR_LLM_* 或宿主凭据）
process.env.SCULPTOR_QUICK = process.env.SCULPTOR_QUICK || '1'; // 快速模式：读者 3 人、跳过交锋与适配卡重蒸馏
process.env.SCULPTOR_LLM_TIMEOUT_MS = process.env.SCULPTOR_LLM_TIMEOUT_MS || '150000';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../agent/src/config.js';
import { agentStep } from '../agent/src/director.js';
import * as ws from '../agent/src/workspace.js';

const workspace = process.argv[2] || '/tmp/sculptor-paper-ws';
const cfg = loadConfig();

// ── 预置作者输入（真实项目资料；作者本人提供的素材，非模型生成）──
const SEED_MATERIALS = [
  '四层复合风格向量：L1 连续 EMA 向量（作者语料相对基线方向差）、L2 动态维度（14+7 维 + 意象/偏好/素材子维）、L3 困惑度签名、L4 偏好对（原文→改后→意图）',
  '双风格分离："人想写的"（write-style）与"人想听的"（read-style）两个分布，分别注入写作与结构',
  '每轮对话被动采集风格信号，vault/style-signals 流水留痕，压缩/续写不丢风格',
  '修改即风格教学：选区点改与候选改写全部吸收进档案、偏好轴与连续向量（亲手修改是最高权重信号）',
  '思想脉络：追踪用户"主张-前提-推理-理论来源"，LLM 做一步概括推理，与用户达成思想共识后再推进',
  '提问主次：蓝图状态只是清单，问什么由 LLM 结合对话自主判断；RAG 知识背景（知识库/阅读记录检索）注入追问设计师',
  '个人知识库（PKB）：归纳式确认采集《书名》/去过的地方/个人理论，检索轮换注入、提问去重',
  '学术论证链：known→gap→tension→insight→method→evidence→limitation，加上每节 claim/evidence/warrant 完备性扫描',
  '角色预演：持久内部状态（背景/愿望/恐惧/记忆）+ 理想-现实张力驱动的第一人称行为预测',
  '文章圣经：长文/系列文交付自动沉淀跨篇一致性文档（世界观/角色/时间线/伏笔）',
  '伏笔记账与跨章回收校验：每写一节自动记账伏笔，交付前检查是否回收，悬空伏笔作为 P1 提示交作者拍板',
  '三线节奏曲线：每节张力/信息密度/情绪强度 0-100，落盘 vault/curve.md，Web 端实时展示',
  '卷级大纲：长文由 LLM 输出可选 parts 卷分组，sections 仍是写作与字数唯一真源',
  '反 AI 审计：黑名单/重复比喻/句式复用确定性检测 + LLM 按风格修订（≤3 轮），真实修复案例：跨节重复比喻改写成不同意象',
  '回译校验：中译英→回译→信息点核对（丢失/漂移）与风格对比，交付前自动触发',
  '原创性检查：文内重复句/与个人库自我复用/模板句扫描',
  '事实核查分级：数字/年代/引文/人名/机构 → material/common/verify 三档',
  '读者群像：8 位"第一读者"感性反馈 + 交锋收敛出共识/争议/优先级（快速模式 3 人）',
  'RAG 供给闭环：requests.jsonl 去重排队 → 宿主/学术/数据分析 agent 检索 → ingest 回灌 → 缺口节自动重写（≤2 轮）',
  '文体蓝图与导出：公文 GB/T 9704-2012、合同、学术论文 docx、PPT、PDF、SRT 字幕、HTML',
  '多模态输入：docx/xlsx/图片/语音口述（whisper）→ 提取为素材',
  '个人写作库：作品按文体自动归档 + 蒸馏"个人写作 skill" + 多作品人类化指标对比',
  '实验工具：作者语料采集、baseline vs 风格注入对照、消融实验、盲评问卷、二项检验汇总',
  'Web 工作台：选区 AI 工具栏、3 候选改写卡、版本回滚、专注/并排模式、实时洞察（字数/脉搏/节奏）、大纲图谱、伏笔时间线',
  '自动化验证：agent 15 套 + web 7 套 QA（含红队 8 文体×6 对抗输入、十种用户说法、风格差异对照）',
];

// 预置已确认信息（作者直接给出的真实输入；留 立场/立意/论点/情感/结尾/风格 由对话澄清）
{
  const st = ws.readState(workspace);
  st.phase = 'clarify';
  st.confirmed = st.confirmed || {};
  Object.assign(st.confirmed, {
    topic: 'SCULPTOR：以"作者建模"为中心的深度协作写作 Agent',
    audience: '中学科技类竞赛评委：懂中文、懂一点 AI 概念但不要求编程——理论与落地并重，指标、案例、交互都要有',
    targetWords: 7500,
    stance:
      '论证写作系统应以"作者建模"为中心：通用写作的下限由模型能力决定，上限由系统对作者的理解决定；让评委看到这是可落地、可复现、有人机深协作的工程系统，而不是概念包装',
    theme:
      '作者建模是写作 AI 的分水岭：通用工具管"作品"，Sculptor 管"作者"——把作者读过的书、写过的文、亲手改过的字、说过的理论都变成可检索、可注入、可演进的第一手资料',
    arguments: [
      '风格是可表征的结构化偏离，不是提示词能装下的：四层风格向量 + 每轮隐式采集 + 修改即风格教学，才能让"AI 写的像你"从口号变成指标',
      '澄清协议要挖思想而不是搭结构：思想脉络追踪用户的"主张-前提-推理-理论来源"，提问主次由 LLM 结合对话自主判断（代码只兜底），配合 RAG 知识背景',
      '人机深协作需要工程可复现：导演状态机主导全流程，Web 工作台把能力贴到作者手边（选区/候选/回滚/可视化），双端 QA 与红队保证不崩、不打架、不 AI 腔',
    ],
    emotionalCurve: '先让评委惊讶于问题的真实，再建立信任于方案的完整，最后以硬证据收束，让人安心',
    endingTaste: '心安则上——系统不是炫技，是让每个普通写作者被认真对待；结尾点题：写作者不必迁就机器，机器应该学习成为他',
    styleSample: true,
    known: 'LLM 已能生成通顺文本，但个人写作普遍"千人一面、AI 腔明显"；现有工具要么提示词式模仿（浅），要么纯模板合规（死）',
    gap: '缺少一个以"作者"为中心的持续模型：风格、知识、意图各自为政，澄清只搭结构不挖思想',
    method: '作者建模三线：风格四层表征 + 思想优先澄清协议 + 导演状态机与 Web 工作台的人机深协作；自动化 QA 与反 AI 审计做可复现验证',
    limitation: '真人盲评样本量待扩大；Web 端依赖用户自配 API；跨语言（非中文）语料尚未系统验证',
  });
  st.materials = SEED_MATERIALS.slice();
  ws.writeState(workspace, st);
  console.log(`已预置作者输入：主题/读者/7500 字/论证链四字段/素材 ${st.materials.length} 条`);
}

// ── 预置高质量回答（L2–L5：素材型/结构型/修正型；全部来自项目真实数据）──
const MATERIALS = SEED_MATERIALS.slice();
const ARGUMENTS = [
  '风格是可表征的结构化偏离，不是提示词能装下的：四层风格向量 + 每轮隐式采集 + 修改即风格教学，才能让"AI 写的像你"从口号变成指标',
  '澄清协议要挖思想而不是搭结构：思想脉络追踪用户的"主张-前提-推理-理论来源"，提问主次由 LLM 结合对话自主判断（代码只兜底），配合 RAG 知识背景，解决"AI 只知道 1+1、不懂为什么 1+1"',
  '人机深协作需要工程可复现：导演状态机主导全流程，Web 工作台把能力贴到作者手边（选区/候选/回滚/可视化），双端 QA 与红队保证不崩、不打架、不 AI 腔',
];
const STYLE_SAMPLE =
  '大语言模型已具备通用文本生成能力，但用于个人写作时普遍存在"千人一面、一眼 AI 腔"的问题。本文提出核心论断：通用写作的下限由模型能力决定，而上限由系统对"作者"的理解决定。据此设计并实现了 SCULPTOR——一个嵌入 Agent 环境的深度协作写作系统，以持续维护的作者风格模型、知识模型与意图模型为中心运转。';
let styleAsked = 0; // 风格底稿只贴一次，重复问即低意愿放行

function answerFor(question) {
  const q = String(question || '');
  // 空缺口回退（LLM 停摆/多问被兜底）→ 低意愿信号，连续两次触发导演放行
  if (/还差「」|没有更多了/.test(q)) return '没有更多了，你决定';
  if (/字数|多长|篇幅|多少字/.test(q))
    return '七千到八千字，把理论、系统与实证都讲透，符合参赛论文的完整篇幅';
  if (/立场|目的|相信|希望读者|想让人/.test(q))
    return '论证写作系统应以"作者建模"为中心：通用写作的下限由模型决定，上限由系统对作者的理解决定；让评委看到这是可落地、可复现、有人机深协作的工程系统，而不是概念包装';
  if (/读者|给谁|听众|场合/.test(q))
    return '中学科技类竞赛评委：懂中文、懂一点 AI 概念但不要求编程——所以理论与落地并重，指标、案例、交互截图都要有，别堆术语';
  if (/素材|经历|画面|数据|引文|案例/.test(q))
    return MATERIALS.shift() || '还有一条：作品库按文体分类并蒸馏"个人写作 skill"，同一作者跨篇保持风格一致，多作品指标可对比';
  if (/立意|核心意思|中心/.test(q))
    return '作者建模是写作 AI 的分水岭：通用工具管"作品"，Sculptor 管"作者"——把作者读过的书、写过的文、亲手改过的字、说过的理论都变成可检索、可注入、可演进的第一手资料';
  if (/论点|支撑|理由|论证/.test(q))
    return ARGUMENTS.shift() || '第四个支撑：跨文体的完整性——公文/合同/学术/小说各有蓝图与导出规范，但共享同一套作者模型与反 AI 审计，证明"个人化"不牺牲"规范性"';
  if (/情感|曲线|情绪/.test(q))
    return '先让评委惊讶于问题的真实（AI 腔为什么治不好），再建立信任于方案的完整（风格/思想/协作三线），最后以硬证据收束，让人安心';
  if (/结尾|收尾|姿态|落点/.test(q))
    return '心安则上——系统不是炫技，是让每个普通写作者被认真对待；结尾用一句话点题：写作者不必迁就机器，机器应该学习成为他';
  if (/风格|旧稿|底稿|写过|文风/.test(q))
    return (styleAsked += 1) === 1 ? STYLE_SAMPLE : '你决定';
  if (/理论|推理|思想|因为|所以|《/.test(q))
    return '这让我想到《乡土中国·文字下乡》的思路：语言简化是文化发展的结果，AI 腔其实就是简化到极端的"烂梗"——它切断了作者与读者之间共享的意义空间。所以我们的方案不是给用户一套光滑模板，而是重建他完整的表达空间';
  if (/论证链|缺口|方法|证据|局限/.test(q))
    return '研究缺口：现有工具要么提示词式"模仿风格"（浅），要么纯模板合规（死）；方法上我们用"作者建模"统摄风格、知识、意图三模型，证据用自动化 QA + 反 AI 审计 + 风格差异对照；局限诚实标注：真人盲评样本量待扩大、Web 端依赖用户自配 API';
  return '继续，你来判断——把最该问的问了';
}

const OPEN = '写一篇参赛学术论文《SCULPTOR：以"作者建模"为中心的深度协作写作 Agent》，约七千字，中文，学术论文文体。资料和实验数据我都在对话里给你，请你先理解我的核心思想，再设计大纲，最后逐节写成一篇有论点、有证据、有诚意的论文。';

let r = await agentStep(cfg, workspace, { lastInput: OPEN });
let step = 0;
let lastQ = '';
let repeat = 0;
let final = null;
while (step < 80) {
  step += 1;
  if (r.kind === 'ask') {
    const q = String(r.question || '').trim();
    if (q === lastQ) repeat += 1;
    else repeat = 0;
    lastQ = q;
    const ans = repeat >= 2 ? '你决定' : answerFor(q);
    console.log(`\n[Q${step}] ${q.slice(0, 90)}`);
    console.log(`[A] ${ans.slice(0, 70)}${ans.length > 70 ? '…' : ''}`);
    r = await agentStep(cfg, workspace, { lastInput: ans });
    continue;
  }
  if (r.kind === 'confirm_outline') {
    console.log(`\n[大纲确认 ${step}] 《${r.outline.title}》 ${(r.outline.sections || []).length} 节`);
    for (const s of r.outline.sections || []) {
      console.log(`  - ${s.heading}（${s.function}${s.thesis ? '；' + s.thesis : ''}）`);
    }
    r = await agentStep(cfg, workspace, { lastInput: '可以，就按这个写' });
    continue;
  }
  if (r.kind === 'working') {
    console.log(`  [working ${step}] ${String(r.message || '').slice(0, 110)}`);
    r = await agentStep(cfg, workspace, { lastInput: '' });
    continue;
  }
  if (r.kind === 'deliver') {
    final = r;
    console.log(`\n✅ [交付 ${step}] ${String(r.message || '').slice(0, 300)}`);
    break;
  }
  if (r.kind === 'blocked') {
    console.log('[blocked]', r.message);
    break;
  }
  r = await agentStep(cfg, workspace, { lastInput: '继续' });
}

if (final) {
  const draft = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  console.log('\n=== 成稿统计 ===');
  console.log('字数:', (draft.match(/[\u4e00-\u9fff]/g) || []).length);
  console.log('节数:', (draft.match(/^## /gm) || []).length);
  console.log('存至:', path.join(workspace, 'draft.md'));
}
process.exit(0);
