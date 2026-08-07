// 全链路 e2e（进程内）：fetch stub + 模拟 LLM，跑通 init→clarify→outline→write→redteam→fix→dissect + MCP。
import { spawnSync } from 'node:child_process';
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
import { detectGenre } from '../src/genre.js';
import { loadPersonalSkill } from '../src/library.js';
import { loadStyleAdapter } from '../src/style-adapter.js';
import { factScan } from '../src/fact-check.js';
import { applyCorrectionFeedback } from '../src/style-pulse.js';
import { proofScan } from '../src/proofread.js';
import { formatReference } from '../src/citation.js';

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
    '让读者感到历史可以走进去',
    '老师和同学',
    '我在门口站了很久，想象百年前的脚步声',
    '纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚',
    '历史不是展品，而是可以站进去的现场',
    '现场感来自具体的人，而非抽象的时间',
    '每一个细节都是过去的证词',
    '先好奇，再触动，最后安宁',
    '停在"心安则上"',
    '史铁生在文中将地坛视为宿命的等待，于荒芜与辉煌的落日中体悟个体生命的流逝 [1.1]。他在生死边缘选择平静审视，将死亡视为必然降临的节日，以通透的智慧将苦难化为对美的沉思',
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
    Boolean(i0.question) && Array.isArray(i0.checklist) && i0.checklist.length === 9,
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
  check('MCP tools/list 26 个工具', byId[2]?.result?.tools?.length === 26);
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

  // 12. 生态位探测：主动触发判断
  r = await run(['probe', '帮我写一篇关于北大红楼的演讲稿，要有我的风格']);
  const p1 = JSON.parse(r.out);
  check(
    '长文写作触发',
    p1.triggered === true && p1.entry === 'clarify',
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
} finally {
  delete globalThis.fetch;
  delete globalThis.fetchBodies;
}

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
