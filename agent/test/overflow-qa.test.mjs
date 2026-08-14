// v0.59 外溢优先 QA：用户主动给出的高价值信息（红线/参照系）→ 当轮入档、
// 落 overflow-log、短句确认后种子标记为已确认（LLM 不可用时走确定性兜底）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadConfig } = await import(path.join(HERE, '..', 'src', 'config.js'));
const ws = await import(path.join(HERE, '..', 'src', 'workspace.js'));
const { clarifyStep } = await import(path.join(HERE, '..', 'src', 'clarify.js'));

const cfg = { ...loadConfig(), apiKey: '' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-overflow-'));
const w = ws.ensureWorkspace(path.join(tmp, 'w'), { create: true });

// 1) 红线外溢：用户定死台词/约束 → 入 constraints + overflow-log（确定性兜底）
{
  await clarifyStep(cfg, w, {
    lastInput: '结尾那句"他叫我同学。我没有纠正他。"一字不改，必须保留',
  });
  const state = ws.readState(w);
  assert(
    (state.constraints || []).some((c) => c.includes('一字不改') || c.includes('必须保留')),
    '红线已记录',
  );
  const logFile = path.join(w, 'vault', 'overflow-log.jsonl');
  assert(fs.existsSync(logFile), 'overflow-log.jsonl 已落盘');
  const log = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert(log.some((r) => r.overflowType === 'constraint'), 'overflow-log 记录 constraint 类型');
  console.log('PASS 红线外溢 → constraints + overflow-log');
}

// 2) 参照系外溢：《书名》→ 种子入档
{
  await clarifyStep(cfg, w, { lastInput: '我最近看了加缪的《局外人》，很想顺着它的语气写' });
  const state = ws.readState(w);
  assert(
    (state.seeds || []).some((s) => s.text === '《局外人》'),
    '《书名》参照系已记录为种子',
  );
  console.log('PASS 参照系外溢 → 种子入档');
}

// 3) 短句确认 → 种子标记为已确认
{
  await clarifyStep(cfg, w, { lastInput: '对，就是那个' });
  const state = ws.readState(w);
  assert(
    (state.seeds || []).length > 0 && state.seeds.every((s) => s.confirmed),
    '短句确认后种子全部标记已确认',
  );
  console.log('PASS 短句确认 → 种子已确认');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ overflow-qa 全部通过');
