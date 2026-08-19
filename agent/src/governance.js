// 输入治理控制面（v1.4）：借鉴 InkOS 的输入控制面（chapter intent / author intent）思路，
// 但落到 Stylotrace 的主线——"从修改与对话持续学风格"之上，补上长期稳定的一层：
//   1) authorIntent：用户长期想成为的写作者 / 一直想写出的调子（跨任务稳定，随对话缓慢累积）；
//   2) currentFocus：近阶段（这一篇 / 这一阶段）要把注意力拉回哪（高频、随任务切换）。
//
// 两者持久化在 vault/governance.json，可手工编辑、可 CLI 查看/修改，并回灌到
// 导演决策与写作/修订/红队提示词——解决"意图只在澄清阶段采一次就散落在 state 里"的问题。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';

const GOVERNANCE_FILE = 'vault/governance.json';

export function defaultGovernance() {
  return {
    schemaVersion: '1.0',
    authorIntent: '', // 长期写作身份/目标（用户想成为怎样的写作者）
    currentFocus: '', // 近期聚焦（当前这篇/这一阶段要集中注意的方向）
    updatedAt: null,
    source: 'auto',
  };
}

export function readGovernance(workspace) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(workspace, GOVERNANCE_FILE), 'utf8'));
    return { ...defaultGovernance(), ...o };
  } catch {
    return defaultGovernance();
  }
}

export function writeGovernance(workspace, gov) {
  const next = { ...defaultGovernance(), ...gov, updatedAt: ws.nowIso() };
  ws.writeJson(path.join(workspace, GOVERNANCE_FILE), next);
  return next;
}

/** 只更新给出的字段（不覆盖未给出的），并可选标注来源。 */
export function updateGovernance(workspace, patch, { source = 'manual' } = {}) {
  const cur = readGovernance(workspace);
  const next = { ...cur, source };
  if (patch.authorIntent !== undefined) {
    next.authorIntent = String(patch.authorIntent || '').trim().slice(0, 400);
  }
  if (patch.currentFocus !== undefined) {
    next.currentFocus = String(patch.currentFocus || '').trim().slice(0, 400);
  }
  return writeGovernance(workspace, next);
}

/** 回灌用简述（都为空时返回空串，避免注入空块）。 */
export function governanceBrief(workspace) {
  const g = readGovernance(workspace);
  const lines = [];
  if (g.authorIntent) lines.push(`长期意图：${g.authorIntent}`);
  if (g.currentFocus) lines.push(`当前聚焦：${g.currentFocus}`);
  return lines.join('\n');
}

/**
 * 确定性抽取（保守、只认明确标记，避免臆测污染长期档案）：
 *   authorIntent ← "我的风格是…/我想成为…/一直想…/长期…"
 *   currentFocus ← "重点…/注意…/聚焦…/这一篇要…/这次想…"
 * 拿不准就返回 null，交给澄清期的 LLM 意图层与 CLI 手工编辑兜底。
 */
export function extractGovernanceSignals(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return null;
  const out = { authorIntent: '', currentFocus: '' };

  const long = t.match(
    /(?:我的风格(?:就是|是)|我想成为|我(?:一直|长期)想|长期(?:目标|要)|我希望(?:一直|长期))[^。！？；\n]{2,60}/,
  );
  if (long) out.authorIntent = long[0].replace(/^(我的风格就是|我的风格是|我想成为|我一直想|我长期想|长期目标|长期要|我希望一直|我希望长期)/, '').trim();

  const focus = t.match(
    /(?:这次|这一篇|先)?(?:重点|注意|聚焦)[^。！？；\n]{1,40}/,
  );
  if (focus) out.currentFocus = focus[0].trim();

  if (!out.authorIntent && !out.currentFocus) return null;
  return out;
}

/**
 * 从一轮输入温和更新治理面：只覆盖检测到的字段，不主动清空已有值；
 * currentFocus 允许覆盖（近期聚焦随任务切换），authorIntent 默认只补不冲（长期稳定）。
 */
export function maybeUpdateGovernanceFromInput(workspace, lastInput) {
  const sig = extractGovernanceSignals(lastInput);
  if (!sig) return null;
  const cur = readGovernance(workspace);
  const patch = {};
  if (sig.currentFocus) patch.currentFocus = sig.currentFocus;
  if (sig.authorIntent && !cur.authorIntent) patch.authorIntent = sig.authorIntent;
  if (!patch.currentFocus && !patch.authorIntent) return null;
  return updateGovernance(workspace, patch, { source: 'auto' });
}

/**
 * 澄清收尾时，把本轮理解到的核心诉求落为"当前聚焦"（近期随任务切换）。
 * authorIntent（长期）不从这里种子化——长期身份只来自用户明确自述或手工编辑，
 * 避免用单篇任务的需求误判"用户想成为谁"。
 */
export function seedGovernanceFromClarify(workspace, state) {
  const cur = readGovernance(workspace);
  if (cur.currentFocus) return cur;
  const i = state?.intent || {};
  const focus = String(i.coreNeed || i.summary || '').trim().slice(0, 400);
  if (!focus) return cur;
  return updateGovernance(workspace, { currentFocus: focus }, { source: 'clarify' });
}
