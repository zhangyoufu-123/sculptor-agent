// 宿主生命周期钩子：Codex / Claude Code / OpenCode 的会话事件（session/user/assistant/
// compact/stop）→ 观察日志 + 压缩守卫（刷新风格指纹）。
// 容错：工作区不存在、事件不认识、载荷非 JSON，都安全退出，绝不干扰宿主。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';

export function runHook(workspace, payloadArg) {
  const wsDir = path.resolve(workspace || '.');
  if (!fs.existsSync(wsDir)) {
    console.log('[hook] 工作区不存在，无操作');
    return { ok: true, event: 'none' };
  }
  let payload = payloadArg;
  if (!payload) {
    try {
      payload = fs.readFileSync(0, 'utf8').trim();
    } catch {
      payload = '';
    }
  }
  let data = {};
  try {
    data = payload ? JSON.parse(payload) : {};
  } catch {
    data = { raw: ws.truncate(payload, 300) };
  }
  const inner = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const ev =
    data.hook_event_name ||
    data.event ||
    data.event_type ||
    data.type ||
    inner.event ||
    inner.type ||
    'unknown';
  const evName = String(ev).toLowerCase();
  const contextFile = path.join(wsDir, 'protocol', 'context.jsonl');
  const entry = {
    ts: ws.nowIso(),
    event: evName,
    summary: ws.truncate(
      data.summary ||
        data.question ||
        data.message ||
        data.text ||
        inner.message ||
        inner.text ||
        '',
      800,
    ),
  };
  if (evName.includes('session') && evName.includes('start')) {
    ws.appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] session-start 已记录');
  } else if (evName.includes('user') && (evName.includes('prompt') || evName.includes('message'))) {
    entry.summary = ws.truncate(
      inner.message || inner.text || data.message || data.text || data.question || '',
      1200,
    );
    ws.appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] 用户消息已记录');
  } else if (evName.includes('assistant')) {
    entry.summary = ws.truncate(
      inner.message || inner.text || data.message || data.text || '',
      800,
    );
    ws.appendLine(contextFile, JSON.stringify(entry));
    console.log('[hook] AI 消息已记录');
  } else if (evName.includes('compact') || evName.includes('summarize')) {
    ws.appendLine(contextFile, JSON.stringify(entry));
    ws.refreshFingerprint(wsDir);
    console.log('[hook] 压缩前守卫已执行（风格指纹已刷新）');
  } else if (evName.includes('stop') || evName.includes('end')) {
    ws.appendLine(contextFile, JSON.stringify(entry));
    ws.refreshFingerprint(wsDir);
    console.log('[hook] 会话结束，风格指纹已刷新');
  } else {
    console.log(`[hook] 事件「${evName}」忽略（无操作）`);
  }
  return { ok: true, event: evName };
}
