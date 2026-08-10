// 文章圣经（Story/Article Bible，v0.23）：长文与系列文的"跨篇一致性文档"。
// 沉淀世界观、角色、时间线、伏笔、文风约定；续写/系列文时读取注入，保证不前后打架。
// 交付时自动沉淀（静默），失败确定性兜底；CLI：sculptor bible list|view|save。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { listCharacters } from './character.js';

const BIBLE_DIR = 'bible';

function bibleDir(workspace) {
  return path.join(workspace, 'vault', BIBLE_DIR);
}

export function biblePath(workspace, title) {
  const slug = String(title || '未命名')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .slice(0, 40);
  return path.join(bibleDir(workspace), `${slug}.json`);
}

export function listBibles(workspace) {
  try {
    return fs
      .readdirSync(bibleDir(workspace))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(bibleDir(workspace), f), 'utf8')));
  } catch {
    return [];
  }
}

export function readBible(workspace, title) {
  try {
    return JSON.parse(fs.readFileSync(biblePath(workspace, title), 'utf8'));
  } catch {
    return null;
  }
}

export function saveBible(workspace, bible) {
  const title = String(bible?.title || '').trim();
  if (!title) throw new Error('圣经需要标题');
  const cur = readBible(workspace, title) || {};
  const next = { ...cur, ...bible, title, updatedAt: ws.nowIso(), createdAt: cur.createdAt || ws.nowIso() };
  fs.mkdirSync(bibleDir(workspace), { recursive: true });
  fs.writeFileSync(biblePath(workspace, title), JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
  return next;
}

/** 注入用的圣经摘要（限量）。 */
export function bibleBrief(workspace, title, { limit = 3 } = {}) {
  const b = readBible(workspace, title);
  if (!b) return '';
  const lines = [];
  if (b.world) lines.push(`世界观：${b.world}`);
  if (b.styleNote) lines.push(`文风约定：${b.styleNote}`);
  if (b.timeline) lines.push(`时间线：${b.timeline}`);
  if (b.continuityNotes) lines.push(`连贯性注意：${b.continuityNotes}`);
  if (Array.isArray(b.characters) && b.characters.length) {
    lines.push(`角色：${b.characters.slice(0, 5).join('；')}`);
  }
  if (Array.isArray(b.foreshadowing) && b.foreshadowing.length) {
    lines.push(`伏笔：${b.foreshadowing.slice(0, 4).join('；')}`);
  }
  return lines.slice(0, limit * 2).join('\n');
}

export const BIBLE_PROMPT = (ctx) => `你是故事/文章的"圣经"整理者。基于以下素材，沉淀一份跨篇一致性的文档：
世界观（设定/背景/核心规则）、角色（名字/关系/状态）、时间线、伏笔/待回收的线、
文风约定（叙述视角/时态/称呼习惯/禁忌）、连贯性注意（哪些事不能前后矛盾）。
只写素材里有依据的；没有就空字符串，绝不虚构。

【大纲】
${ctx.outline}
【已确认信息】
${ctx.confirmed}
【角色档案】
${ctx.characters || '（无）'}
【成稿开头（文风样本）】
${ctx.draftHead || '（无）'}

输出严格 JSON：
{"world":"","characters":[""],"timeline":"","foreshadowing":[""],"styleNote":"","continuityNotes":""}`;

/**
 * 从大纲/确认信息/角色/成稿沉淀文章圣经（LLM；失败确定性汇总，绝不阻塞）。
 */
export async function distillBible(cfg, workspace, { title = '' } = {}) {
  const state = ws.readState(workspace);
  const t = String(title || state.outline?.title || state.confirmed?.topic || '').trim();
  if (!t) return { saved: false };
  const outline = (state.outline?.sections || [])
    .map((s) => `- ${s.heading}（${s.function}）${s.thesis ? `：${s.thesis}` : ''}`)
    .join('\n');
  const confirmed = Object.entries(state.confirmed || {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  const characters = listCharacters(workspace)
    .map((c) => `${c.name}（想要${c.want || '?'}，怕${c.fear || '?'}${c.mood ? `，情绪${c.mood}` : ''}）`)
    .join('；');
  let draftHead = '';
  try {
    draftHead = fs.readFileSync(path.join(workspace, 'draft.md'), 'utf8').slice(0, 500);
  } catch {}
  let bible = null;
  if (cfg?.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是文章圣经整理者，只依据素材、不虚构。' },
          { role: 'user', content: BIBLE_PROMPT({ outline, confirmed, characters, draftHead }) },
        ],
        { json: true, temperature: 0.3, maxTokens: 1000 },
      );
      bible = parseJsonContent(content, '圣经');
    } catch {
      bible = null;
    }
  }
  if (!bible || typeof bible !== 'object') {
    bible = {
      world: state.confirmed?.plot || '',
      characters: characters ? characters.split('；').slice(0, 6) : [],
      timeline: '',
      foreshadowing: (state.confirmed?.plot || '').includes('伏笔')
        ? [state.confirmed.plot]
        : [],
      styleNote: (state.confirmed?.genre || '') ? `文体：${state.confirmed.genre}` : '',
      continuityNotes: '续写前先读本文档，保持世界观/角色/时间线一致。',
      fallback: true,
    };
  }
  const saved = saveBible(workspace, { title: t, ...bible });
  ws.logContext(workspace, 'bible', `文章圣经已沉淀「${t}」（${bible.fallback ? '确定性' : 'LLM'}）`);
  return { saved: true, title: t, bible: saved };
}
