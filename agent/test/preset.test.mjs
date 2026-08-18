// 内置名家风格预设单测:库加载、检索、渲染注入文本、restyle 命中注入。
// 运行: node test/preset.test.mjs
import assert from 'node:assert/strict';
import { loadPresets, listPresets, viewPreset, findPresetByPhrase, renderPreset } from '../src/preset.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// 1. 库加载
const presets = loadPresets();
assert.ok(presets.length >= 5, `至少 5 位名家,实际 ${presets.length}`);
const names = presets.map((p) => p.name);
assert.ok(names.includes('鲁迅') && names.includes('老舍') && names.includes('史铁生'), '包含鲁迅/老舍/史铁生');
ok(`库加载 ${presets.length} 位名家(鲁迅/老舍/朱自清/徐志摩/郁达夫/史铁生)`);

// 2. list
const list = listPresets();
assert.equal(list.length, presets.length);
assert.ok(list[0].id && list[0].tagline, 'list 含 id+tagline');
ok('listPresets 正常');

// 3. view
const luxun = viewPreset('luxun');
assert.equal(luxun.name, '鲁迅');
assert.ok(luxun.dims && luxun.anchors?.length && luxun.forbidden?.length, '风格卡含 维度+锚点+雷区');
ok('viewPreset 返回完整风格卡(维度/锚点/雷区)');

// 4. 短语检索(各种说法)
assert.equal(findPresetByPhrase('学鲁迅')?.id, 'luxun', '"学鲁迅"命中');
assert.equal(findPresetByPhrase('鲁迅的风格')?.id, 'luxun', '"鲁迅的风格"命中');
assert.equal(findPresetByPhrase('写成老舍的味儿')?.id, 'laoshe', '"写成老舍的味儿"命中');
assert.equal(findPresetByPhrase('像史铁生那样')?.id, 'shitiesheng', '"像史铁生那样"命中');
assert.equal(findPresetByPhrase('更克制一点'), null, '普通方向不误命中');
ok('短语检索:学鲁迅/鲁迅的风格/老舍的味儿/像史铁生那样 均命中,普通方向不误判');

// 5. 渲染注入文本
const r = renderPreset(luxun);
assert.ok(r.includes('风格预设：鲁迅'), '渲染含标题');
assert.ok(r.includes('锚点原句'), '渲染含锚点段');
assert.ok(r.includes('雷区'), '渲染含雷区段');
assert.ok(r.includes('其实地上本没有路'), '渲染含锚点原句');
ok('renderPreset 输出可注入提示词的风格卡(含锚点原句)');

console.log(`\npreset.test.mjs 全部通过 (${passed} 项)`);
