// 版本快照与回滚：每次写作/重写/红队修订/一键改写前，把当前 draft.md 存一份
// 到 vault/history/（内容与最新快照相同则跳过，最多保留 30 份）。
// 回滚是用户显式操作：先快照当前版本（rollback-before）再覆盖，绝不静默丢内容。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ws from './workspace.js';

const HISTORY_DIR = 'history';
const MAX_KEEP = 30;

function dirOf(workspace) {
  return path.join(workspace, 'vault', HISTORY_DIR);
}

function sanitize(reason) {
  return String(reason || 'snapshot').replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 30);
}

/** 写入一份快照；内容与最新快照相同则跳过（幂等）。 */
export function snapshot(workspace, reason = 'snapshot') {
  const draft = path.join(workspace, 'draft.md');
  if (!fs.existsSync(draft)) return null;
  const text = fs.readFileSync(draft, 'utf8');
  const dir = dirOf(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();
  if (files.length) {
    const last = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    if (last === text) return path.join(dir, files[0]); // 无变化，不重复存
  }
  const file = path.join(dir, `${Date.now()}-${sanitize(reason)}.md`);
  fs.writeFileSync(file, text);
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  while (all.length > MAX_KEEP) {
    fs.rmSync(path.join(dir, all.shift()), { force: true });
  }
  return file;
}

/** 快照列表（新→旧）：文件、时间、原因、字数、预览。 */
export function listHistory(workspace) {
  const dir = dirOf(workspace);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return files.map((f) => {
    const file = path.join(dir, f);
    const text = fs.readFileSync(file, 'utf8');
    const m = f.match(/^(\d+)-(.*)\.md$/);
    return {
      file,
      ts: m ? new Date(Number(m[1])).toISOString() : '',
      reason: m ? m[2] : f,
      chars: (text.match(/[\u4e00-\u9fff]/g) || []).length,
      preview: text.replace(/^#.*$/gm, '').trim().slice(0, 60),
    };
  });
}

/**
 * 回滚到第 index 份快照（1 = 最新）。回滚前先快照当前草稿，保证可恢复。
 * @returns 被回滚到的快照信息。
 */
export function rollback(workspace, { index = 1 } = {}) {
  const list = listHistory(workspace);
  if (!list.length) throw new Error('没有可回滚的快照（先运行 write/restyle/redteam --fix/transform 生成）');
  const target = list[Math.max(0, Math.min(list.length - 1, (Number(index) || 1) - 1))];
  snapshot(workspace, 'rollback-before');
  fs.copyFileSync(target.file, path.join(workspace, 'draft.md'));
  // 回滚即恢复为当前草稿：同步哈希，避免后续改写误判"外部修改"
  try {
    const state = ws.readState(workspace);
    const text = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8');
    state.lastDraftHash = createHash('sha1').update(text).digest('hex').slice(0, 16);
    ws.writeState(workspace, state);
  } catch {}
  ws.logContext(workspace, 'history', `回滚到 ${target.reason}（${target.ts}）`);
  return { ...target, rolledBack: true };
}
