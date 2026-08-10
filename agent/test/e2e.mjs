// 全链路 e2e（进程内）：fetch stub + 模拟 LLM，跑通 init→clarify→outline→write→redteam→fix→dissect + MCP。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { respond } from './mock-llm.mjs';
import { runCli } from '../src/cli.js';
import { runMcpServer } from '../src/mcp.js';
import { audit } from '../src/redteam.js';
import { applyChangeIfUnchanged } from '../src/point-edit.js';
import { buildStyleShot } from '../src/style-memory.js';
import { applyStyleDirection } from '../src/style.js';
import { detectGenre, genreBlueprint } from '../src/genre.js';
import { loadPersonalSkill } from '../src/library.js';
import { loadStyleAdapter } from '../src/style-adapter.js';
import { factScan } from '../src/fact-check.js';
import { applyCorrectionFeedback } from '../src/style-pulse.js';
import { proofScan } from '../src/proofread.js';
import { formatReference } from '../src/citation.js';
import { originalityScan } from '../src/originality.js';
import { buildSearchQueries, ingestSearchResults } from '../src/rag.js';
import {
  discoverFromEnv,
  discoverFromCodex,
  redact,
  describeCandidate,
  saveCredentials,
  clearCredentials,
  credentialsFile,
  loadWorkspaceCredentials,
} from '../src/credentials.js';
import { loadConfig } from '../src/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-e2e-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
const workspace = path.join(root, 'ws');
process.env.SCULPTOR_WORKSPACE = workspace;
process.env.SCULPTOR_LLM_API_KEY = 'e2e-mock-key'; // 配合下方 fetch stub：有密钥才走 LLM 分支，实际请求全部离线 mock

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

// 离线 fetch stub：所有 LLM 调用走 mock
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  globalThis.fetchBodies = globalThis.fetchBodies || [];
  globalThis.fetchBodies.push(body); // 捕获全部请求体，验证提示词注入
  const content = respond(body.messages);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content } }],
    }),
  };
};

