/**
 * Sculptor Engine MCP — Workspace 适配层
 * ====================================================================
 * 把原引擎的内存态（SessionState / PCSState）映射到 .sculptor/ 协议：
 *   - pcs-<projectId>.json            引擎快照（toPCS 持久化，供恢复）
 *   - protocol/state.json             玻璃面板状态（白话进度）
 *   - vault/write-style.json          风格档案（14 维映射）
 *   - vault/style-fingerprint.json    压缩守卫指纹
 *   - vault/edits.jsonl               定点修改记录
 * 只写工作区目录，不碰宿主配置。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PCSState } from '@/pcs/types';
import type { SessionState } from '@/engine/orchestrator';
import type { StyleProfile } from '@/prompts/discovery/style-extraction.prompt';

export function resolveWorkspace(flag?: string): string {
  return path.resolve(flag || process.env.SCULPTOR_WORKSPACE || path.join(process.cwd(), '.sculptor'));
}

export function ensureWorkspace(ws: string): string {
  fs.mkdirSync(path.join(ws, 'protocol'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'vault', 'project-memory'), { recursive: true });
  return ws;
}

export function snapshotFile(ws: string, projectId: string): string {
  return path.join(ws, `pcs-${projectId}.json`);
}

export function listProjects(ws: string): string[] {
  if (!fs.existsSync(ws)) return [];
  return fs
    .readdirSync(ws)
    .filter((f) => f.startsWith('pcs-') && f.endsWith('.json'))
    .map((f) => f.slice(4, -5));
}

export function saveSnapshot(ws: string, projectId: string, pcs: PCSState): void {
  ensureWorkspace(ws);
  fs.writeFileSync(
    snapshotFile(ws, projectId),
    JSON.stringify({ projectId, savedAt: new Date().toISOString(), pcs }, null, 2) + '\n',
  );
}

export function loadSnapshot(ws: string, projectId: string): PCSState | null {
  const file = snapshotFile(ws, projectId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).pcs as PCSState;
  } catch {
    return null;
  }
}

/** 从可能被包成 {value} 的字段里取出可读字符串 */
function val(x: unknown): string {
  if (x === null || x === undefined) return '';
  if (typeof x === 'object') {
    const v = (x as { value?: unknown }).value;
    return typeof v === 'string' ? v : JSON.stringify(x);
  }
  return String(x);
}

const PHASE_LABEL: Record<string, string> = {
  discovery: '澄清中',
  outline: '大纲中',
  writing: '写作中',
  done: '交付中',
};

/** SessionState → 玻璃面板文本 */
export function stateToPanel(state: SessionState, projectId: string): string {
  const belief = state.belief;
  const materials = (state.memories || []).map((m) => m.content).filter(Boolean);
  const outlineInfo = state.outline.length
    ? state.outline.map((s, i) => `${i + 1}. ${s.title}（${s.goal}）`).join('\n')
    : '（尚无）';
  const line = '─'.repeat(46);
  const lines = [
    `\n${line}`,
    'Sculptor 玻璃面板（引擎版）',
    line,
    `项目: ${projectId}    阶段: ${PHASE_LABEL[state.phase] || state.phase}`,
    `主题: ${val(belief.topic) || '未确认'}`,
  ];
  const confirmed: Array<[string, string]> = [
    ['立场/目的', val(belief.intent)],
    ['读者', val(belief.audience)],
    ['语气', val(belief.tone)],
  ];
  for (const [k, v] of confirmed) if (v) lines.push(`已确认 · ${k}: ${v}`);
  if (state.styleDirection) lines.push(`风格方向: ${state.styleDirection}`);
  if (materials.length) {
    lines.push('素材:');
    for (const m of materials) lines.push(`  ✓ ${m.slice(0, 60)}`);
  }
  if (state.lastQuestion) lines.push(`当前问题: ${state.lastQuestion}`);
  lines.push(`大纲:\n${outlineInfo}`);
  lines.push(line);
  return lines.join('\n');
}

