// v0.21 新能力单测：写作资产库 / 学术论证链 / 角色模拟 / 荐书联想（零依赖、离线）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import { assetBrief, recommendWorks, loadAssetLibrary, loadThoughtLibrary } from '../src/asset.js';
import {
  academicNarrative,
  argumentScan,
  academicGap,
  academicStyleNote,
} from '../src/academic.js';
import {
  saveCharacter,
  loadCharacter,
  listCharacters,
  removeCharacter,
  simulateCharacter,
} from '../src/character.js';
import { addEntry, recommendReadings, listEntries, normTitle } from '../src/knowledge.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sculptor-v21-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });

// ── 写作资产库 ──────────────────────────────────────────
const lib = loadAssetLibrary();
check('资产库已加载（诗词≥10 / 文法≥4 / 论证≥3）', lib.poetry.length >= 10 && lib.grammar.length >= 4 && lib.argument.length >= 3);
const thou = loadThoughtLibrary();
check('思想库已加载（≥20 本）', thou.works.length >= 20);

const ab = assetBrief('坚持 磨砺 教育 学习', { limit: 4 });
check('按主题命中诗词/文法/论证', ab.length >= 1 && ab.some((x) => x.includes('千淘万漉') || x.includes('活水') || x.includes('claim')));
const abEmpty = assetBrief('量子纠缠超导', { limit: 3 });
check('无关主题不硬塞', abEmpty.length === 0);

// ── 学术论证链 ──────────────────────────────────────────
const state = {
  confirmed: {
    genre: '学术论文',
    topic: 'AI 教育公平',
    theme: '算法训练数据偏差会放大既有教育不公平',
    arguments: ['数据偏差可量化', '需制度性纠偏'],
    gap: '现有研究多谈技术可行性，少谈公平审计',
  },
};
const arc = academicNarrative(state);
check('论证链含已知/缺口/洞见/方法', arc.includes('已知共识') && arc.includes('研究缺口') && arc.includes('洞见') && arc.includes('方法与证据'));
check('论证链用了已确认的缺口', arc.includes('公平审计'));
check('学术表达库非空', academicStyleNote().includes('限定词'));

let gap = academicGap(state);
check('缺方法 → 提示', gap.ok === false && gap.missing.some((m) => m.includes('method')));
gap = academicGap({ confirmed: { gap: 'x', theme: 'y', method: 'z' } });
check('论证链关键项齐 → 不提示', gap.ok === true);

const scan = argumentScan(
  '## 一、数据偏差\n本文认为算法数据偏差会放大不公平。2024 年某平台抽样显示差 23%。这说明偏差可量化。\n',
);
check('完备性扫描：证据/论证桥齐全 → ok', scan[0].ok === true, JSON.stringify(scan[0].issues));
const scan2 = argumentScan('## 二、讨论\n教育公平很重要，我们要重视。\n');
check('完备性扫描：缺证据/论证桥 → 列出缺口', scan2[0].ok === false && scan2[0].issues.length >= 2);

// ── 荐书联想 ────────────────────────────────────────────
const recs = recommendWorks({ confirmed: { topic: '关于苦难与生命的散文', theme: '把苦难放入时间与景物里看' } });
check('思想库匹配相近作品', recs.length >= 1, JSON.stringify(recs.map((r) => r.title)));

addEntry(wsDir, { title: '《我与地坛》', type: 'book', note: '读过' });
const recSuggest = recommendReadings(
  { confirmed: { topic: '苦难与生命' }, lastInput: '我想写一篇关于苦难的散文' },
  wsDir,
  { sessionAsked: false },
);
check('荐书联想：给出理论是什么+为什么可用', recSuggest.includes('核心是') && recSuggest.includes('用在这篇文章里'));
check('荐书联想：库里已有该书 → 不再推荐同本', !recSuggest.includes('《我与地坛》'));
const recAgain = recommendReadings(
  { confirmed: { topic: '苦难与生命' } },
  wsDir,
  { sessionAsked: true },
);
check('荐书只问一次（sessionAsked）', recAgain === '');

// ── 角色模拟（无 LLM → 确定性兜底）──────────────────────
const prof = saveCharacter(wsDir, {
  name: '林默',
  background: '县城中学转来的插班生，父亲早逝，靠母亲摆摊供读',
  want: '被人当普通同学对待，不想被同情',
  fear: '母亲在班里出现，暴露他的窘迫',
  secret: '他偷偷攒钱给母亲买过一双鞋',
  speech: '短句，很少主动开口，急了会结巴',
});
check('角色建档', prof.name === '林默' && listCharacters(wsDir).length === 1);

const sim = await simulateCharacter(
  { apiKey: '' },
  wsDir,
  {
    name: '林默',
    scene: '班会要求每人说说家庭，下一个轮到他',
    obstacle: '他不想撒谎，又绝不想让同学知道家里情况',
  },
);
check('角色预演：无 LLM 也有确定性预测', sim.ok === true && sim.fallback === true && sim.prediction.action.length > 0);
check('角色预演：预测贴合愿望与恐惧', sim.prediction.action.includes('想') || sim.prediction.action.includes('护'));
const prof2 = loadCharacter(wsDir, '林默');
check('角色预演后情绪回写档案（持久状态）', Boolean(prof2.mood) && Boolean(prof2.memory));

removeCharacter(wsDir, '林默');
check('角色移除', listCharacters(wsDir).length === 0);

// 知识库与荐书互链：确认推荐的书 → 收录
const beforeKb = listEntries(wsDir).length;
const r2 = recommendReadings(
  { confirmed: { topic: '理想社会与教育' }, lastInput: '想写教育公平' },
  wsDir,
  { sessionAsked: false },
);
const m = r2.match(/《([^》]{1,30})》/);
check('推荐里带书名', Boolean(m), r2.slice(0, 50));
if (m) {
  addEntry(wsDir, { title: `《${m[1]}》`, type: 'book', note: 'AI 推荐后确认读过', source: 'user-confirmed' });
}
check('推荐的书可一键收入知识库', listEntries(wsDir).length === beforeKb + 1);

console.log(`\n${failures === 0 ? '✓ v0.21 新能力测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
