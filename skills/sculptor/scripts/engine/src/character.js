// 人物模拟引擎（v0.21）：给小说/推理小说一个"会自己长出来"的角色层。
// 设计参考 MATE / DiriGent：角色 = 持久内部状态（背景/记忆/情绪）+ 理想-现实张力驱动行为。
// 用法：写作前先角色预演（simulateCharacter），把"他会怎么想/怎么说/怎么做"注入本节写作；
// 推理小说附带线索状态（clues/suspicion/redHerrings），让怀疑与误导在角色心里真实生长。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry } from './llm.js';
import * as ws from './workspace.js';

const CHAR_DIR = 'characters';

function charDir(workspace) {
  return path.join(workspace, 'vault', CHAR_DIR);
}

function charFile(workspace, name) {
  return path.join(charDir(workspace), `${String(name).replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.json`);
}

export function listCharacters(workspace) {
  try {
    return fs
      .readdirSync(charDir(workspace))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(charDir(workspace), f), 'utf8')));
  } catch {
    return [];
  }
}

export function loadCharacter(workspace, name) {
  try {
    return JSON.parse(fs.readFileSync(charFile(workspace, name), 'utf8'));
  } catch {
    return null;
  }
}

export function saveCharacter(workspace, profile) {
  const name = String(profile?.name || '').trim();
  if (!name) throw new Error('角色需要名字');
  const cur = loadCharacter(workspace, name) || {};
  const next = {
    ...cur,
    ...profile,
    name,
    updatedAt: ws.nowIso(),
    createdAt: cur.createdAt || ws.nowIso(),
    moodHistory: (cur.moodHistory || []).slice(-20),
  };
  fs.mkdirSync(charDir(workspace), { recursive: true });
  fs.writeFileSync(charFile(workspace, name), JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
  return next;
}

export function removeCharacter(workspace, name) {
  const f = charFile(workspace, name);
  if (!fs.existsSync(f)) throw new Error(`角色不存在: ${name}`);
  fs.rmSync(f);
  return { removed: name };
}

function profileText(p) {
  if (!p) return '（角色档案为空）';
  return [
    `名字：${p.name}`,
    p.age ? `年龄：${p.age}` : '',
    p.background ? `背景：${p.background}` : '',
    p.want ? `他/她最想要：${p.want}` : '',
    p.fear ? `他/她最怕：${p.fear}` : '',
    p.secret ? `秘密：${p.secret}` : '',
    p.speech ? `说话方式：${p.speech}` : '',
    p.mood ? `当前情绪：${p.mood}` : '',
    p.memory ? `最近记忆：${p.memory}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 确定性兜底（无 LLM）：基于档案的规则化行为预测。 */
function fallbackPredict(p, scene) {
  const want = p?.want || '内心的愿望';
  const fear = p?.fear || '最怕失去的东西';
  return `他会先护住「${want}」，因为那是他近来最在意的事；同时「${fear}」像一根刺，让他在这个场景里不敢把话说满。嘴上多半是${p?.speech || '克制、留有余地'}的样子，行动却会往「${want}」偏一步。`;
}

export const CHARACTER_PROMPT = (ctx) => `你是小说里的人物「${ctx.name}」，不是写作者的助手。请完全进入角色，用第一人称回答。

【你的档案】
${ctx.profile}

【此刻的场景】
${ctx.scene}

【你的愿望与现实之间的张力】
你最想要的是「${ctx.want}」，但现实里正发生的事（${ctx.obstacle}）挡住了它。你只能按自己的性格、记忆和恐惧去反应——不做对故事最方便的事，只做你会做的事。
${ctx.clues ? `【你注意到/怀疑的线索】\n${ctx.clues}` : ''}

严格输出 JSON：
{"thoughts":"此刻你心里真正想的两三句话（含真实情绪，不表演）","speech":"你此刻会真的说出口的话（口语、带你的说话方式，可沉默）","action":"你会做的一个具体动作（小动作优先，不夸张）","mood":"你现在的情绪状态（一个词到一句话）","nextPull":"这个场景把你往哪个方向推（下一步你想做什么）"}`;

/**
 * 角色预演：让 LLM 以角色第一人称预测情绪、言语与行为。
 * @param opts { name, scene, obstacle, clues } — clues 用于推理小说（线索/怀疑）
 * 返回 { ok, prediction, fallback }；无 LLM 时返回确定性兜底，流程不崩。
 */
export async function simulateCharacter(cfg, workspace, opts = {}) {
  const name = String(opts.name || '').trim();
  const profile = opts.profile || loadCharacter(workspace, name);
  if (!profile) return { ok: false, hint: `角色「${name || '（未命名）'}」还没有档案，先用 sculptor character add 创建。` };
  const scene = String(opts.scene || '').trim();
  if (!scene) return { ok: false, hint: '需要场景描述（scene）。' };
  const want = String(opts.want || profile.want || profile.background || 'ta 的愿望');
  const obstacle = String(opts.obstacle || opts.sceneObstacle || '出现了新的阻碍');
  const clues = Array.isArray(opts.clues)
    ? opts.clues.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : String(opts.clues || '');
  let prediction = null;
  let fallback = false;
  if (cfg.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          {
            role: 'system',
            content: '你是小说角色模拟器：让角色像真人一样反应，情绪真实、行动具体、不替作者圆场。',
          },
          {
            role: 'user',
            content: CHARACTER_PROMPT({
              name: profile.name || name,
              profile: profileText(profile),
              scene,
              want,
              obstacle,
              clues,
            }),
          },
        ],
        { json: true, temperature: 0.9, maxTokens: 800 },
      );
      prediction = JSON.parse(String(content).replace(/^```(json)?|```$/g, '').trim());
    } catch {
      prediction = null;
    }
  }
  if (!prediction || !prediction.action) {
    prediction = {
      thoughts: '',
      speech: '',
      action: fallbackPredict(profile, scene),
      mood: profile.mood || '复杂',
      nextPull: want,
    };
    fallback = true;
  }
  // 持久内部状态：情绪与记忆回写档案（供后续场景连续）
  const nextMood = prediction.mood || profile.mood || '';
  saveCharacter(workspace, {
    name: profile.name || name,
    mood: nextMood,
    memory: `场景「${scene.slice(0, 60)}」：${(prediction.thoughts || prediction.action || '').slice(0, 120)}`,
  });
  ws.logContext(workspace, 'character', `预演「${name}」@${scene.slice(0, 30)}（${fallback ? '确定性兜底' : 'LLM'}）`);
  return { ok: true, name: profile.name || name, prediction, fallback };
}
