// 人物风格肖像（Style Persona，v0.22）：侧写式风格捕捉。
// 数据源：个人知识库（读过/经历）+ 个人写作库（写过/蒸馏写法）+ 修改记录（改过）
//        + write/read 风格档案 + 四层复合风格向量。
// 产出：vault/persona.json（结构化）+ vault/persona.md（人类可读，用户可查询）。
// 侧写特征映射回风格向量（refreshStyleVector kind:'persona'），让向量从"累积知识"里长出来。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { listEntries } from './knowledge.js';
import { vectorSummary } from './style-vector.js';

const PERSONA_FILE = 'persona.json';

function personaFile(workspace) {
  return path.join(workspace, 'vault', PERSONA_FILE);
}

/** 个人写作库统计（读 index.json，不渲染）。 */
function libraryStats(workspace) {
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(workspace, 'vault', 'library', 'index.json'), 'utf8'),
    );
    return { pieces: Array.isArray(index.pieces) ? index.pieces : [], categories: Object.keys(index.distilled || {}) };
  } catch {
    return { pieces: [], categories: [] };
  }
}

export function readPersona(workspace) {
  try {
    return JSON.parse(fs.readFileSync(personaFile(workspace), 'utf8'));
  } catch {
    return null;
  }
}

/** 数据源汇总（确定性，给 LLM 归纳或兜底用）。 */
function evidenceText(workspace) {
  const parts = [];
  const kb = listEntries(workspace);
  if (kb.length) {
    parts.push(
      `【读过的/经历的（${kb.length} 条）】\n` +
        kb
          .slice(0, 12)
          .map((e) => `- ${e.title}（${e.type}${e.note ? `：${e.note.slice(0, 80)}` : ''}）`)
          .join('\n'),
    );
  }
  const lib = libraryStats(workspace);
  if (lib.pieces.length) {
    parts.push(
      `【写过的作品（${lib.pieces.length} 篇）】\n` +
        lib.pieces
          .slice(0, 10)
          .map((p) => `- ${p.title}（${p.category || '未分类'}${p.chars ? `，${p.chars} 字` : ''}）`)
          .join('\n'),
    );
  }
  const edits = [];
  try {
    edits = fs
      .readFileSync(path.join(workspace, 'vault', 'edits.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-30)
      .map((l) => {
        try {
          const o = JSON.parse(l);
          return `${o.original || o.from || ''} → ${o.changed || o.to || ''}${o.reason ? `（${o.reason}）` : ''}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {}
  if (edits.length) parts.push(`【修改记录（${edits.length} 条，含修改理由）】\n- ${edits.join('\n- ')}`);
  for (const [label, file] of [
    ['语言层', 'write-style.json'],
    ['结构层', 'read-style.json'],
  ]) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(workspace, 'vault', file), 'utf8'));
      const dims = obj.dimensions || obj.structure || {};
      const top = Object.entries(dims)
        .filter(([, d]) => d && (d.confidence || 0) >= 0.35)
        .map(([k, d]) => `${k}: ${d.value}（${(d.confidence * 100).toFixed(0)}%）`)
        .slice(0, 8);
      if (top.length) parts.push(`【${label}风格档案】\n${top.join('\n')}`);
    } catch {}
  }
  try {
    const vs = vectorSummary(workspace);
    if (vs && (vs.topDims || []).length) {
      parts.push(
        `【复合风格向量摘要】\n${vs.topDims
          .map((d) => `- ${d.label || d}（权重 ${d.weight || ''}）`)
          .join('\n')}`,
      );
    }
  } catch {}
  return parts.join('\n\n');
}

export const PERSONA_PROMPT = (ctx) => `你是文体学家。请基于这位作者的全部写作痕迹（读过什么、写过什么、改过什么、风格档案、风格向量），
给 TA 写一份"人物风格肖像"（侧写）。要求：具体、有例子，不做空泛评价；像长期观察 TA 写作的朋友那样准确。

${ctx.evidence || '（尚无足够素材：请如实说明样本不足，只给能推断的）'}

输出严格 JSON：
{"summary":"一句话风格总结","perspective":"叙述视角习惯（第几人称、亲历感还是旁观感，举例）","lexicon":"词汇偏好（常用词域、爱用的比喻域、口头禅类，举例）","syntax":"句式习惯（长短句、排比/反问/破折号等使用，举例）","emotion":"情感表达方式（直抒/克制/反讽/留白，举例）","values":"价值观倾向（关心什么、对什么敏感、立场习惯）","patterns":"惯用套路与盲区（反复出现的结构、易犯的毛病，诚实指出）","reference":"引用与素材习惯（爱用哪类书/典故/数据/场景）"}`;

/**
 * 生成人物风格肖像（LLM 归纳；失败/无密钥 → 确定性兜底，绝不阻塞）。
 */
export async function buildPersona(cfg, workspace) {
  const evidence = evidenceText(workspace);
  let persona = null;
  if (cfg?.apiKey) {
    try {
      const content = await chatWithRetry(
        cfg,
        [
          { role: 'system', content: '你是文体学家，只依据给出的证据做风格侧写，不虚构。' },
          { role: 'user', content: PERSONA_PROMPT({ evidence }) },
        ],
        { json: true, temperature: 0.5, maxTokens: 1400 },
      );
      persona = parseJsonContent(content, '侧写');
    } catch {
      persona = null;
    }
  }
  if (!persona || typeof persona !== 'object') {
    // 确定性兜底：从证据里拼一行概括，保证可查询、可注入
    const firstLine = evidence.split('\n')[0] || '';
    persona = {
      summary: `（样本不足，仅确定性汇总）${firstLine.slice(0, 80)}`,
      perspective: '',
      lexicon: '',
      syntax: '',
      emotion: '',
      values: '',
      patterns: '',
      reference: '',
      fallback: true,
    };
  }
  persona.updatedAt = ws.nowIso();
  const libStats = libraryStats(workspace);
  persona.evidence = {
    knowledge: listEntries(workspace).length,
    library: libStats.pieces.length,
    fallback: Boolean(persona.fallback),
  };
  fs.mkdirSync(path.join(workspace, 'vault'), { recursive: true });
  fs.writeFileSync(personaFile(workspace), JSON.stringify(persona, null, 2) + '\n', {
    mode: 0o600,
  });
  // 人类可读版（用户可查询）
  const md = [
    `# 人物风格肖像（${persona.updatedAt.slice(0, 10)}）`,
    '',
    persona.summary ? `> ${persona.summary}` : '',
    '',
    ...Object.entries({
      perspective: '叙述视角',
      lexicon: '词汇偏好',
      syntax: '句式习惯',
      emotion: '情感表达',
      values: '价值观倾向',
      patterns: '惯用套路与盲区',
      reference: '引用与素材习惯',
    })
      .filter(([, v]) => v)
      .map(([k, label]) => `## ${label}\n\n${persona[k]}`),
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'vault', 'persona.md'), md + '\n', { mode: 0o600 });
  ws.logContext(workspace, 'persona', `风格肖像已生成（${persona.fallback ? '确定性兜底' : 'LLM 侧写'}，素材 ${persona.evidence.knowledge} 知识 + ${persona.evidence.library} 作品）`);
  return persona;
}

/** 注入用的侧写摘要（限量）。 */
export function personaBrief(workspace, { limit = 2 } = {}) {
  const p = readPersona(workspace);
  if (!p) return '';
  const lines = [];
  if (p.summary) lines.push(`总评：${p.summary}`);
  for (const [k, label] of [
    ['perspective', '叙述视角'],
    ['lexicon', '词汇偏好'],
    ['syntax', '句式习惯'],
    ['emotion', '情感表达'],
    ['values', '价值观倾向'],
    ['patterns', '套路与盲区'],
    ['reference', '引用习惯'],
  ]) {
    if (p[k]) lines.push(`${label}：${p[k]}`);
  }
  return lines.slice(0, limit * 3).join('\n');
}

/** 侧写映射回风格向量（辅助：让向量从累积知识里长出来）。 */
export async function personaToVector(cfg, workspace) {
  const p = readPersona(workspace);
  if (!p) return { refreshed: false };
  const { refreshStyleVector } = await import('./style-vector.js');
  const text = [
    p.summary,
    p.lexicon,
    p.syntax,
    p.emotion,
    p.values,
    p.patterns,
    p.reference,
  ]
    .filter(Boolean)
    .join('\n');
  if (!text.trim()) return { refreshed: false };
  await refreshStyleVector(cfg, workspace, {
    text,
    kind: 'persona',
    evidence: '人物风格肖像（侧写）',
  });
  return { refreshed: true };
}

/** 侧写状态（供 status/CLI 查询）。 */
export function personaStatus(workspace) {
  const p = readPersona(workspace);
  if (!p) return { built: false };
  return {
    built: true,
    updatedAt: p.updatedAt,
    fallback: Boolean(p.fallback),
    knowledge: p.evidence?.knowledge || 0,
    library: p.evidence?.library || 0,
    file: path.join(workspace, 'vault', 'persona.md'),
  };
}
