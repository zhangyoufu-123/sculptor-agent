// v1.0 红队测试：新模块（文体计量/改迹变换/具体化拟改/调制器）在对抗、空、畸形输入下
// 不抛异常、不产出垃圾，走优雅降级。目标是"任何输入都不崩、都可解释兜底"。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const stylo = await import(path.join(HERE, '..', 'src', 'stylometry.js'));
const et = await import(path.join(HERE, '..', 'src', 'edit-transform.js'));
const conc = await import(path.join(HERE, '..', 'src', 'concretize.js'));
const mod = await import(path.join(HERE, '..', 'src', 'modulator.js'));
const pm = await import(path.join(HERE, '..', 'src', 'personal-model.js'));
const { audit } = await import(path.join(HERE, '..', 'src', 'redteam.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-redteam-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

const ADVERSARIAL = ['', ' ', '。', '……', '💥💥💥', 'a'.repeat(1000), '在当今在当今在当今', '\u0000\u0001\u0002'];

// 1) 文体计量：任何输入不抛、返回 0~1 或有限值
{
  for (const s of ADVERSARIAL) {
    const v = stylo.stylometricVector(s);
    assert(v && typeof v === 'object', '文体向量返回对象');
    const c = stylo.stylometricCosine(v, v);
    assert(Number.isFinite(c) && c >= 0 && c <= 1, `自余弦有限（${c}）`);
    const sm = stylo.surfaceMetrics(s);
    assert(Number.isFinite(sm.mean) && Number.isFinite(sm.short), '表层指标有限');
  }
  assert(stylo.surfaceMatch(null, '文本') === 0.5, '无 profile 中性 0.5');
  console.log('PASS 文体计量对抗输入');
}

// 2) 改迹变换：空 profile / 畸形编辑对 不抛、中性兜底
{
  assert(et.editFitScore(null, '文本') === 0.5, '空 profile 中性');
  assert(et.editFitScore({ ok: true, added: {}, deleted: {} }, '文本') === 0.5, '空增删中性');
  const r = et.applyAuthorEdits('正常文本。', null);
  assert(r.text === '正常文本。' && r.applied.length === 0, '空 profile 不改动');
  console.log('PASS 改迹变换对抗输入');
}

// 3) 具体化拟改：空对/空目标/LLM 失败 原样退回
{
  assert(conc.detectConcretizationPairs([]).length === 0, '空对检测为空');
  assert(conc.detectConcretizationPairs(null).length === 0, 'null 对检测为空');
  const bad = await conc.concretize({}, [], '目标', async () => {
    throw new Error('boom');
  });
  assert(bad.ok === false && bad.text === '目标', '失败原样退回');
  const short = await conc.concretize({}, [], '目标', async () => '');
  assert(short.ok === false && short.text === '目标', '过短退回');
  console.log('PASS 具体化拟改对抗输入');
}

// 4) 调制器：空 workspace 不抛、默认模式、可解释
{
  const m = mod.modulate(w, '在当今社会，因此我们应当充分发挥前所未有的积极作用。');
  assert(Number.isFinite(m.score), '空工作区评分有限');
  assert(m.mode === 'default' && m.trained === false, '空数据降级默认');
  assert(Array.isArray(m.contributions) && m.contributions.length === mod.FEATURES.length, '贡献分解完整');
  const st = mod.modulatorStatus(w);
  assert(st.pairs === 0 && st.trained === false, '状态报告无数据降级');
  console.log('PASS 调制器空工作区降级');
}

// 5) 个人模型：空/极小语料 ok:false，个人得分 0
{
  const m = pm.getPersonalModel(w);
  assert(m.ok === false, '空语料模型未训练');
  assert(pm.personalStyleScore(m, '任意文本') === 0, '无模型个人分 0');
  console.log('PASS 个人模型空语料降级');
}

// 6) 红队审计：空/极短输入 返回报告而非崩溃
{
  for (const s of ['', '只有一句话。', '在当今社会，随着科技的发展，因此综上所述。']) {
    const r = await audit(w, s, {});
    assert(r && typeof r === 'object', '审计返回报告对象');
  }
  console.log('PASS 红队审计空/极短输入');
}

console.log('\n✓ redteam.test.mjs 全部通过');
