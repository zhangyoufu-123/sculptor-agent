/**
 * Sculptor Engine MCP Server
 * ====================================================================
 * 把原引擎（SculptorOrchestrator 完整状态机 + 风格向量 + 红队 + 读者模拟）
 * 以标准 MCP stdio 暴露给 Codex / Claude Code / OpenCode。
 *
 * 核心工具 `input` 就是引擎的 processInput：澄清、大纲、写作全由引擎驱动，
 * 宿主只负责把用户的话传进来、把回复带回去——承上启下。
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

import { SculptorOrchestrator } from '@/engine/orchestrator';
import { extractStyle } from '@/runtime/style/style-extractor';
import { captureEdit } from '@/runtime/style/edit-capture';
import { findBlacklistedPhrases, detectRepeatedFrames, frameSeverity } from '@/runtime/style/anti-ai';
import { checkFormatDiversity } from '@/runtime/style/format-diversity';
import { detectAverageness, critiqueStyle } from '@/runtime/style/style-critic';
import { createStyleFingerprint } from '@/runtime/style/style-fingerprint';
import { generateReaderProfiles, simulateReading } from '@/algorithms/reader-simulator';
import type { StructureSection, PCSState } from '@/pcs/types';
import type { StyleFingerprint } from '@/runtime/style/style-fingerprint';
import type { StyleProfile } from '@/prompts/discovery/style-extraction.prompt';
import * as W from './workspace';

const sessions = new Map<string, SculptorOrchestrator>();

const TOOLS = [
  { name: 'init', description: '初始化引擎会话（idea 为主题；已有快照则恢复）', inputSchema: { type: 'object', properties: { idea: { type: 'string' }, projectId: { type: 'string' }, workspace: { type: 'string' } } } },
  { name: 'input', description: '核心：把用户消息喂给引擎（澄清/大纲/写作全由引擎驱动），返回回复', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, text: { type: 'string' }, workspace: { type: 'string' } }, required: ['projectId', 'text'] } },
  { name: 'state', description: '玻璃面板：当前进度白话视图', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, workspace: { type: 'string' } }, required: ['projectId'] } },
  { name: 'draft', description: '导出大纲已写正文（draft 文本）', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, workspace: { type: 'string' } }, required: ['projectId'] } },
  { name: 'projects', description: '列出工作区里的引擎项目', inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } } },
  { name: 'style_extract', description: '四遍管线风格提取（计算特征→LLM 14维→锚定→向量播种）', inputSchema: { type: 'object', properties: { sample: { type: 'string' }, projectId: { type: 'string' }, workspace: { type: 'string' } }, required: ['sample'] } },
  { name: 'redteam', description: '反 AI 审计：黑名单/重复句式/格式多样性/平均化检测', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'absorb_edit', description: '吸收一次人工修改进风格信号', inputSchema: { type: 'object', properties: { original: { type: 'string' }, edited: { type: 'string' }, workspace: { type: 'string' } }, required: ['original', 'edited'] } },
  { name: 'fingerprint', description: '刷新压缩守卫风格指纹', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, workspace: { type: 'string' } } } },
  { name: 'dissect', description: '感性解剖：读者模拟 + 风格批判 + 格式/黑名单', inputSchema: { type: 'object', properties: { text: { type: 'string' }, projectId: { type: 'string' }, workspace: { type: 'string' } }, required: ['text'] } },
];

function getSession(ws: string, projectId: string, idea = ''): SculptorOrchestrator {
  const cached = sessions.get(projectId);
  if (cached) return cached;
  const snapshot = W.loadSnapshot(ws, projectId);
  const orch = snapshot
    ? new SculptorOrchestrator(idea || '', { initialPCS: snapshot })
    : new SculptorOrchestrator(idea);
  sessions.set(projectId, orch);
  return orch;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const ws = W.resolveWorkspace(typeof args.workspace === 'string' ? args.workspace : undefined);
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  switch (name) {
    case 'init': {
      const id = projectId || `proj-${Date.now().toString(36)}`;
      const orch = getSession(ws, id, str(args.idea));
      const state = orch.getState();
      W.writeProtocolState(ws, id, state);
      W.saveSnapshot(ws, id, orch.toPCS({ projectId: id }));
      return W.stateToPanel(state, id);
    }
    case 'input': {
      if (!projectId) return '缺少 projectId';
      const orch = getSession(ws, projectId);
      const reply = await orch.processInput(str(args.text));
      W.writeProtocolState(ws, projectId, orch.getState());
      W.saveSnapshot(ws, projectId, orch.toPCS({ projectId }));
      return reply;
    }
    case 'state': {
      if (!projectId) return '缺少 projectId';
      return W.stateToPanel(getSession(ws, projectId).getState(), projectId);
    }
    case 'draft': {
      if (!projectId) return '缺少 projectId';
      const outline = getSession(ws, projectId).getState().outline;
      const text = outline.map((s) => `## ${s.title}\n\n${s.content || ''}`).join('\n\n');
      return text.trim() || '（大纲已生成但正文尚未写作）';
    }
    case 'projects':
      return JSON.stringify(W.listProjects(ws));
    case 'style_extract': {
      const result = await extractStyle(str(args.sample));
      if (!result.success) return `风格提取失败: ${result.error || '未知错误'}`;
      if (projectId) {
        const state = getSession(ws, projectId).getState();
        state.styleProfile = result.profile;
        state.extractionResult = result;
        state.styleSample = str(args.sample);
      }
      W.writeStyleVault(ws, result.profile);
      W.refreshFingerprint(ws, result.profile);
      const high = result.profile
        ? Object.entries(result.profile.dimensions)
            .filter(([, d]) => (d as { score?: number }).score !== undefined && (d as { score?: number }).score! >= 0.6)
            .map(([k]) => k)
        : [];
      return JSON.stringify(
        {
          success: true,
          closestKnownStyle: result.profile?.closestKnownStyle,
          uniquenessFactor: result.profile?.uniquenessFactor,
          topTechniques: result.profile?.topTechniques.slice(0, 5),
          topImagery: result.profile?.topImagery.slice(0, 5),
          topWords: result.profile?.topWords.slice(0, 5),
          highConfidenceDimensions: high,
          userFeedback: result.userFeedback,
          vectorConfidence: result.vectorSnapshot.confidence,
        },
        null,
        2,
      );
    }
    case 'redteam': {
      const text = str(args.text);
      const frames = detectRepeatedFrames(text);
      const hardFrames = frames.filter((f) => frameSeverity(f.count, text.length) === 'hard');
      const format = checkFormatDiversity(text);
      const avg = detectAverageness(text);
      const blacklist = findBlacklistedPhrases(text);
      return JSON.stringify(
        {
          passed: blacklist.length === 0 && hardFrames.length === 0 && !avg.isGeneric,
          blacklist,
          repeatedFrames: frames.slice(0, 5),
          format: { score: format.score, suggestions: format.suggestions },
          averageness: avg,
        },
        null,
        2,
      );
    }
    case 'absorb_edit': {
      const r = captureEdit(str(args.original), str(args.edited));
      W.appendEdit(ws, { original: str(args.original), edited: str(args.edited) });
      return JSON.stringify(
        { signalsExtracted: r.signalsExtracted, changes: r.changes.slice(0, 10), hasEdits: r.hasEdits },
        null,
        2,
      );
    }
    case 'fingerprint': {
      const profile = projectId ? getSession(ws, projectId).getState().styleProfile ?? null : null;
      const fp = W.refreshFingerprint(ws, profile);
      return `指纹已刷新: confidence=${fp.confidence} 关联=${fp.associations}`;
    }
    case 'dissect': {
      const text = str(args.text);
      const sections: StructureSection[] = text
        .split(/\n\s*\n/)
        .map((p, i) => ({
          id: `s${i}`,
          order: i,
          title: `段落${i + 1}`,
          goal: '',
          function: 'elaborate' as const,
          hardness: 'soft' as const,
          draft_state: 'drafted' as const,
          content_draft: p.trim(),
          pcs_status: 'confirmed' as const,
          source: 'user' as const,
          confidence: 1,
        }))
        .filter((s) => s.content_draft.length > 0);
      const minimalPcs = {
        audience: {
          audience_type: { value: '普通读者' },
          knowledge_level: { value: '中等' },
          pain_points: { value: [] },
        },
      } as unknown as PCSState;
      const readers = generateReaderProfiles(minimalPcs).slice(0, 3);
      const sims = readers.map((r) => simulateReading(sections, r));
      const avg = detectAverageness(text);
      const format = checkFormatDiversity(text);
      const profile = projectId ? getSession(ws, projectId).getState().styleProfile ?? null : null;
      const critique = await critiqueStyle(text, fingerprintFromProfile(profile));
      return JSON.stringify(
        {
          readers: sims.map((s) => ({
            profile: s.reader_profile.name,
            reactions: s.reading_path.slice(0, 3),
            frictions: s.friction_points.slice(0, 5),
          })),
          averageness: avg,
          format: { score: format.score, suggestions: format.suggestions },
          critique: { overallScore: critique.overallScore, needsRewrite: critique.needsRewrite, suggestion: critique.averageness.suggestion },
        },
        null,
        2,
      );
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function fingerprintFromProfile(profile: StyleProfile | null): StyleFingerprint {
  const fp = createStyleFingerprint();
  if (profile) {
    fp.confidence = Math.min(1, 0.3 + (profile.topImagery.length + profile.topTechniques.length) * 0.05);
    fp.sampleCount = 1;
    fp.associations = profile.topImagery.slice(0, 5).map((to, i) => ({
      from: '文本',
      to,
      strength: Math.max(0.1, 0.9 - i * 0.2),
      category: 'imagery',
    }));
    fp.updatedAt = new Date().toISOString();
  }
  return fp;
}

export async function startMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const send = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };
  for await (const line of rl) {
    let msg: { jsonrpc: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sculptor-engine', version: '1.0.0' } } });
    } else if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
      // 通知无响应
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      try {
        const text = await callTool(msg.params?.name || '', msg.params?.arguments || {});
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `[sculptor-engine] ${err instanceof Error ? err.message : String(err)}` }], isError: true } });
      }
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知方法: ${msg.method}` } });
    }
  }
}
