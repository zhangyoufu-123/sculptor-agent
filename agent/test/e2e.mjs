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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-e2e-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
const workspace = path.join(root, 'ws');
process.env.SCULPTOR_WORKSPACE = workspace;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

// 离线 fetch stub：所有 LLM 调用走 mock
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const content = respond(body.messages);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
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
  let smoke = spawnSync(process.execPath, [new URL('../bin/sculptor.js', import.meta.url).pathname, '--help'], { encoding: 'utf8' });
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
  ];
  let last;
  r = await run(['clarify', '--once'], { input: '\n' });
  check('clarify 首轮返回问题', r.code === 0 && JSON.parse(r.out).question);
  for (const a of answers) {
    r = await run(['clarify', '--once'], { input: a + '\n' });
    check('clarify --once 正常', r.code === 0, r.out.slice(0, 100));
    last = JSON.parse(r.out);
  }
  check('澄清挖透立意与论点', Boolean(last.confirmed?.theme && last.confirmed?.arguments?.length >= 2), JSON.stringify({ c: last.confirmed, m: last.materials }));

  // 3. outline
  r = await run(['outline']);
  check('大纲 3 节', r.code === 0 && r.out.includes('3 节'), r.out.slice(0, 120));

  // 4. write（mock 正文偏短 → 触发扩写；扩写版干净）
  r = await run(['write']);
  check('写作完成 + 触发扩写', r.code === 0 && r.out.includes('已扩写') && r.out.includes('合计'), r.out.slice(0, 200));
  const draftText = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
  const cjkCount = (draftText.match(/[\u4e00-\u9fff]/g) || []).length;
  check(`字数达标（${cjkCount} ≥ 540）`, cjkCount >= 540, `总字数 ${cjkCount}`);

  // 4.5 退让协议：draft.md 被外部修改 → 不覆盖；--force 才重写
  fs.writeFileSync(path.join(workspace, 'draft.md'), '外部 agent 改过这一行\n');
  r = await run(['write']);
  check('外部修改时退让不覆盖', r.code !== 0 && r.out.includes('退让'), r.out.slice(0, 100));
  check('draft 未被覆盖', fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8') === '外部 agent 改过这一行\n');
  r = await run(['write', '--force']);
  check('--force 强制重写', r.code === 0, r.out.slice(0, 120));

  // 5. 确定性红队：直接审计植入文本，应抓到黑名单与重复比喻
  const planted = [
    '在当今社会，站在门口，我感到历史像旧朝宫人一样沉默。不是所有的门都通向过去。',
    '沿着走廊，脚步像旧朝宫人踏过回廊。近年来，人们总说历史很远。',
    '离开时回头，那栋楼像旧朝宫人一样站在原地。总而言之，历史从不缺席。',
  ].join('\n');
  const rep = audit(planted);
  check('红队抓到黑名单', rep.blacklistHits.length >= 3, JSON.stringify(rep.blacklistHits.map((h) => h.phrase)));
  check('红队抓到重复比喻', rep.repeatedMetaphors.length >= 1, JSON.stringify(rep.repeatedMetaphors.map((m) => m.vehicle)));
  check('红队判定未通过', rep.passed === false);

  // 6. redteam --fix 对污染稿修复 → 复检通过
  fs.writeFileSync(path.join(workspace, 'draft.md'), planted);
  r = await run(['redteam', '--fix']);
  check('LLM 修订成功', r.code === 0, r.out.slice(0, 120));
  const after = audit(fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8'));
  check('复检通过（黑名单 0 / 重复比喻 0）', after.passed === true, JSON.stringify({ blacklist: after.blacklistHits, metaphors: after.repeatedMetaphors }));

  // 7. dissect
  r = await run(['dissect']);
  const d = JSON.parse(r.out);
  check('感性解剖 5 维度完整', Boolean(d.stance && d.limits && d.perplexity && d.povs && d.suggestions?.length));

  // 8. absorb + fingerprint
  const editFile = path.join(root, 'edit.json');
  fs.writeFileSync(editFile, JSON.stringify({ target: '结尾句', original: '历史从不缺席', changed: '历史从不等候，只等人走进去', intent: '留白', writeDims: { endingPattern: { value: '留白收束', delta: 0.25 } } }));
  r = await run(['absorb', workspace, editFile]);
  check('定点修改吸收', r.code === 0 && r.out.includes('1 维'));
  r = await run(['fingerprint']);
  check('压缩指纹刷新', r.code === 0 && fs.existsSync(path.join(workspace, 'vault', 'style-fingerprint.json')));

  // 9. panel / status / doctor
  r = await run(['panel']);
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
  r = await run(['point-edit', '那扇窗沉默地注视着一切。', '这句太文艺了，收一点，留白', '--dir', work]);
  check('定点修改成功', r.code === 0 && r.out.includes('已定点修改'), r.out.slice(0, 160));
  const mdAfter = fs.readFileSync(mdFile, 'utf8');
  check('只改了目标区间', mdAfter === '历史从不缺席。那扇窗没有开口，却什么都知道。它只等一个人走进去。\n', mdAfter);

  r = await run(['point-edit', '〔Sculptor 引用〕《它只等一个人走进去。》', '短一点', '--dir', work]);
  check('引用格式可解析', r.code === 0, r.out.slice(0, 120));

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
  check('守卫：外部改过后退让中止', guardThrew && fs.readFileSync(guardFile, 'utf8') === '外部 agent 抢先改过了。\n');

  const edits = fs.readFileSync(path.join(workspace, 'vault', 'edits.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  check('修改已记录进风格档案', edits.length >= 2, `edits=${edits.length}`);

  // 11. MCP：initialize + tools/list + tools/call
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { workspace } } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clarify_step', arguments: { workspace, lastInput: '我在想结尾要不要留白' } } })}\n`,
  ]);
  const outChunks = [];
  const output = new Writable({ write(c, _e, cb) { outChunks.push(c.toString()); cb(); } });
  await runMcpServer({ input, output });
  const byId = Object.fromEntries(outChunks.join('').trim().split('\n').map((l) => [JSON.parse(l).id, JSON.parse(l)]));
  check('MCP initialize', byId[1]?.result?.serverInfo?.name === 'sculptor');
  check('MCP tools/list 13 个工具', byId[2]?.result?.tools?.length === 13);
  check('MCP status 调用', byId[3]?.result?.content?.[0]?.text?.includes('Sculptor 工作区'));
  check('MCP clarify_step 返回问题', byId[4]?.result?.content?.[0]?.text?.includes('question'));

  // 12. 生态位探测：主动触发判断
  r = await run(['probe', '帮我写一篇关于北大红楼的演讲稿，要有我的风格']);
  const p1 = JSON.parse(r.out);
  check('长文写作触发', p1.triggered === true && p1.entry === 'clarify', JSON.stringify({ c: p1.confidence, e: p1.entry }));
  r = await run(['probe', '把这句话改得更口语一点']);
  const p2 = JSON.parse(r.out);
  check('定点修改触发', p2.triggered === true && p2.entry === 'point-edit');
  r = await run(['probe', '帮我修一下这个函数的 bug，它报错了']);
  const p3 = JSON.parse(r.out);
  check('编程任务不触发', p3.triggered === false, JSON.stringify({ c: p3.confidence, n: p3.negatives }));
  r = await run(['probe', '帮我总结这段文章']);
  const p4 = JSON.parse(r.out);
  check('总结任务不触发', p4.triggered === false);
} finally {
  delete globalThis.fetch;
}

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
