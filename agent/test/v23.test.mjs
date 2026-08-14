// v0.23 单测：文章圣经 / 复阅-修订 / 情绪曲线 / 知识库迁移 / 文体与预设扩展。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws from '../src/workspace.js';
import {
  saveBible,
  readBible,
  listBibles,
  distillBible,
  bibleBrief,
} from '../src/bible.js';
import { reviseScan, emotionCurve, renderEmotionCurve } from '../src/revise.js';
import { exportKnowledge, importKnowledge, listEntries, addEntry } from '../src/knowledge.js';
import { personaBrief } from '../src/persona.js';
import { PRESETS, TONES } from '../src/transform.js';
import { detectGenre, genreBlueprint } from '../src/genre.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-v23-'));
const wsDir = path.join(root, 'ws');
ws.ensureWorkspace(wsDir, { create: true });

// ── 文章圣经 ────────────────────────────────────────────
const st = JSON.parse(fs.readFileSync(path.join(wsDir, 'protocol', 'state.json'), 'utf8'));
st.outline = {
  title: '雾镇疑云',
  sections: [
    { heading: '一、雨夜', function: '铺垫', thesis: '小镇的雨藏着秘密', words: 400 },
    { heading: '二、旧宅', function: '转折', thesis: '真相在旧宅地下', words: 400 },
  ],
};
st.confirmed = { topic: '雾镇疑云', genre: '小说', plot: '欧亨利式：结尾反转，前文埋下钥匙伏笔' };
st.phase = 'write';
fs.writeFileSync(path.join(wsDir, 'protocol', 'state.json'), JSON.stringify(st, null, 2) + '\n');
fs.writeFileSync(path.join(wsDir, 'draft.md'), '## 一、雨夜\n雨把小镇洗得很干净，只有旧宅的灯还亮着。\n');

const bible = await distillBible({ apiKey: '' }, wsDir);
check('圣经沉淀（确定性）', bible.saved === true && bible.title === '雾镇疑云');
check('圣经含伏笔与文体', readBible(wsDir, '雾镇疑云').foreshadowing?.length >= 0 && readBible(wsDir, '雾镇疑云').styleNote?.includes('小说'));
check('圣经可查询', listBibles(wsDir).length === 1);
const bb = bibleBrief(wsDir, '雾镇疑云');
check('圣经可注入', bb.includes('世界观') || bb.includes('文风') || bb.includes('连贯'));
saveBible(wsDir, { title: '雾镇疑云', world: '封闭小镇，雨季永不结束', styleNote: '冷峻短句' });
check('圣经可手动更新', readBible(wsDir, '雾镇疑云').world.includes('雨季'));

// ── 复阅-修订（无密钥 → 跳过不阻塞）────────────────────
const rev = await reviseScan({ apiKey: '' }, wsDir);
check('复阅无密钥跳过不阻塞', rev.skipped === true && Array.isArray(rev.issues));

// ── 情绪曲线 ────────────────────────────────────────────
const curve = emotionCurve('## 一、雨夜\n雨声里她突然屏住呼吸，脚步声逼近。\n## 二、旧宅\n她笑了，窗外的光暖起来。\n');
check('情绪曲线分节输出', curve.length === 2);
check('张力/喜悦被识别', curve[0].dominant === '张力' && curve[1].dominant === '喜悦', JSON.stringify(curve.map((c) => c.dominant)));
check('情绪曲线可渲染', renderEmotionCurve(curve).includes('强度'));

// ── 知识库迁移 ──────────────────────────────────────────
addEntry(wsDir, { title: '《边城》', type: 'book', note: '湘西小城' });
const exp = exportKnowledge(wsDir, path.join(root, 'kb-export.json'));
check('知识库导出', exp.entries >= 1 && fs.existsSync(exp.file));
const ws2 = path.join(root, 'ws2');
ws.ensureWorkspace(ws2, { create: true });
const imp = importKnowledge(ws2, exp.file);
check('知识库导入合并', imp.added >= 1 && listEntries(ws2).some((e) => e.title.includes('边城')));
importKnowledge(ws2, exp.file);
check('重复导入按标题去重', listEntries(ws2).filter((e) => e.title.includes('边城')).length === 1);

// ── 风格侧写护栏（可突破提示）───────────────────────────
const pBrief = personaBrief(wsDir);
check('侧写注入带过拟合护栏', !pBrief || pBrief.includes('突破'));

// ── 文体与预设扩展 ──────────────────────────────────────
check('投标书识别', detectGenre('我要写一份投标书') === '投标书');
check('申报书识别', detectGenre('课题申报书') === '申报书');
const tb = genreBlueprint('投标书', { targetWords: 3000 });
check('投标书蓝图含事项/依据', tb.some((f) => f.key === 'items') || tb.some((f) => f.key === 'materials'));
check('transform 新增古文风预设', PRESETS.classical?.label === '古文风');
check('transform 新增脱敏预设', PRESETS.desensitize?.label === '脱敏改写');
check('TONES 未被破坏', TONES.includes('formal') && TONES.length >= 4);

console.log(`\n${failures === 0 ? '✓ v0.23 测试全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