async function run(args, { input = '' } = {}) {
  process.exitCode = 0;
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await runCli(args, { input });
  } catch (e) {
    logs.push(`[thrown] ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code: process.exitCode, out: logs.join('\n') };
}

try {
  // 0. bin 启动器冒烟（--help / doctor 不走网络）
  let smoke = spawnSync(
    process.execPath,
    [new URL('../bin/sculptor.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8' },
  );
  check('bin 启动器 --help', smoke.status === 0 && smoke.stdout.includes('Sculptor Agent'));

  // 1. init
  let r = await run(['init'], {});
  check('init 成功', r.code === 0 && fs.existsSync(path.join(workspace, 'protocol', 'state.json')));

  // 2. clarify --once：首轮空输入拿第一个问题，然后逐轮回答上一个问题
  const answers = [
    '我想写百年历久的北大红楼',
    '大约一千字',
    '让读者感到历史可以走进去',
    '老师和同学',
    '我在门口站了很久，想象百年前的脚步声',
    '纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚',
    '二楼西侧有一扇窗，窗台积着灰，灰上有细痕',
    '历史不是展品，而是可以站进去的现场',
    '现场感来自具体的人，而非抽象的时间',
    '每一个细节都是过去的证词',
    '先好奇，再触动，最后安宁',
    '停在"心安则上"',
    '史铁生在文中将地坛视为宿命的等待，于荒芜与辉煌的落日中体悟个体生命的流逝 [1.1]。他在生死边缘选择平静审视，将死亡视为必然降临的节日，以通透的智慧将苦难化为对美的沉思',
    // v0.30：核心字段齐后进入"缺口驱动"——逐节补要点，大纲完成度满格后才出现确认题。
    '第一层写石阶被百年脚步磨出的光泽，第二层写窗台积灰上那道细痕',
    '第一层写纪念牌上的字，第二层写百年前的脚步声',
    '第一层写"心安则上"，第二层写走出门口的那一步',
    '可以，就是这样',
  ];
  let last;
  r = await run(['clarify', '--once'], { input: '\n' });
  check('clarify 首轮返回问题', r.code === 0 && JSON.parse(r.out).question);
  for (const a of answers) {
    r = await run(['clarify', '--once'], { input: a + '\n' });
    check('clarify --once 正常', r.code === 0, r.out.slice(0, 100));
    last = JSON.parse(r.out);
  }
  check(
    '澄清挖透立意与论点',
    Boolean(last.confirmed?.theme && last.confirmed?.arguments?.length >= 2),
    JSON.stringify({ c: last.confirmed, m: last.materials }),
  );
  check(
    '整篇文章蓝图已回显并确认',
    last.confirmed?.blueprintConfirmed === true &&
      Boolean(last.blueprint) &&
      last.blueprint?.skeleton?.length >= 1 &&
      Boolean(last.blueprint?.tension),
    JSON.stringify({ b: last.blueprint, rounds: last.blueprintRounds }),
  );
  check('风格底稿问题已问并收尾', last.confirmed?.styleSample === true);
  const writeStyle = JSON.parse(
    fs.readFileSync(path.join(workspace, 'vault', 'write-style.json'), 'utf8'),
  );
  const learnedDims = Object.values(writeStyle.dimensions || {}).filter(
    (d) => (d.confidence || 0) > 0,
  ).length;
  check(
    '对话语气已被动采集进风格档案',
    learnedDims >= 3 && writeStyle.learnedFrom?.samples > 0,
    `已学 ${learnedDims} 维，样本 ${writeStyle.learnedFrom?.samples}`,
  );
  check(
    '风格底稿 14 维提取已落地',
    writeStyle.dimensions?.temperature?.value === '克制内敛' &&
      writeStyle.vector?.personalDataset?.topAssociations?.includes('地坛'),
    JSON.stringify({
      temperature: writeStyle.dimensions?.temperature?.value,
      associations: writeStyle.vector?.personalDataset?.topAssociations,
    }),
  );
  const pulseLog = path.join(workspace, 'vault', 'style-pulses.jsonl');
  const pulseText = fs.existsSync(pulseLog) ? fs.readFileSync(pulseLog, 'utf8') : '';
  check(
    '澄清每轮也记录风格脉搏',
    pulseText.includes('"phase":"clarify"'),
    pulseText.slice(0, 120),
  );

  // 2.4 旧稿种子：模拟作者写过同题旧稿，验证写作时能按论题检索注入
  fs.writeFileSync(
    path.join(workspace, 'vault', 'style-samples', 'old-draft.md'),
    '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，它一直等着一个人走进去。\n',
  );
  // 更新的无关样本：验证排序靠"相关度"而非"最新"（BM25 真的在起作用）
  fs.writeFileSync(
    path.join(workspace, 'vault', 'style-samples', 'unrelated-new.md'),
    '上周我修了一个异步竞态问题，把请求合并成队列，加上了超时与重试，测试覆盖率从 78% 提到 92%。并发高峰的延迟降了一半，日志里也不再有重复报错了。\n',
  );

  // 2.5 需求访谈：独立工作区跑多轮，返回确认清单与进度
  const ws2 = path.join(root, 'ws2');
  process.env.SCULPTOR_WORKSPACE = ws2;
  r = await run(['init'], {});
  check('interview 前 init', r.code === 0);
  r = await run(['interview', '--once'], { input: '\n' });
  const i0 = JSON.parse(r.out);
  check(
    'interview 首轮返回问题+清单',
    Boolean(i0.question) && Array.isArray(i0.checklist) && i0.checklist.length >= 5,
    JSON.stringify({ q: i0.question?.slice(0, 20), n: i0.checklist?.length }),
  );
  for (const a of answers) {
    r = await run(['interview', '--once'], { input: a + '\n' });
    check('interview --once 正常', r.code === 0, r.out.slice(0, 100));
  }
  const iLast = JSON.parse(r.out);
  check(
    '访谈完成：核心需求齐 + 风格底稿收尾',
    iLast.done === true && iLast.remaining.coreCount === 0,
    JSON.stringify({ done: iLast.done, remain: iLast.remaining }),
  );
  r = await run(['interview', '--summary', ws2], {});
  check(
    '访谈摘要打包清单与剩余步骤',
    r.out.includes('确认清单') && r.out.includes('下一步'),
    r.out.slice(0, 120),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 2.8 导演模式：自主决策、主导全程（agent --once，逐条转发用户消息）
  const ws3 = path.join(root, 'ws3');
  process.env.SCULPTOR_WORKSPACE = ws3;
  r = await run(['init'], {});
  check('导演前 init', r.code === 0);
  r = await run(['agent', '--once'], { input: '\n' });
  let ar = JSON.parse(r.out);
  check(
    '导演首步提问',
    ar.kind === 'ask' && Boolean(ar.question),
    JSON.stringify(ar).slice(0, 100),
  );
  for (const a of answers) {
    r = await run(['agent', '--once'], { input: a + '\n' });
    ar = JSON.parse(r.out);
  }
  check(
    '导演澄清完成后自动生成大纲并请求确认',
    ar.kind === 'confirm_outline' && ar.outline?.sections?.length >= 1,
    JSON.stringify(ar).slice(0, 140),
  );
  const ws3WriteStyle = JSON.parse(
    fs.readFileSync(path.join(ws3, 'vault', 'write-style.json'), 'utf8'),
  );
  check(
    '对话级双风格提炼已触发（无旧稿也建立高层次档案）',
    Object.values(ws3WriteStyle.dimensions || {}).some((d) =>
      (d.evidence || []).some((e) => e.includes('对话整体提炼')),
    ) &&
      (ws3WriteStyle.vector?.personalDataset?.topAssociations || []).includes('银杏'),
    JSON.stringify(ws3WriteStyle.vector?.personalDataset?.topAssociations),
  );
  r = await run(['agent', '--once'], { input: '可以\n' });
  ar = JSON.parse(r.out);
  check('导演确认后自动开始写作', ar.kind === 'working' || ar.kind === 'deliver', ar.kind);
  let dguard = 0;
  while (ar.kind !== 'deliver' && dguard < 30) {
    r = await run(['agent', '--once'], { input: '\n' });
    ar = JSON.parse(r.out);
    dguard += 1;
  }
  check(
    '导演自动推进到交付（逐节写作→审计→群像→交付，无需用户催）',
    ar.kind === 'deliver' && fs.existsSync(path.join(ws3, 'draft.md')),
    `${ar.kind} ${String(ar.message).slice(0, 80)}`,
  );
  const ws3StateAfterDeliver = JSON.parse(
    fs.readFileSync(path.join(ws3, 'protocol', 'state.json'), 'utf8'),
  );
  check(
    '交付前静默质量门真实触发（风格保真/原创性/校对/事实核查→RAG 排队）',
    typeof ws3StateAfterDeliver.quality?.styleScore === 'number' &&
      typeof ws3StateAfterDeliver.quality?.originality === 'object' &&
      typeof ws3StateAfterDeliver.quality?.proofread === 'number' &&
      typeof ws3StateAfterDeliver.quality?.factVerify === 'number',
    JSON.stringify(ws3StateAfterDeliver.quality).slice(0, 160),
  );
  // 交付后：用户给风格方向 → 导演全文重写 → 审计 → 群像 → 再次交付
  r = await run(['agent', '--once'], { input: '整篇更克制一点\n' });
  ar = JSON.parse(r.out);
  check(
    '导演收到风格方向后自动触发重写',
    ar.kind === 'working' && String(ar.message).includes('重写'),
    ar.kind,
  );
  dguard = 0;
  while (ar.kind !== 'deliver' && dguard < 20) {
    r = await run(['agent', '--once'], { input: '\n' });
    ar = JSON.parse(r.out);
    dguard += 1;
  }
  check('重写后再次交付', ar.kind === 'deliver', ar.kind);
  const allPrompts = JSON.stringify(globalThis.fetchBodies || []);
  check(
    '个人写作 skill 注入写作提示（蒸馏自旧作，限量不污染上下文）',
    allPrompts.includes('这类文体你个人的写法') && allPrompts.includes('个人写作 skill'),
    allPrompts.slice(0, 120),
  );
  r = await run(['library']);
  check(
    '导演交付后自动归档并蒸馏',
    r.out.includes('已蒸馏') && r.out.includes('散文'),
    r.out.slice(0, 120),
  );
  r = await run(['export', '--docx', path.join(ws3, 'draft-export.docx')]);
  check(
    'export 导出 docx',
    r.code === 0 && fs.existsSync(path.join(ws3, 'draft-export.docx')),
    r.out.slice(0, 100),
  );
  const pyDocxCheck = spawnSync('python3', ['-c', 'import docx; print(1)'], { encoding: 'utf8' });
  if (pyDocxCheck.status === 0) {
    r = await run(['export', '--official', '--docx', path.join(ws3, 'draft-official.docx')]);
    check(
      'export --official 按 GB/T 9704 排版导出公文 docx',
      r.code === 0 && fs.existsSync(path.join(ws3, 'draft-official.docx')),
      r.out.slice(0, 120),
    );
  } else {
    check('export --official 公文 docx', true, '跳过：本机无 python-docx');
  }
  r = await run(['export', '--html', path.join(ws3, 'draft.html')]);
  check(
    'export --html 生成完整 HTML',
    r.code === 0 &&
      fs.existsSync(path.join(ws3, 'draft.html')) &&
      fs.readFileSync(path.join(ws3, 'draft.html'), 'utf8').includes('<!DOCTYPE html>'),
    r.out.slice(0, 100),
  );
  r = await run(['export', '--srt', path.join(ws3, 'draft.srt')]);
  check(
    'export --srt 生成字幕',
    r.code === 0 && fs.existsSync(path.join(ws3, 'draft.srt')),
    r.out.slice(0, 100),
  );
  r = await run(['export', '--pdf', path.join(ws3, 'draft.pdf')]);
  check(
    'export --pdf（reportlab）',
    r.code === 0 && fs.existsSync(path.join(ws3, 'draft.pdf')),
    r.out.slice(0, 100),
  );
  if (pyDocxCheck.status === 0) {
    r = await run(['export', '--academic', '--docx', path.join(ws3, 'draft-academic.docx')]);
    check(
      'export --academic 学术排版 docx',
      r.code === 0 && fs.existsSync(path.join(ws3, 'draft-academic.docx')),
      r.out.slice(0, 100),
    );
  }
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 2.9 文体库：公式化内容的结构范式
  r = await run(['genre', '合同']);
  check('文体库·合同结构范式', r.code === 0 && r.out.includes('违约责任'), r.out.slice(0, 80));
  r = await run(['genre', '请示']);
  check('文体库·请示结构范式', r.code === 0 && r.out.includes('妥否，请批示'), r.out.slice(0, 80));
  r = await run(['genre', '批复']);
  check('文体库·批复含此复固定语', r.code === 0 && r.out.includes('此复'), r.out.slice(0, 80));
  r = await run(['genre', 'list']);
  check(
    '文体库清单（含 15 文种关键项）',
    r.code === 0 &&
      r.out.includes('公文') &&
      r.out.includes('合同') &&
      r.out.includes('请示') &&
      r.out.includes('批复') &&
      r.out.includes('函') &&
      r.out.includes('通报'),
    r.out.slice(0, 120),
  );
  check(
    '文体识别：通知/合同/议论文',
    detectGenre('写一份关于安全生产的通知') === '通知' &&
      detectGenre('拟一份房屋租赁合同') === '合同' &&
      detectGenre('这是一篇议论文的立意') === '议论文',
  );
  check(
    '文体识别：请示/批复/函',
    detectGenre('关于追加经费的请示') === '请示' &&
      detectGenre('关于同意追加经费的批复') === '批复' &&
      detectGenre('关于商洽合作事项的函') === '函',
  );
  r = await run([
    'cite',
    JSON.stringify([
      { type: 'journal', authors: ['史铁生'], year: 1990, title: '我与地坛', journal: '上海文学', issue: 1, pages: '1-20' },
    ]),
  ]);
  check(
    'cite 生成 GB/T 7714 参考文献',
    r.code === 0 && r.out.includes('我与地坛[J]') && r.out.includes('上海文学'),
    r.out.slice(0, 120),
  );
  r = await run([
    'cite',
    JSON.stringify({ type: 'book', authors: ['钱穆'], year: 1996, title: '国史大纲', city: '北京', publisher: '商务印书馆' }),
    '--style',
    'apa',
  ]);
  check(
    'cite --style apa',
    r.code === 0 && r.out.includes('国史大纲') && r.out.includes('商务印书馆'),
    r.out.slice(0, 120),
  );
  check(
    'formatReference 确定性（期刊）',
    formatReference({ type: 'journal', authors: ['史铁生'], year: 1990, title: '我与地坛', journal: '上海文学' }, 'gbt7714').includes('史铁生. 我与地坛[J]'),
  );
  check(
    '文体识别：学术论文/新闻稿/邮件/视频脚本',
    detectGenre('写一篇关于AI教育的学术论文') === '学术论文' &&
      detectGenre('写一篇产品发布的新闻稿') === '新闻稿' &&
      detectGenre('给客户发一封邮件') === '邮件' &&
      detectGenre('写一段短视频口播稿') === '视频脚本' &&
      detectGenre('帮我写个脚本') === null,
  );
  check(
    '文体识别：小说（欧亨利式）',
    detectGenre('写一个欧亨利式反转的短篇小说') === '小说' &&
      detectGenre('写一篇欧亨利式的故事') === '小说',
  );
  r = await run(['genre', '小说']);
  check(
    '文体库·小说含反转/伏笔骨架',
    r.code === 0 && r.out.includes('反转') && r.out.includes('伏笔'),
    r.out.slice(0, 120),
  );
  const bpOfficial = genreBlueprint('公文');
  const bpAcademic = genreBlueprint('学术论文');
  const bpProse = genreBlueprint('散文');
  check(
    '动态蓝图：公文问事项/主送/依据，不问论点与情感',
    bpOfficial.some((f) => f.key === 'items') &&
      bpOfficial.some((f) => f.key === 'recipient') &&
      bpOfficial.some((f) => f.key === 'basis') &&
      !bpOfficial.some((f) => f.key === 'argument') &&
      !bpOfficial.some((f) => f.key === 'emotion'),
    JSON.stringify(bpOfficial.map((f) => f.key)),
  );
  check(
    '动态蓝图：论文要论点×2，散文不要论点',
    bpAcademic.some((f) => f.key === 'argument' && f.required && f.count >= 2) &&
      !bpProse.some((f) => f.key === 'argument') &&
      bpProse.some((f) => f.key === 'theme'),
  );
  check(
    '动态蓝图：目标字数进入蓝图（必问）',
    bpProse.some((f) => f.key === 'targetWords' && f.required),
  );
  check(
    '篇幅预算：素材/论点下限随字数放大',
    genreBlueprint('散文', { targetWords: 3000 }).find((f) => f.key === 'materials').count >= 8 &&
      genreBlueprint('学术论文', { targetWords: 2000 }).find((f) => f.key === 'argument').count >= 2,
  );
  const { parseTargetWords, contentBudget } = await import('../src/budget.js');
  check(
    '目标字数解析：中文数字/阿拉伯数字',
    parseTargetWords('大约一千字') === 1000 &&
      parseTargetWords('三千字左右') === 3000 &&
      parseTargetWords('3000字') === 3000,
  );
  const b3000 = contentBudget({ targetWords: 3000 });
  const b1000 = contentBudget({ targetWords: 1000 });
  check(
    '篇幅预算：3000 字 → 约 8 节/每节 ~380/素材 ≥8',
    b3000.sections >= 7 && b3000.materialsMin >= 8 && b3000.perSection <= 450,
    JSON.stringify(b3000),
  );
  check(
    '篇幅预算：1000 字 → 素材 ≥2 节数 3',
    b1000.materialsMin >= 2 && b1000.sections === 3,
    JSON.stringify(b1000),
  );
  const ws9 = path.join(root, 'ws9');
  process.env.SCULPTOR_WORKSPACE = ws9;
  r = await run(['interview', '--once'], { input: '写一份关于安全生产的通知\n' });
  const iOfficial = JSON.parse(r.out);
  check(
    '访谈清单随文体动态切换（通知 → 事项/主送，无论点）',
    iOfficial.checklist?.some((x) => x.label.includes('事项')) &&
      iOfficial.checklist?.some((x) => x.label.includes('主送')) &&
      !iOfficial.checklist?.some((x) => x.label.includes('论点')),
    JSON.stringify(iOfficial.checklist?.map((x) => x.label)),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;
  const ws10 = path.join(root, 'ws10');
  const { ensureWorkspace: ensureWs, writeState: writeWs } = await import('../src/workspace.js');
  const { gate } = await import('../src/outline.js');
  ensureWs(ws10, { create: true });
  writeWs(ws10, {
    phase: 'clarify',
    confirmed: { genre: '散文', topic: 't', stance: 's', theme: 'm', targetWords: 1000 },
    materials: ['a', 'b', 'c'],
  });
  check('大纲门槛动态：散文不强制论点', gate(ws10).ok === true);
  writeWs(ws10, {
    phase: 'clarify',
    confirmed: { genre: '散文', topic: 't', stance: 's', theme: 'm', targetWords: 3000 },
    materials: ['a', 'b', 'c'],
  });
  check(
    '大纲门槛动态：3000 字缺素材被拦截（≥8 条）',
    gate(ws10).ok === false && gate(ws10).missing.join().includes('素材'),
    gate(ws10).missing.join(),
  );
  writeWs(ws10, { phase: 'clarify', confirmed: { genre: '公文', topic: 't' }, materials: [] });
  check('大纲门槛动态：公文缺事项/依据被拦截', gate(ws10).ok === false);

  // 2.10 个人写作库：分类 + 蒸馏 + 查看 + 限量注入
  const ws4 = path.join(root, 'ws4');
  process.env.SCULPTOR_WORKSPACE = ws4;
  r = await run(['init'], {});
  const essayFile = path.join(root, 'essay.md');
  fs.writeFileSync(
    essayFile,
    '我认为教育的本质是唤醒。首先，它让人看见自己的可能性；其次，它教人用证据说话。然而，当前的评价体系却常常压抑这种唤醒。由此可见，改革势在必行。\n',
  );
  r = await run(['library', 'add', essayFile, '--title', '论教育的唤醒']);
  check(
    'library add 自动分类为议论文',
    r.code === 0 && r.out.includes('议论文'),
    r.out.slice(0, 80),
  );
  r = await run(['library', 'scan']);
  check(
    'library scan 蒸馏个人写作 skill',
    r.code === 0 && fs.existsSync(path.join(ws4, 'vault', 'skills', 'personal', '议论文.md')),
    r.out.slice(0, 80),
  );
  r = await run(['library']);
  check('library 列表显示分类与蒸馏状态', r.out.includes('议论文') && r.out.includes('已蒸馏'));
  r = await run(['library', 'view', '议论文']);
  check(
    'library view 可查看个人 skill',
    r.code === 0 && r.out.includes('个人写作 skill') && r.out.includes('代表句'),
    r.out.slice(0, 100),
  );
  check(
    'loadPersonalSkill 限量返回（不污染上下文）',
    loadPersonalSkill(ws4, { category: '议论文' }).includes('个人写作 skill') &&
      loadPersonalSkill(ws4, { category: '议论文', limit: 50 }).length <= 60,
  );
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 2.11 多模态输入：docx / xlsx 提取为素材
  const ioDir = path.join(root, 'io');
  fs.mkdirSync(ioDir, { recursive: true });
  const pyHas = spawnSync('python3', ['-c', 'import docx; print(1)'], { encoding: 'utf8' });
  if (pyHas.status === 0) {
    const docxFile = path.join(ioDir, 'sample.docx');
    spawnSync(
      'python3',
      [
        '-c',
        `from docx import Document; d=Document(); d.add_heading('材料一',0); d.add_paragraph('这是 docx 里的素材内容。'); d.save('${docxFile}')`,
      ],
      { encoding: 'utf8' },
    );
    r = await run(['ingest', docxFile]);
    check('ingest 提取 docx 素材', r.code === 0 && r.out.includes('docx'), r.out.slice(0, 100));
  } else {
    check('ingest 提取 docx 素材', true, '跳过：本机无 python-docx');
  }
  const xlsxFile = path.join(ioDir, 'data.xlsx');
  const xlsxScript = path.join(ioDir, 'make-xlsx.py');
  fs.writeFileSync(
    xlsxScript,
    [
      'import zipfile',
      `z = zipfile.ZipFile('${xlsxFile}', 'w')`,
      'z.writestr(\'[Content_Types].xml\', \'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>\')',
      'z.writestr(\'_rels/.rels\', \'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>\')',
      'z.writestr(\'xl/workbook.xml\', \'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>\')',
      'z.writestr(\'xl/_rels/workbook.xml.rels\', \'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>\')',
      'z.writestr(\'xl/sharedStrings.xml\', \'<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>2025年招生人数</t></si><si><t>同比增长12%</t></si></sst>\')',
      'z.writestr(\'xl/worksheets/sheet1.xml\', \'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>\')',
      'z.close()',
    ].join('\n'),
  );
  const xlsxStatus = spawnSync('python3', [xlsxScript], { encoding: 'utf8' });
  if (xlsxStatus.status === 0) {
    r = await run(['ingest', xlsxFile]);
    check(
      'ingest 提取 xlsx 素材（zipfile 兜底）',
      r.code === 0 && r.out.includes('xlsx'),
      r.out.slice(0, 100),
    );
  } else {
    check(
      'ingest 提取 xlsx 素材（zipfile 兜底）',
      true,
      `跳过：无法构造测试 xlsx（${xlsxStatus.stderr.slice(0, 60)}）`,
    );
  }
  const audioFile = path.join(ioDir, 'note.m4a');
  fs.writeFileSync(audioFile, 'fake audio bytes');
  r = await run(['ingest', audioFile]);
  check(
    'ingest 音频无 whisper 时明确降级提示',
    r.code === 0 && r.out.includes('whisper'),
    r.out.slice(0, 140),
  );
  const fakeWhisper = path.join(ioDir, 'fake-whisper.sh');
  fs.writeFileSync(
    fakeWhisper,
    '#!/bin/sh\necho "今天参观北大红楼，站在门口很久，想到了百年前的青年们。"\n',
  );
  spawnSync('chmod', ['+x', fakeWhisper]);
  process.env.SCULPTOR_WHISPER_CMD = fakeWhisper;
  r = await run(['dictate', audioFile]);
  check(
    'dictate 语音口述转录为素材（whisper 命令不阻塞、超时可控）',
    r.code === 0 && r.out.includes('voice') && r.out.includes('已加入素材'),
    r.out.slice(0, 160),
  );
  delete process.env.SCULPTOR_WHISPER_CMD;

  // 2.6 quote 引用块
  r = await run(['quote', '那扇窗沉默地注视着一切。']);
  check(
    'quote 生成可粘贴引用块',
    r.out.includes('〔Sculptor 引用〕《那扇窗沉默地注视着一切。》') && r.out.includes('修改指令'),
  );

  // 2.7 style 档案进度可见
  r = await run(['style']);
  check(
    'style 命令显示档案进度',
    r.out.includes('风格档案进度') && r.out.includes('已学'),
    r.out.slice(0, 100),
  );

  // 3. outline
  r = await run(['outline']);
  check('大纲 3 节', r.code === 0 && r.out.includes('3 节'), r.out.slice(0, 120));
  r = await run(['outline-review']);
  check(
    'outline-review 大纲评审-修订回路',
    r.code === 0 && r.out.includes('大纲评审') && r.out.includes('评分'),
    r.out.slice(0, 160),
  );
  const stateAfterOutline = JSON.parse(
    fs.readFileSync(path.join(workspace, 'protocol', 'state.json'), 'utf8'),
  );
  check(
    '评审记录已入 state.outlineReviews',
    (stateAfterOutline.outlineReviews || []).length >= 1 &&
      typeof stateAfterOutline.outlineReviews[0].score === 'number',
    JSON.stringify(stateAfterOutline.outlineReviews?.slice(0, 1)),
  );

  // 4. write（mock 正文偏短 → 触发扩写；扩写版干净）
  r = await run(['write']);
  check(
    '写作完成 + 触发扩写',
    r.code === 0 && r.out.includes('已扩写') && r.out.includes('合计'),
    r.out.slice(0, 200),
  );
  const draftText = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  const cjkCount = (draftText.match(/[\u4e00-\u9fff]/g) || []).length;
  check(`字数达标（${cjkCount} ≥ 540）`, cjkCount >= 540, `总字数 ${cjkCount}`);
  const pulseLines = fs.existsSync(pulseLog)
    ? fs
        .readFileSync(pulseLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
    : [];
  check(
    '每节写作记录风格脉搏（jsonl）',
    pulseLines.filter((l) => l.includes('"phase":"write"')).length >= 3,
    `write pulses=${pulseLines.filter((l) => l.includes('"phase":"write"')).length}`,
  );
  const pulseState = JSON.parse(
    fs.readFileSync(path.join(workspace, 'protocol', 'state.json'), 'utf8'),
  );
  check(
    '风格脉搏进 state（供下一节注入）',
    (pulseState.stylePulses || []).filter((p) => p.phase === 'write').length >= 3,
    JSON.stringify((pulseState.stylePulses || []).slice(-2)),
  );

  // 4.5 退让协议：draft.md 被外部修改 → 不覆盖；--force 才重写
  fs.writeFileSync(path.join(workspace, 'draft.md'), '外部 agent 改过这一行\n');
  r = await run(['write']);
  check('外部修改时退让不覆盖', r.code !== 0 && r.out.includes('退让'), r.out.slice(0, 100));
  check(
    'draft 未被覆盖',
    fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8') === '外部 agent 改过这一行\n',
  );
  r = await run(['write', '--force']);
  check('--force 强制重写', r.code === 0, r.out.slice(0, 120));
  const writePrompts = JSON.stringify(globalThis.fetchBodies || []);
  check(
    '写作提示注入了风格少样本（旧稿+反例）',
    writePrompts.includes('风格少样本') &&
      writePrompts.includes('破晓的号角') &&
      writePrompts.includes('作者绝不会这样写'),
    writePrompts.slice(0, 140),
  );

  // 4.6 风格方向 → 全文重写（restyle）：方向落档案，缺省读取最近方向，重写整篇
  const dirRes = applyStyleDirection(workspace, '整篇更豪迈，有气势一点');
  check(
    '风格方向已落档案并提升维度',
    dirRes.applied === true &&
      JSON.parse(fs.readFileSync(path.join(workspace, 'vault', 'write-style.json'), 'utf8'))
        .styleDirections?.length >= 1,
    JSON.stringify(dirRes),
  );
  const draftBefore = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  r = await run(['restyle']);
  check(
    'restyle 缺省读取最近风格方向并重写全文',
    r.code === 0 && r.out.includes('更豪迈有气势') && r.out.includes('重写 3 节'),
    r.out.slice(0, 160),
  );
  const draftAfter = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  check(
    '重写后草稿已更新且结构保留',
    draftAfter !== draftBefore && draftAfter.includes('## 一、站在门口'),
  );
  r = await run(['style', '--export']);
  check(
    'style --export 导出人类可读风格档案',
    r.code === 0 &&
      fs.existsSync(path.join(workspace, 'vault', 'style-profile.md')) &&
      fs
        .readFileSync(path.join(workspace, 'vault', 'style-profile.md'), 'utf8')
        .includes('风格方向变化'),
  );
  const mcpInput4 = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'restyle', arguments: { workspace, direction: '更克制一点' } } })}\n`,
  ]);
  const mcpOut4 = [];
  const output4 = new Writable({
    write(c, _e, cb) {
      mcpOut4.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input: mcpInput4, output: output4 });
  const byId4 = Object.fromEntries(
    mcpOut4
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check(
    'MCP restyle 按方向重写',
    byId4[8]?.result?.content?.[0]?.text?.includes('更克制一点') &&
      byId4[8]?.result?.content?.[0]?.text?.includes('重写 3 节'),
  );
  const mcpInput5 = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_step', arguments: { workspace: ws3, lastInput: '' } } })}\n`,
  ]);
  const mcpOut5 = [];
  const output5 = new Writable({
    write(c, _e, cb) {
      mcpOut5.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input: mcpInput5, output: output5 });
  const byId5 = Object.fromEntries(
    mcpOut5
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check('MCP agent_step 返回导演决策', byId5[9]?.result?.content?.[0]?.text?.includes('kind'));

  // 5. 确定性红队：直接审计植入文本，应抓到黑名单与重复比喻
  const planted = [
    '在当今社会，站在门口，我感到历史像旧朝宫人一样沉默。不是所有的门都通向过去。',
    '沿着走廊，脚步像旧朝宫人踏过回廊。近年来，人们总说历史很远。',
    '离开时回头，那栋楼像旧朝宫人一样站在原地。总而言之，历史从不缺席。',
  ].join('\n');
  const rep = audit(planted);
  check(
    '红队抓到黑名单',
    rep.blacklistHits.length >= 3,
    JSON.stringify(rep.blacklistHits.map((h) => h.phrase)),
  );
  check(
    '红队抓到重复比喻',
    rep.repeatedMetaphors.length >= 1,
    JSON.stringify(rep.repeatedMetaphors.map((m) => m.vehicle)),
  );
  check('红队判定未通过', rep.passed === false);

  // 6. redteam --fix 对污染稿修复 → 复检通过
  fs.writeFileSync(path.join(workspace, 'draft.md'), planted);
  r = await run(['redteam', '--fix']);
  check('LLM 修订成功', r.code === 0, r.out.slice(0, 120));
  const after = audit(fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8'));
  check(
    '复检通过（黑名单 0 / 重复比喻 0）',
    after.passed === true,
    JSON.stringify({
      blacklist: after.blacklistHits,
      metaphors: after.repeatedMetaphors,
    }),
  );

  // 5.5 结构性 AI 痕迹（长文级，从《差生》审计提炼）
  const structuralSample = [
    '我想说，我没有作弊。我想说，我写完了。我想说，那是我自己的答案。',
    '我数教室的窗户，数到第八扇，乱了。我数天花板的灯，数到第三盏，停了。',
    '我又数墙上的裂缝，数到第五条，忘了。',
    '走廊的灯亮着，白的。月光落在地上，白的。清晨的光也是白的。',
    '迟到是迟到，白卷是白卷，打架是打架。',
    '这句话我没有说出口。这句话我没有告诉任何人。',
    '他问：“挺好。”我又说：“挺好。”他点头：“挺好。”她问：“挺好。”我答：“挺好。”',
  ].join('\n');
  const srep = audit(structuralSample);
  check(
    '结构性 AI 痕迹：排比/重复动机/单字句意象/同语反复/内心收束/口头禅全抓到',
    srep.structuralSignals.some((s) => s.includes('三连排比')) &&
      srep.structuralSignals.some((s) => s.includes('数…，数到')) &&
      srep.structuralSignals.some((s) => s.includes('白的')) &&
      srep.structuralSignals.some((s) => s.includes('同语反复')) &&
      srep.structuralSignals.some((s) => s.includes('内心话')) &&
      srep.structuralSignals.some((s) => s.includes('口头禅')),
    JSON.stringify(srep.structuralSignals),
  );
  const chapterSample = '## 一\n期中考试。\n考场很安静。\n\n## 二\n家长会。\n教室里坐满了人。\n\n## 三\n放学后。\n我走得很慢。';
  const crep = audit(chapterSample);
  check(
    '结构性 AI 痕迹：章节开头单句定场 / 结尾金句',
    crep.structuralSignals.some((s) => s.includes('章节开头模式化')) &&
      crep.structuralSignals.some((s) => s.includes('章节结尾模式化')),
    JSON.stringify(crep.structuralSignals),
  );
  const metaSample = '他说话快，像赶火车。律师说得急，像在赶火车。';
  const mrep = audit(metaSample);
  check(
    '比喻归一化：像赶火车 / 像在赶火车 同喻体被抓',
    mrep.repeatedMetaphors.some((m) => m.vehicle.includes('赶火车')),
    JSON.stringify(mrep.repeatedMetaphors),
  );

  // 6.5 读者群像（交付前强制环节）
  r = await run(['audience']);
  check(
    '读者群像 8 人反馈',
    r.code === 0 &&
      r.out.includes('读者群像') &&
      r.out.includes('老教师') &&
      r.out.includes('最想对作者说'),
    r.out.slice(0, 160),
  );
  r = await run(['audience', '--quick']);
  check('--quick 快速模式', r.code === 0 && r.out.includes('读者群像'));
  r = await run(['debate']);
  check(
    'debate 读者交锋收敛共识/争议/优先级',
    r.code === 0 &&
      r.out.includes('读者交锋') &&
      r.out.includes('共识') &&
      r.out.includes('争议') &&
      r.out.includes('优先级'),
    r.out.slice(0, 140),
  );
  // skill 形态（scripts/sculptor.mjs）也必须提供读者群像与重写命令
  const skillScript = new URL('../../skills/sculptor/scripts/sculptor.mjs', import.meta.url)
    .pathname;
  const skillAud = spawnSync(process.execPath, [skillScript, 'audience', workspace, '--quick'], {
    encoding: 'utf8',
  });
  check(
    'skill 脚本 audience 可用（离线兜底）',
    skillAud.status === 0 &&
      skillAud.stdout.includes('读者群像') &&
      skillAud.stdout.includes('老教师'),
    (skillAud.stdout + skillAud.stderr).slice(0, 120),
  );
  const skillHelp = spawnSync(process.execPath, [skillScript, '--help'], { encoding: 'utf8' });
  check(
    'skill 脚本已注册 audience 与 restyle',
    skillHelp.status === 0 &&
      skillHelp.stdout.includes('audience') &&
      skillHelp.stdout.includes('restyle'),
  );
  check(
    'skill 启动器 = 完整引擎（interview/outline/write/redteam/dissect/mcp 全注册）',
    skillHelp.status === 0 &&
      skillHelp.stdout.includes('interview') &&
      skillHelp.stdout.includes('outline') &&
      skillHelp.stdout.includes('write') &&
      skillHelp.stdout.includes('redteam') &&
      skillHelp.stdout.includes('dissect') &&
      skillHelp.stdout.includes('mcp'),
  );
  r = await run([
    'hook',
    workspace,
    JSON.stringify({ event: 'session/start', summary: 'e2e 会话' }),
  ]);
  check('hook 记录会话事件', r.code === 0 && r.out.includes('session-start'), r.out.slice(0, 80));
  r = await run([
    'hook',
    workspace,
    JSON.stringify({ event: 'user/message', message: 'e2e 用户消息' }),
  ]);
  check('hook 记录用户消息', r.code === 0 && r.out.includes('用户消息'), r.out.slice(0, 80));
  r = await run(['checklist', workspace]);
  check('checklist 渲染确认清单', r.code === 0 && r.out.includes('确认清单'), r.out.slice(0, 80));

  // 7. dissect
  r = await run(['dissect']);
  const d = JSON.parse(r.out);
  check(
    '感性解剖 5 维度完整',
    Boolean(d.stance && d.limits && d.perplexity && d.povs && d.suggestions?.length),
  );

  // 8. absorb + fingerprint
  const editFile = path.join(root, 'edit.json');
  fs.writeFileSync(
    editFile,
    JSON.stringify({
      target: '结尾句',
      original: '历史从不缺席',
      changed: '历史从不等候，只等人走进去',
      intent: '留白',
      writeDims: { endingPattern: { value: '留白收束', delta: 0.25 } },
    }),
  );
  r = await run(['absorb', workspace, editFile]);
  check('定点修改吸收', r.code === 0 && r.out.includes('1 维'));
  const shot = buildStyleShot(workspace, { topic: '北大红楼 历史 现场' });
  check(
    '风格记忆按相关度排序（同题旧稿压过更新的无关样本 + 修改对入列）',
    shot?.samples?.[0]?.source === 'old-draft.md' &&
      shot.samples.some((s) => s.source === 'unrelated-new.md') &&
      shot.samples[0].score > shot.samples.find((s) => s.source === 'unrelated-new.md').score &&
      (shot?.edits?.length || 0) >= 1,
    JSON.stringify(
      shot?.samples?.map((s) => `${s.source}:${s.score}`).join(', ') +
        ` edits=${shot?.edits?.length}`,
    ),
  );
  r = await run(['style', '--memory', '北大红楼 历史 现场']);
  check(
    'style --memory 预览旧稿与修改对',
    r.code === 0 && r.out.includes('石阶还是旧的') && r.out.includes('历史从不等候'),
    r.out.slice(0, 160),
  );
  r = await run(['fingerprint']);
  check(
    '压缩指纹刷新',
    r.code === 0 && fs.existsSync(path.join(workspace, 'vault', 'style-fingerprint.json')),
  );

  // 8.4 修改建议 = 评估反馈：落档案 + 记 correction 脉搏
  const corr = applyCorrectionFeedback(workspace, '结尾太文艺了，收一点');
  const corrStyle = JSON.parse(
    fs.readFileSync(path.join(workspace, 'vault', 'write-style.json'), 'utf8'),
  );
  check(
    '修改建议吸收进风格档案（意象收紧 + 证据）',
    corr.applied === true &&
      corr.updated >= 1 &&
      corr.phrase.includes('意象') &&
      (corrStyle.dimensions?.imageryTendency?.evidence || []).some((e) =>
        e.includes('用户修改建议'),
      ),
    JSON.stringify(corr),
  );
  r = await run(['style', '--pulses']);
  check(
    'style --pulses 查看风格脉搏',
    r.code === 0 && r.out.includes('风格脉搏') && r.out.includes('correction'),
    r.out.slice(0, 140),
  );

  // 8.5 风格保真评估闭环：对照作者样本打分 + 历史记录 + 无参照系兜底
  r = await run(['style-eval']);
  check(
    'style-eval 风格保真评估（LLM+集成指标）',
    r.code === 0 && r.out.includes('风格保真评估') && r.out.includes('保真度'),
    r.out.slice(0, 160),
  );
  const evalLog = path.join(workspace, 'vault', 'style-eval.jsonl');
  check(
    '风格评估历史已记录',
    fs.existsSync(evalLog) && fs.readFileSync(evalLog, 'utf8').trim().length > 0,
  );
  const wsNoRef = path.join(root, 'ws-noref');
  process.env.SCULPTOR_WORKSPACE = wsNoRef;
  r = await run(['init'], {});
  check('无参照系工作区 init', r.code === 0);
  fs.writeFileSync(
    path.join(wsNoRef, 'draft.md'),
    '这是一段足够长的测试文字，用来验证在没有作者旧稿和修改记录时，风格保真评估依然能给出确定性兜底结果，不会因为缺少参照系而中断整个流程。\n',
  );
  r = await run(['style-eval']);
  check(
    'style-eval 无参照系时确定性兜底',
    r.code === 0 && r.out.includes('参照'),
    r.out.slice(0, 120),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 8.6 风格持续微调基建：适配卡蒸馏 + 偏好对数据集 + 本地 LoRA 指引
  r = await run(['style-adapter']);
  check(
    'style-adapter 状态显示素材量',
    r.code === 0 && r.out.includes('风格微调状态') && r.out.includes('旧稿'),
    r.out.slice(0, 120),
  );
  r = await run(['style-adapter', '--distill']);
  check(
    'style-adapter --distill 蒸馏风格适配卡',
    r.code === 0 && fs.existsSync(path.join(workspace, 'vault', 'style-adapter.md')),
    r.out.slice(0, 120),
  );
  check(
    '风格适配卡限量注入（不污染上下文）',
    loadStyleAdapter(workspace, 200).length <= 220,
    `len=${loadStyleAdapter(workspace, 200).length}`,
  );
  r = await run(['style-adapter', '--dataset']);
  check(
    'style-adapter --dataset 生成偏好对 JSONL',
    r.code === 0 &&
      fs.existsSync(path.join(workspace, 'vault', 'style-adapter-dataset.jsonl')),
    r.out.slice(0, 120),
  );
  r = await run(['style-adapter', '--lora']);
  check(
    'style-adapter --lora 未配置端点时给本地 LoRA 指引',
    r.code === 0 && r.out.includes('style_lora.py'),
    r.out.slice(0, 160),
  );

  // 8.7 事实核查：确定性扫描 + LLM 分级
  const plantedFacts = '1987年《光明日报》刊登了相关报道，三百多座红砖楼如今剩不到三十座。';
  const fsr = factScan(plantedFacts, []);
  check(
    'factScan 确定性标记年代/引文/数字',
    fsr.items.some(
      (i) => i.text.includes('1987') && i.supported === 'verify',
    ) &&
      fsr.items.some((i) => i.type === 'quote'),
    JSON.stringify(fsr.items.map((i) => i.text)),
  );
  r = await run(['fact-check']);
  check(
    'fact-check 分级核查并给出 verify 项',
    r.code === 0 && r.out.includes('事实核查') && r.out.includes('verify'),
    r.out.slice(0, 140),
  );
  const prText = '请登录您的帐号，我们迫不急待要开始。他说：今天很忙“然后继续。';
  const prScan = proofScan(prText);
  check(
    'proofScan 确定性校对（错别字/叠字/引号配对）',
    prScan.items.some((i) => i.issue.includes('账号')) &&
      prScan.items.some((i) => i.issue.includes('迫不及待')) &&
      prScan.items.some((i) => i.issue.includes('不配对')),
    JSON.stringify(prScan.items.map((i) => i.text)),
  );
  const prFile = path.join(root, 'proof.md');
  fs.writeFileSync(prFile, '请登录您的帐号，迫不急待地开始写作。他说：今天很忙“然后继续。\n');
  r = await run(['proofread', '--file', prFile]);
  check(
    'proofread 校对报告（确定性 + LLM 合并）',
    r.code === 0 && r.out.includes('校对') && r.out.includes('错别字'),
    r.out.slice(0, 120),
  );

  // 8.8 P1 四项：一键改写矩阵 / 版本快照+回滚 / 全局风格档案 / 引文管理
  const draftBeforeTransform = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  r = await run(['transform', 'polish']);
  check(
    'transform polish 一键润色（分节改写）',
    r.code === 0 && r.out.includes('已润色') && r.out.includes('节'),
    r.out.slice(0, 120),
  );
  const draftAfterTransform = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  check('transform 后草稿已更新', draftAfterTransform !== draftBeforeTransform);
  r = await run(['transform', 'condense', '--target', '300']);
  check(
    'transform condense 缩写到目标字数',
    r.code === 0 && r.out.includes('已缩写'),
    r.out.slice(0, 120),
  );
  r = await run(['history']);
  check(
    'history 版本快照列表（write/restyle/transform 自动生成）',
    r.code === 0 && r.out.includes('版本快照') && r.out.includes('write'),
    r.out.slice(0, 120),
  );
  r = await run(['rollback', '1']);
  check(
    'rollback 回滚到最新快照并刷新哈希',
    r.code === 0 && r.out.includes('已回滚'),
    r.out.slice(0, 120),
  );
  const profileFile = path.join(root, 'style-bundle.json');
  r = await run(['profile', 'export', '--to', profileFile]);
  check(
    'profile export 导出全局风格档案 bundle',
    r.code === 0 && fs.existsSync(profileFile),
    r.out.slice(0, 100),
  );
  const ws6 = path.join(root, 'ws6');
  process.env.SCULPTOR_WORKSPACE = ws6;
  r = await run(['init'], {});
  check('profile 导入前 init', r.code === 0);
  r = await run(['profile', 'import', profileFile]);
  check(
    'profile import 导入合并（本地高置信不覆盖）',
    r.code === 0 && r.out.includes('已导入合并'),
    r.out.slice(0, 120),
  );
  const importedWrite = JSON.parse(
    fs.readFileSync(path.join(ws6, 'vault', 'write-style.json'), 'utf8'),
  );
  check(
    '导入后档案维度已合并',
    (importedWrite.dimensions?.temperature?.confidence || 0) > 0,
    JSON.stringify(importedWrite.dimensions?.temperature),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;
  const citeTextFile = path.join(root, 'cites.md');
  fs.writeFileSync(citeTextFile, '文中引用了《我与地坛》和《国史大纲》，值得进一步展开。\n');
  r = await run(['citations', '--file', citeTextFile]);
  check(
    'citations 提取《引文》清单',
    r.code === 0 && r.out.includes('我与地坛') && r.out.includes('国史大纲'),
    r.out.slice(0, 120),
  );
  const refsFile = path.join(root, 'refs.json');
  fs.writeFileSync(
    refsFile,
    JSON.stringify([
      {
        type: 'journal',
        authors: ['史铁生'],
        year: 1990,
        title: '我与地坛',
        journal: '上海文学',
        issue: 1,
        pages: '1-20',
      },
    ]),
  );
  const ws7 = path.join(root, 'ws7');
  process.env.SCULPTOR_WORKSPACE = ws7;
  r = await run(['init'], {});
  check('citations 前 init', r.code === 0);
  fs.writeFileSync(path.join(ws7, 'draft.md'), '正文内容，引用《我与地坛》。\n');
  r = await run(['citations', '--append', refsFile]);
  check(
    'citations --append 参考文献附录',
    r.code === 0 &&
      fs.readFileSync(path.join(ws7, 'draft.md'), 'utf8').includes('## 参考文献') &&
      fs.readFileSync(path.join(ws7, 'draft.md'), 'utf8').includes('我与地坛[J]'),
    r.out.slice(0, 120),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 8.9 联网 RAG + 内置原创性检查
  const ragQueries = buildSearchQueries('1987年《光明日报》刊登报道，三百多座红砖楼', {
    topic: '北大红楼',
  });
  check(
    'buildSearchQueries 生成高价值检索查询',
    ragQueries.some((q) => q.includes('1987')) && ragQueries.some((q) => q.includes('光明日报')),
    JSON.stringify(ragQueries),
  );
  const ragResults = [
    {
      query: '北大红楼 1987年 光明日报',
      results: [
        {
          title: '红楼往事',
          url: 'https://example.com/honglou',
          snippet: '1987年《光明日报》刊文介绍北大红楼的历史。',
          source: '示例来源',
        },
      ],
    },
  ];
  const ing = ingestSearchResults(workspace, ragResults);
  check(
    'rag 回灌缓存与素材',
    ing.ingested === 1 &&
      fs.existsSync(path.join(workspace, 'vault', 'rag-cache.json')) &&
      JSON.parse(fs.readFileSync(path.join(workspace, 'protocol', 'state.json'), 'utf8')).materials?.some(
        (m) => m.includes('红楼往事'),
      ),
    JSON.stringify(ing),
  );
  const ragCache = JSON.parse(
    fs.readFileSync(path.join(workspace, 'vault', 'rag-cache.json'), 'utf8'),
  );
  check(
    'rag 缓存含查询与命中',
    ragCache.entries?.[0]?.query?.includes('1987') &&
      ragCache.entries[0].results[0].snippet.includes('光明日报'),
  );
  r = await run(['rag', 'status']);
  check(
    'rag status 显示缓存与通路',
    r.code === 0 && r.out.includes('RAG 状态') && r.out.includes('缓存'),
    r.out.slice(0, 100),
  );
  const ragIngestFile = path.join(root, 'rag-results.json');
  fs.writeFileSync(ragIngestFile, JSON.stringify(ragResults));
  r = await run(['rag', 'ingest', ragIngestFile]);
  check(
    'rag ingest CLI 回灌',
    r.code === 0 && r.out.includes('已回灌'),
    r.out.slice(0, 100),
  );
  const oriText =
    '历史从不缺席，它只等一个人走进去。历史从不缺席，它只等一个人走进去。综上所述，我们应该共同努力。';
  const ori = originalityScan(oriText, workspace);
  check(
    'originality 内置查重（文内重复+模板句）',
    ori.selfDuplicates.length >= 1 && ori.templateHits.length >= 1,
    JSON.stringify({ s: ori.selfDuplicates, t: ori.templateHits }),
  );
  r = await run(['originality', '--file', citeTextFile]);
  check(
    'originality CLI 可手动查看',
    r.code === 0 && r.out.includes('risk'),
    r.out.slice(0, 100),
  );

  // 8.10 凭据发现：env/Codex 自动读取 + 脱敏 + 显式配置优先 + 工作区存取
  const envCand = discoverFromEnv({ OPENAI_API_KEY: 'sk-abcdef1234' });
  check(
    '凭据发现：env 候选',
    envCand.length === 1 &&
      envCand[0].source === 'env:OPENAI_API_KEY' &&
      envCand[0].protocol === 'openai',
    JSON.stringify(envCand.map((c) => c.source)),
  );
  check(
    '凭据脱敏：不泄露完整 key',
    redact('sk-abcdef1234') === '***1234' && !describeCandidate(envCand[0]).includes('sk-abcdef1234'),
  );
  const fakeHome = path.join(root, 'fakehome');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.codex', 'config.toml'),
    'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]\nname = "deepseek"\nbase_url = "https://api.deepseek.com/"\nwire_api = "responses"\nexperimental_bearer_token = "sk-xyz7890"\n',
  );
  const codexCand = discoverFromCodex({}, fakeHome);
  check(
    '凭据发现：Codex config 解析（active provider + model）',
    codexCand.length === 1 &&
      codexCand[0].source === 'codex-config:deepseek' &&
      codexCand[0].active === true &&
      codexCand[0].model === 'deepseek-v4-flash',
    JSON.stringify(codexCand.map((c) => c.source)),
  );
  check(
    'Codex 候选同样脱敏',
    !describeCandidate(codexCand[0]).includes('sk-xyz7890'),
  );
  const cfgExplicit = loadConfig({ SCULPTOR_LLM_API_KEY: 'sk-explicit', OPENAI_API_KEY: 'sk-env' });
  check('显式 SCULPTOR 配置优先于宿主发现', cfgExplicit.apiKey === 'sk-explicit');
  const cf = saveCredentials(ws6, {
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-saved',
    model: 'm',
    source: 'manual',
  });
  check(
    'saveCredentials 写入 0600 并可回读',
    fs.existsSync(cf) &&
      (fs.statSync(cf).mode & 0o777) === 0o600 &&
      loadWorkspaceCredentials(ws6)?.apiKey === 'sk-saved',
    cf,
  );
  clearCredentials(ws6);
  check('clearCredentials 清除工作区凭据', !fs.existsSync(cf));
  r = await run(['credentials']);
  check(
    'credentials CLI 列出凭据状态（脱敏）',
    r.code === 0 && r.out.includes('当前生效') && !r.out.includes('sk-explicit'),
    r.out.slice(0, 120),
  );

  // 8.11 装完即用：agent/interview/clarify 无需先 init
  const ws8 = path.join(root, 'ws8');
  process.env.SCULPTOR_WORKSPACE = ws8;
  r = await run(['agent', '--once']);
  check(
    'agent 自动初始化工作区并提问（无需先 init）',
    r.code === 0 && JSON.parse(r.out).kind === 'ask',
    r.out.slice(0, 120),
  );
  check(
    'agent 自动 init 生成 state',
    fs.existsSync(path.join(ws8, 'protocol', 'state.json')),
  );
  r = await run(['interview', '--once']);
  check(
    'interview 自动初始化并返回问题',
    r.code === 0 && Boolean(JSON.parse(r.out).question),
    r.out.slice(0, 100),
  );
  process.env.SCULPTOR_WORKSPACE = workspace;

  // 8.12 深度审阅 review（红队 + 校对 + 事实 + 原创 + 风格保真 + 读者交锋，--fix 一键修复）
  r = await run(['review']);
  check(
    'review 深度审阅聚合输出',
    r.out.includes('深度审阅') && r.out.includes('结论'),
    r.out.slice(0, 140),
  );
  const badFile = path.join(root, 'bad.md');
  fs.writeFileSync(
    badFile,
    '在当今社会，随着时代的发展，我们不难发现，总而言之这是一个最好的时代。',
  );
  r = await run(['review', '--file', badFile, '--fix']);
  check(
    'review --fix 修复外部文件 P0 并复检通过',
    r.code === 0 && r.out.includes('已自动修复') && r.out.includes('通过'),
    r.out.slice(0, 160),
  );

  // 9. panel / status / doctor
  r = await run(['panel', path.join(workspace, 'protocol', 'state.json')]);
  check('玻璃面板渲染', r.out.includes('玻璃面板'));
  r = await run(['status']);
  check('状态摘要', r.out.includes('Sculptor 工作区'));
  r = await run(['doctor', '--ping']);
  check('doctor + LLM 连通', r.code === 0 && r.out.includes('LLM 连通: ✓'), r.out.slice(0, 120));

  // 10. 冲突检查：工作区外零写入
  const stray = fs.readdirSync(work).filter((f) => f !== '.sculptor');
  check('工作区外无杂散文件', stray.length === 0, JSON.stringify(stray));

  // 10.5 深度定点修改：只改选中的那一处
  const mdFile = path.join(work, 'sample.md');
  fs.writeFileSync(mdFile, '历史从不缺席。那扇窗沉默地注视着一切。它只等一个人走进去。\n');
  r = await run([
    'point-edit',
    '那扇窗沉默地注视着一切。',
    '这句太文艺了，收一点，留白',
    '--dir',
    work,
  ]);
  check('定点修改成功', r.code === 0 && r.out.includes('已定点修改'), r.out.slice(0, 160));
  const mdAfter = fs.readFileSync(mdFile, 'utf8');
  check(
    '只改了目标区间',
    mdAfter === '历史从不缺席。那扇窗没有开口，却什么都知道。它只等一个人走进去。\n',
    mdAfter,
  );

  r = await run([
    'point-edit',
    '〔Sculptor 引用〕《它只等一个人走进去。》',
    '短一点',
    '--dir',
    work,
  ]);
  check('引用格式可解析', r.code === 0, r.out.slice(0, 120));
  r = await run([
    'point-edit',
    '〔Sculptor 引用〕《历史从不缺席。》\n修改指令：更口语一点',
    '--dir',
    work,
  ]);
  check('两行引用块单参数可解析', r.code === 0, r.out.slice(0, 120));

  const md2 = path.join(work, 'sample2.md');
  fs.writeFileSync(md2, '重复出现的句子就是它。这里再来一次：重复出现的句子就是它。\n');
  r = await run(['point-edit', '重复出现的句子就是它。', '改一下', '--dir', work]);
  check('歧义时拒绝并提示', r.code !== 0 && r.out.includes('2 个位置'), r.out.slice(0, 120));
  r = await run(['point-edit', '完全不存在的句子。', '改一下', '--dir', work]);
  check('找不到时给出明确错误', r.code !== 0 && r.out.includes('找不到'), r.out.slice(0, 120));

  const guardFile = path.join(work, 'guard.md');
  fs.writeFileSync(guardFile, '原文句子在这里。\n');
  const guardHit = { start: 0, end: 4, matched: '原文句子' };
  applyChangeIfUnchanged(guardFile, guardHit, '改后文字');
  check('守卫：原文未变时正常写入', fs.readFileSync(guardFile, 'utf8') === '改后文字在这里。\n');
  fs.writeFileSync(guardFile, '原文句子在这里。\n');
  fs.writeFileSync(guardFile, '外部 agent 抢先改过了。\n'); // 模拟并发修改
  let guardThrew = false;
  try {
    applyChangeIfUnchanged(guardFile, guardHit, '改后文字');
  } catch {
    guardThrew = true;
  }
  check(
    '守卫：外部改过后退让中止',
    guardThrew && fs.readFileSync(guardFile, 'utf8') === '外部 agent 抢先改过了。\n',
  );

  const edits = fs
    .readFileSync(path.join(workspace, 'vault', 'edits.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  check('修改已记录进风格档案', edits.length >= 2, `edits=${edits.length}`);

  // 11. MCP：initialize + tools/list + tools/call
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clarify_step', arguments: { workspace, lastInput: '我在想结尾要不要留白' } } })}\n`,
  ]);
  const outChunks = [];
  const output = new Writable({
    write(c, _e, cb) {
      outChunks.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input, output });
  const byId = Object.fromEntries(
    outChunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check('MCP initialize', byId[1]?.result?.serverInfo?.name === 'sculptor');
  check('MCP tools/list 37 个工具', byId[2]?.result?.tools?.length === 37);
  check('MCP status 调用', byId[3]?.result?.content?.[0]?.text?.includes('Sculptor 工作区'));
  check('MCP clarify_step 返回问题', byId[4]?.result?.content?.[0]?.text?.includes('question'));
  const mcpInput2 = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'interview_step', arguments: { workspace, lastInput: '我在想结尾要不要留白' } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'quote', arguments: { text: '一扇窗' } } })}\n`,
  ]);
  const mcpOut2 = [];
  const output2 = new Writable({
    write(c, _e, cb) {
      mcpOut2.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input: mcpInput2, output: output2 });
  const byId2 = Object.fromEntries(
    mcpOut2
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check('MCP interview_step 返回清单', byId2[5]?.result?.content?.[0]?.text?.includes('checklist'));
  check(
    'MCP quote 生成引用块',
    byId2[6]?.result?.content?.[0]?.text?.includes('〔Sculptor 引用〕'),
  );
  const mcpInput3 = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'style_memory', arguments: { workspace, topic: '北大红楼 历史' } } })}\n`,
  ]);
  const mcpOut3 = [];
  const output3 = new Writable({
    write(c, _e, cb) {
      mcpOut3.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input: mcpInput3, output: output3 });
  const byId3 = Object.fromEntries(
    mcpOut3
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check(
    'MCP style_memory 检索到作者旧稿',
    byId3[7]?.result?.content?.[0]?.text?.includes('破晓的号角'),
  );
  const mcpInput6 = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'style_eval', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'outline_review', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'reader_debate', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fact_check', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'style_adapter', arguments: { workspace, action: 'status' } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'proofread', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'transform', arguments: { workspace, preset: 'polish' } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'history', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'profile_export', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'citations', arguments: { workspace, action: 'extract' } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'rag_search', arguments: { workspace, text: '1987年《光明日报》北大红楼' } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'originality', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'review', arguments: { workspace, quick: true } } })}\n`,
  ]);
  const mcpOut6 = [];
  const output6 = new Writable({
    write(c, _e, cb) {
      mcpOut6.push(c.toString());
      cb();
    },
  });
  await runMcpServer({ input: mcpInput6, output: output6 });
  const byId6 = Object.fromEntries(
    mcpOut6
      .join('')
      .trim()
      .split('\n')
      .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
  );
  check(
    'MCP style_eval 返回保真度',
    byId6[10]?.result?.content?.[0]?.text?.includes('风格保真评估') &&
      byId6[10]?.result?.content?.[0]?.text?.includes('保真度'),
  );
  check(
    'MCP outline_review 返回评审报告',
    byId6[11]?.result?.content?.[0]?.text?.includes('大纲评审') &&
      byId6[11]?.result?.content?.[0]?.text?.includes('评分'),
  );
  check(
    'MCP reader_debate 返回交锋',
    byId6[12]?.result?.content?.[0]?.text?.includes('读者交锋'),
  );
  check(
    'MCP fact_check 返回分级',
    byId6[13]?.result?.content?.[0]?.text?.includes('事实核查'),
  );
  check(
    'MCP style_adapter 返回素材状态',
    byId6[14]?.result?.content?.[0]?.text?.includes('素材') &&
      byId6[14]?.result?.content?.[0]?.text?.includes('适配卡'),
  );
  check(
    'MCP proofread 返回校对报告',
    byId6[15]?.result?.content?.[0]?.text?.includes('校对'),
  );
  check(
    'MCP transform 按预设改写',
    byId6[16]?.result?.content?.[0]?.text?.includes('已改写'),
  );
  check(
    'MCP history 返回快照列表',
    byId6[17]?.result?.content?.[0]?.text?.includes('版本快照') ||
      byId6[17]?.result?.content?.[0]?.text?.includes('还没有版本快照'),
  );
  check(
    'MCP profile_export 导出档案',
    byId6[18]?.result?.content?.[0]?.text?.includes('风格档案已导出'),
  );
  check(
    'MCP citations 返回引文结果',
    byId6[19]?.result?.content?.[0]?.text?.includes('引文') ||
      byId6[19]?.result?.content?.[0]?.text?.includes('《'),
  );
  check(
    'MCP rag_search 排队宿主检索',
    byId6[20]?.result?.content?.[0]?.text?.includes('已排队') ||
      byId6[20]?.result?.content?.[0]?.text?.includes('直连检索'),
  );
  check(
    'MCP originality 返回原创性结果',
    byId6[21]?.result?.content?.[0]?.text?.includes('原创性检查'),
  );
  check(
    'MCP review 返回深度审阅',
    byId6[22]?.result?.content?.[0]?.text?.includes('深度审阅'),
  );

  // 12.5 四层复合风格向量：L1 连续向量 / L2 动态维度 / L3 困惑度签名 / L4 偏好对
  {
    const svmod = await import('../src/style-vector.js');
    const { ensureWorkspace } = await import('../src/workspace.js');
    const vecWs = path.join(root, 'ws-vector');
    fs.mkdirSync(vecWs, { recursive: true });
    ensureWorkspace(vecWs, { create: true });

    // L1 稀疏嵌入与余弦
    const a = svmod.embedSparse('桂花树下的祖母摇着蒲扇，讲起旧年的故事');
    const b = svmod.embedSparse('祖母在桂花树下摇蒲扇，说起很久以前的旧事');
    const c = svmod.embedSparse('宏观经济周期与货币政策工具的组合运用');
    check(
      'L1 余弦：同义文本得分高于无关文本',
      svmod.cosineSparse(a, b) > svmod.cosineSparse(a, c),
      `${svmod.cosineSparse(a, b).toFixed(3)} vs ${svmod.cosineSparse(a, c).toFixed(3)}`,
    );

    // L3 困惑度签名：人类文本 surprisal 高于 AI 腔
    const human = svmod.perplexityProxy(
      '那天傍晚我站在门口，忽然想起祖母摇蒲扇的样子，蒲扇的边缘已经磨得发亮，风从巷口吹过来。',
    );
    const aiish = svmod.perplexityProxy(
      '值得注意的是，随着时代的发展，我们不难发现，在当今社会中，这是一个值得关注的重要问题。',
    );
    check(
      'L3 困惑度签名：人类文本 surprisal 高于 AI 腔',
      human && aiish && human.surprisal > aiish.surprisal,
      `${human?.surprisal} vs ${aiish?.surprisal}`,
    );

    // L1+L2+L4 实时刷新
    await svmod.refreshStyleVector({}, vecWs, {
      text: '桂花树 桂花树 蒲扇 蒲扇 祖母 祖母 旧事 旧事',
      kind: 'clarify',
      evidence: '测试澄清',
    });
    await svmod.refreshStyleVector({}, vecWs, {
      text: '石阶 石阶 窗 窗 红砖 红砖 磨得发亮 磨得发亮',
      kind: 'write',
      evidence: '测试写作',
    });
    await svmod.refreshStyleVector({}, vecWs, {
      kind: 'edit',
      edit: { original: '像有人跟在后面', changed: '像旧朝宫人踏过回廊', intent: '更克制收敛' },
      evidence: '测试修改',
    });
    const svFile = path.join(vecWs, 'vault', 'style-vector.json');
    const sv = JSON.parse(fs.readFileSync(svFile, 'utf8'));
    check(
      'L1 EMA 连续向量已累积',
      sv.continuous.mode === 'sparse' && Object.keys(sv.continuous.sparse).length > 0,
    );
    check(
      'L2 动态素材维已衍生',
      Object.keys(sv.dynamic.material || {}).length >= 2 &&
        Object.keys(sv.dynamic.imagery || {}).length >= 0,
      `material=${Object.keys(sv.dynamic.material || {}).length}`,
    );
    check(
      'L2 偏好轴从修改意图归类',
      Object.keys(sv.dynamic.preference || {}).some((k) => k.includes('克制')),
      JSON.stringify(Object.keys(sv.dynamic.preference || {})),
    );
    check(
      'L3 困惑度签名已累计',
      sv.perplexity.samples >= 2 && typeof sv.perplexity.mean === 'number',
      `samples=${sv.perplexity.samples}`,
    );
    check(
      'L4 偏好对已记录',
      sv.preferencePairs.length === 1 && sv.preferencePairs[0].intent.includes('克制'),
    );
    const vs = svmod.vectorSummary(vecWs);
    check('向量摘要含动态维度', vs.topDims.length >= 1);

    // 混合检索注入：无旧稿也有实时向量维度
    const shot = buildStyleShot(vecWs, { topic: '桂花树' });
    check(
      '混合检索注入实时向量维度',
      shot && shot.vectorDims && shot.vectorDims.length >= 1,
      shot ? JSON.stringify(shot.vectorDims) : 'null',
    );

    // CLI 可查看
    const oldWs = process.env.SCULPTOR_WORKSPACE;
    process.env.SCULPTOR_WORKSPACE = vecWs;
    const vr = await run(['style-vector']);
    process.env.SCULPTOR_WORKSPACE = oldWs;
    check(
      'CLI style-vector 可运行',
      vr.code === 0 && (vr.out.includes('风格向量') || vr.out.includes('实时动态维度')),
      vr.out.slice(0, 80),
    );
  }

  // 12. 生态位探测：主动触发判断
  r = await run(['probe', '帮我写一篇关于北大红楼的演讲稿，要有我的风格']);
  const p1 = JSON.parse(r.out);
  check(
    '长文写作触发',
    p1.triggered === true && p1.entry === 'creative',
    JSON.stringify({ c: p1.confidence, e: p1.entry }),
  );
  r = await run(['probe', '把这句话改得更口语一点']);
  const p2 = JSON.parse(r.out);
  check('定点修改触发', p2.triggered === true && p2.entry === 'point-edit');
  r = await run(['probe', '帮我修一下这个函数的 bug，它报错了']);
  const p3 = JSON.parse(r.out);
  check(
    '编程任务不触发',
    p3.triggered === false,
    JSON.stringify({ c: p3.confidence, n: p3.negatives }),
  );
  r = await run(['probe', '帮我总结这段文章']);
  const p4 = JSON.parse(r.out);
  check('总结任务不触发', p4.triggered === false);

  // 13. 实时取数闭环：学术场景自动排队 → rag needs 可查 → 回灌进素材并标记完成
  {
    const dataWs = path.join(root, 'data-ws');
    const prevWs = process.env.SCULPTOR_WORKSPACE;
    fs.mkdirSync(dataWs, { recursive: true });
    process.env.SCULPTOR_WORKSPACE = dataWs;
    r = await run(['init']);
    check('数据工作区初始化', r.code === 0);
    r = await run(['clarify', '--once'], { input: '我想写一篇关于AI教育公平的学术论文' });
    const reqFile = path.join(dataWs, 'protocol', 'requests.jsonl');
    const reqLog = fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8') : '';
    check('学术澄清自动排队资料检索', reqLog.includes('clarify-data'), reqLog ? '有请求' : '无请求');
    r = await run(['rag', 'needs']);
    check(
      'CLI rag needs 显示待办',
      r.out.includes('待办资料检索') || r.out.includes('clarify-data'),
      r.out.slice(0, 60),
    );
    const resultsFile = path.join(root, 'data-results.json');
    fs.writeFileSync(
      resultsFile,
      JSON.stringify([
        {
          query: 'AI教育公平 文献',
          results: [
            { title: 'AI 教育的公平性研究', source: '教育学报', url: 'https://example.com/ai', snippet: '2025 年抽样调查…' },
          ],
        },
      ]),
    );
    r = await run(['rag', 'ingest', resultsFile]);
    check('CLI rag ingest 回灌成功', r.out.includes('已回灌'), r.out.slice(0, 60));
    const dataState = JSON.parse(
      fs.readFileSync(path.join(dataWs, 'protocol', 'state.json'), 'utf8'),
    );
    check(
      '回灌结果进入素材',
      (dataState.materials || []).some((m) => m.includes('AI 教育的公平性研究')),
    );
    const stillPending = fs
      .readFileSync(reqFile, 'utf8')
      .split('\n')
      .some((l) => l.includes('"status": "pending"'));
    check('回灌后待办标记完成', stillPending === false);
    process.env.SCULPTOR_WORKSPACE = prevWs;
  }

  // 14. 回灌后自动续写：交付态检测到【素材不足】节 + 回灌晚于写作 → 自动重写并重新审计
  {
    const rwWs = path.join(root, 'rewrite-ws');
    const prevWs = process.env.SCULPTOR_WORKSPACE;
    fs.mkdirSync(rwWs, { recursive: true });
    process.env.SCULPTOR_WORKSPACE = rwWs;
    r = await run(['init']);
    const draftText =
      '## 三、数据缺口\n\n本节需要真实数据支撑【素材不足：还需要 2025 年 AI 教育统计】\n';
    fs.writeFileSync(path.join(rwWs, 'draft.md'), draftText);
    const st = JSON.parse(
      fs.readFileSync(path.join(rwWs, 'protocol', 'state.json'), 'utf8'),
    );
    st.phase = 'deliver';
    st.director = { stage: 'deliver', writeIndex: 0, outlineRegens: 0, fixAttempts: 0, qualityFixAttempts: 0 };
    st.outline = {
      title: 'AI 教育公平研究',
      sections: [
        {
          heading: '三、数据缺口',
          function: '细节',
          thesis: '数据支撑论点',
          words: 300,
          keyPoints: ['数据'],
          materials: ['旧素材'],
        },
      ],
    };
    st.outlineConfirmed = true;
    st.confirmed = { topic: 'AI 教育公平', genre: '学术论文' };
    st.materials = ['[检索 AI教育公平 文献] AI 教育的公平性研究（教育学报）'];
    st.lastDraftHash = createHash('sha1').update(draftText).digest('hex').slice(0, 16);
    st.lastWriteAt = '2026-01-01T00:00:00.000Z';
    st.ragIngestedAt = '2026-08-09T00:00:00.000Z';
    fs.writeFileSync(
      path.join(rwWs, 'protocol', 'state.json'),
      JSON.stringify(st, null, 2) + '\n',
    );
    r = await run(['agent', '--once']);
    const step1 = JSON.parse(r.out);
    check(
      '回灌后自动进入缺口重写',
      step1.kind === 'working' && step1.phase === 'rewrite',
      r.out.slice(0, 90),
    );
    r = await run(['agent', '--once']);
    const step2 = JSON.parse(r.out);
    const draftAfter = fs.readFileSync(path.join(rwWs, 'draft.md'), 'utf8');
    check('缺口节已被重写（素材不足标注消失）', !draftAfter.includes('素材不足'));
    check(
      '重写后重新进入反 AI 审计',
      step2.kind === 'working' && step2.phase === 'redteam',
      r.out.slice(0, 60),
    );
    process.env.SCULPTOR_WORKSPACE = prevWs;
  }
} finally {
  delete globalThis.fetch;
  delete globalThis.fetchBodies;
}

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