/** SessionState → protocol/state.json（与 skill 协议同构） */
export function writeProtocolState(ws: string, projectId: string, state: SessionState): void {
  ensureWorkspace(ws);
  const belief = state.belief;
  const protocol = {
    projectId,
    updatedAt: new Date().toISOString(),
    phase: state.phase,
    summary: state.lastQuestion ? `正在澄清：${state.lastQuestion}` : `阶段: ${state.phase}`,
    confirmed: {
      主题: val(belief.topic),
      立场: val(belief.intent),
      读者: val(belief.audience),
      语气: val(belief.tone),
    },
    materials: (state.memories || []).map((m) => m.content).filter(Boolean),
    pending: state.lastQuestion ? [state.lastQuestion] : [],
    nextStep: state.phase === 'discovery' ? '继续澄清' : state.phase === 'outline' ? '确认大纲后写作' : '写作/审计',
    vault: {
      writeStyle: 'vault/write-style.json',
      fingerprint: 'vault/style-fingerprint.json',
    },
  };
  fs.writeFileSync(path.join(ws, 'protocol', 'state.json'), JSON.stringify(protocol, null, 2) + '\n');
}

/** StyleProfile（引擎 4 遍管线产物）→ vault/write-style.json */
export function writeStyleVault(ws: string, profile: StyleProfile | null): void {
  ensureWorkspace(ws);
  if (!profile) return;
  const dims: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(profile.dimensions)) {
    const s = d as { score?: number; description?: string };
    dims[k] = {
      value: s.description || '',
      confidence: Number(Math.min(1, Math.max(0, s.score ?? 0)).toFixed(2)),
      evidence: [],
    };
  }
  const vault = {
    schemaVersion: '0.1',
    style: 'write',
    dimensions: dims,
    vector: {
      personalDataset: {
        topAssociations: profile.topImagery.slice(0, 10),
        topTechniques: profile.topTechniques.slice(0, 10),
        topVocabulary: profile.topWords.slice(0, 10),
      },
    },
    anchor: { closestKnownStyle: profile.closestKnownStyle, uniquenessFactor: profile.uniquenessFactor },
    learnedFrom: { samples: 1, edits: 0, choices: 0 },
    lastUpdated: new Date().toISOString(),
    notes: '来自引擎 extractStyle 四遍管线（计算特征→LLM 14维→锚定→向量播种）',
  };
  fs.writeFileSync(path.join(ws, 'vault', 'write-style.json'), JSON.stringify(vault, null, 2) + '\n');
}

/** 基于风格档案刷新压缩守卫指纹 */
export function refreshFingerprint(ws: string, profile: StyleProfile | null): { confidence: number; associations: number } {
  ensureWorkspace(ws);
  const fp = createFingerprintFromProfile(profile);
  fs.writeFileSync(path.join(ws, 'vault', 'style-fingerprint.json'), JSON.stringify(fp, null, 2) + '\n');
  return { confidence: fp.confidence, associations: fp.associations.length };
}

function createFingerprintFromProfile(profile: StyleProfile | null) {
  const associations = (profile?.topImagery || []).map((to, i) => ({
    from: '文本',
    to,
    strength: Number(Math.max(0.1, 0.9 - i * 0.2).toFixed(2)),
    category: 'imagery',
  }));
  const highConfidenceDimensions = profile
    ? Object.entries(profile.dimensions)
        .filter(([, d]) => (d as { score?: number }).score !== undefined && (d as { score?: number }).score! >= 0.6)
        .map(([name, d]) => ({ name, score: (d as { score?: number }).score, description: (d as { description?: string }).description }))
    : [];
  return {
    schemaVersion: '0.1',
    generatedAt: new Date().toISOString(),
    confidence: profile ? Number(Math.min(1, 0.3 + (profile.topImagery.length + profile.topTechniques.length) * 0.05).toFixed(2)) : 0,
    sampleCount: profile ? 1 : 0,
    associations,
    topTechniques: profile?.topTechniques || [],
    topWords: profile?.topWords || [],
    closestKnownStyle: profile?.closestKnownStyle || '',
    uniquenessFactor: profile?.uniquenessFactor ?? 0,
    highConfidenceDimensions,
  };
}

export function appendEdit(ws: string, edit: { original: string; edited: string; intent?: string }): void {
  ensureWorkspace(ws);
  const record = {
    ts: new Date().toISOString(),
    target: '',
    original: edit.original,
    changed: edit.edited,
    intent: edit.intent || '',
    evidence: 'MCP absorb_edit',
  };
  fs.appendFileSync(path.join(ws, 'vault', 'edits.jsonl'), JSON.stringify(record) + '\n');
}
