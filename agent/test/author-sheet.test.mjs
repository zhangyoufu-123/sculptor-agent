// v0.66 作者写作清单（L3 深层风格读取）测试：
// 五问确定性兜底、LLM 结构化归纳、红线强制保留、调制器第 10 维 fineRead、签名缓存。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const asheet = await import(path.join(HERE, '..', 'src', 'author-sheet.js'));
const mod = await import(path.join(HERE, '..', 'src', 'modulator.js'));
const { contrastiveScore } = await import(path.join(HERE, '..', 'src', 'token-decode.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-sheet-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

function seedState() {
  ws.writeState(w, {
    theme: '历史不是展品，而是可以站进去的现场',
    stance: '让读者感到历史可以走进去',
    audience: '老师和同学',
    arguments: ['现场感来自具体的人，而非抽象的时间'],
    constraints: ['结尾那句"他最后笑了笑，没说话"一字不改'],
    seeds: [
      { text: '《我与地坛》', type: 'reference', confirmed: true },
      { text: '北大红楼窗口的积灰', type: 'material', confirmed: true },
    ],
    thinking: [{ claim: '历史不响，它只是等着', source: '《乡土中国》' }],
  });
}

// 1) 确定性兜底：五问齐全、红线/书名进入关键词、签名稳定
{
  seedState();
  const s = asheet.sheetFromState(w);
  assert(s.ok === true && s.mode === 'deterministic', '确定性归纳可用');
  assert(s.stance.includes('历史'), '主张立场入清单');
  assert(s.argumentation.some((a) => a.includes('现场感')), '论证推理入清单');
  assert(s.reader.includes('老师'), '读者意识入清单');
  assert(s.redLines.some((r) => r.includes('笑了笑')), '红线完整保留');
  assert(s.triggers.some((t) => t.includes('地坛')), '触发参照入清单');
  assert(s.keywords.some((k) => k.includes('地坛')), '《书名》进入关键词');
  assert(s.signature === asheet.stateSignature(ws.readState(w)), '签名可复算');
  console.log('PASS 确定性兜底（五问齐全/红线保留/关键词）');
}

// 2) LLM 结构化归纳：红线强制合并保留 + 模式标记
{
  const llm = async (msgs) => {
    const user = String(msgs[1]?.content || '');
    assert(user.includes('红线'), '提示词携带已确认信号');
    return JSON.stringify({
      stance: '历史可以走进去（LLM 润色）',
      argumentation: ['由具体的人进入历史现场'],
      reader: '学生与老师',
      redLines: [], // 故意漏掉红线 → 合并时必须保留
      triggers: ['《我与地坛》'],
      keywords: ['地坛', '积灰'],
      summary: '克制、留白、具体物象',
    });
  };
  const s = await asheet.extractAuthorSheet({}, w, { force: true, llm });
  assert(s.mode === 'llm+deterministic', `LLM 归纳模式（${s.mode}）`);
  assert(s.redLines.some((r) => r.includes('笑了笑')), 'LLM 漏掉的红线被强制保留');
  assert(s.stance.includes('LLM 润色'), 'LLM 立场生效');
  assert(fs.existsSync(asheet.sheetFile(w)), '清单落盘');
  console.log('PASS LLM 结构化归纳（红线强制合并/落盘）');
}

// 3) 缓存与签名重算：state 变化 → 签名变化 → 重算
{
  const llm = async () =>
    JSON.stringify({ stance: '保持', argumentation: [], reader: '', redLines: [], triggers: [], keywords: [], summary: '' });
  const s1 = await asheet.extractAuthorSheet({}, w, { llm });
  const state = ws.readState(w);
  state.constraints.push('"白卷是白卷"不改');
  ws.writeState(w, state);
  const s2 = await asheet.extractAuthorSheet({}, w, { llm });
  assert(s1.signature !== s2.signature, '红线新增 → 签名变化');
  assert(s2.redLines.length === 2, '重算后红线含新条目');
  console.log('PASS 签名缓存与重算（红线新增自动更新）');
}

// 4) 调制器第 10 维 fineRead：命中红线/关键词 → 高特征；无清单 → 中性
{
  const withHit = mod.fineReadFeature(w, '他最后笑了笑，没说话。白卷是白卷，迟到是迟到。');
  assert(withHit >= 0.5, `命中红线应拉高 fineRead（${withHit}）`);
  const withoutHit = mod.fineReadFeature(w, '在当今社会，随着科技的飞速发展。');
  assert(withoutHit < withHit, '未命中低于命中');
  const m = mod.modulate(w, '他最后笑了笑，没说话。', {});
  assert(m.features.fineread >= 0.25, `modulate 特征含 fineRead（${m.features.fineread}，单条红线命中 0.25）`);
  const empty = path.join(tmp, 'empty');
  ws.ensureWorkspace(empty, { create: true });
  assert(mod.fineReadFeature(empty, '任意文本') === 0.5, '无清单 → 中性 0.5');
  const cs = contrastiveScore(null, w, '他最后笑了笑，没说话。', {});
  assert(typeof cs.fineread === 'number', '得分分解含 fineread');
  console.log('PASS 调制器第 10 维（fineRead 命中/中性降级/得分分解）');
}

console.log('\n✓ author-sheet.test.mjs 全部通过');
