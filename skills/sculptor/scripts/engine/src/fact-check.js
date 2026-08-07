// 事实核查：把成稿里"数字/年代/百分比/引文/人名/机构"标出来，按可信度分三类——
//   material：来自用户素材，可放心；
//   common  ：常识性/文学化表述，低风险（建议瞄一眼）；
//   verify  ：高风险未证实断言，交付前必须核对。
// 先确定性扫描（零 LLM、永不缺席），再可选 LLM 复核分类（把文学化数字从 verify 里捞回来）。
// 记录落 vault/fact-check.jsonl；导演交付时用确定性扫描提示"N 处需核对"。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';

const PATTERNS = [
  { type: 'year', re: /\d{3,4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?/g },
  { type: 'year', re: /(?:[一二三四五六七八九十百千零]+)\s*年/g },
  { type: 'number', re: /[０-９\d]+(?:\s*(?:万|亿|%|％|人|个|座|篇|家|所|层|米|公里|千米|吨|元|美元|人次))?/g },
  { type: 'quote', re: /《[^》]{2,40}》/g },
  { type: 'quoted', re: /[“"][^”"]{3,60}[”"]/g },
  { type: 'person', re: /[一-龥]{2,4}(?:说|写道|指出|认为|说过|坦言|感慨)/g },
  { type: 'org', re: /[一-龥]{2,20}(?:公司|大学|研究院|研究所|中心|局|厅|部|委员会|学校|医院|政府|日报|杂志|社)/g },
];

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.type}:${it.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 确定性扫描：把数字/引文/人名/机构标出来（零 LLM）。 */
export function factScan(text, materials = []) {
  const t = String(text || '');
  const mat = String(materials.join('\n') || '');
  const items = [];
  for (const { type, re } of PATTERNS) {
    const re2 = new RegExp(re.source, 'g');
    let m;
    while ((m = re2.exec(t))) {
      const raw = m[0].trim();
      if (raw.length < 2) continue;
      const idx = m.index;
      const context = t.slice(Math.max(0, idx - 18), Math.min(t.length, idx + raw.length + 18)).replace(/\s+/g, '');
      const inMaterial = raw.length >= 3 && mat.includes(raw);
      items.push({
        type,
        text: raw,
        context,
        supported: inMaterial ? 'material' : type === 'quoted' ? 'common' : 'verify',
      });
    }
  }
  return { items: uniqueItems(items).slice(0, 60) };
}

const FACT_PROMPT = (ctx) => `你是 Sculptor 的事实核查员。下面是这篇文章里被机器标出的"事实候选"（数字/年代/引文/人名/机构）。请逐一判断可信度：

【用户素材（作者自己提供的，可信）】
${ctx.materials || '（无）'}

【候选清单】
${JSON.stringify(ctx.candidates, null, 1)}

分类规则：
- material：内容与用户素材一致或直接来自素材；
- common：文学化数字（如"一百年"）、常识性表述、修辞引用，不构成事实风险；
- verify：具体年代/数据/引文出处/人名归属无法确认的，交付前必须核对。
对每个 verify 项给一句 reason 说明要核什么。不要修改原文，只分类。

输出严格 JSON：
{"items":[{"text":"","type":"year|number|quote|person|org","supported":"material|common|verify","reason":""}],"summary":"一句话总结核查结果"}`;

async function llmReclassify(cfg, candidates, materials) {
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是事实核查员，输出严格 JSON。' },
      {
        role: 'user',
        content: FACT_PROMPT({ candidates: candidates.slice(0, 40), materials }),
      },
    ],
    { json: true, temperature: 0.15, maxTokens: 2200 },
  );
  const r = parseJsonContent(content, '事实核查');
  const items = Array.isArray(r.items)
    ? r.items
        .filter((x) => x && x.text)
        .map((x) => ({
          text: String(x.text),
          type: String(x.type || 'number'),
          supported: ['material', 'common', 'verify'].includes(x.supported)
            ? x.supported
            : 'verify',
          reason: String(x.reason || ''),
        }))
    : [];
  return { items, summary: String(r.summary || ''), mode: 'llm' };
}

/**
 * 事实核查主入口：确定性扫描 → 尝试 LLM 复核（失败用扫描结果兜底）。
 * @param file 指定要核查的 md；缺省读工作区 draft.md。
 */
export async function factCheck(cfg, wsDir, { file = null } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) {
    throw new Error(`找不到要核查的文稿: ${draftFile}（先 sculptor write，或 --file 指定）`);
  }
  const text = fs.readFileSync(draftFile, 'utf8');
  let state = {};
  try {
    state = ws.readState(workspace);
  } catch {}
  const materials = state.materials || [];
  const scan = factScan(text, materials);
  let report;
  if (scan.items.length && cfg.apiKey) {
    try {
      report = await llmReclassify(cfg, scan.items, materials);
    } catch {
      report = {
        items: scan.items,
        summary: `${scan.items.length} 处事实候选（确定性扫描，未经 LLM 复核）`,
        mode: 'fallback',
      };
    }
  } else {
    report = scan.items.length
      ? {
          items: scan.items,
          summary: `${scan.items.length} 处事实候选（确定性扫描；配置 SCULPTOR_LLM_API_KEY 后可用 LLM 复核分级）`,
          mode: 'fallback',
        }
      : { items: [], summary: '未发现需要核查的数字/年代/引文', mode: 'none' };
  }
  report.file = draftFile;
  report.ts = ws.nowIso();
  report.byType = {
    material: report.items.filter((i) => i.supported === 'material').length,
    common: report.items.filter((i) => i.supported === 'common').length,
    verify: report.items.filter((i) => i.supported === 'verify').length,
  };
  const logFile = path.join(workspace, 'vault', 'fact-check.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    JSON.stringify({
      ts: report.ts,
      file: report.file,
      mode: report.mode,
      byType: report.byType,
      items: report.items.map((i) => ({ text: i.text, type: i.type, supported: i.supported, reason: i.reason })),
    }) + '\n',
  );
  ws.logContext(
    workspace,
    'fact-check',
    `事实核查（${report.mode}）：material ${report.byType.material} / common ${report.byType.common} / verify ${report.byType.verify}`,
  );
  return report;
}

/** 人类可读的核查报告。 */
export function renderFactCheck(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 事实核查 · 交付前必看', line);
  out.push(
    `核查结果（${report.mode === 'llm' ? 'LLM 复核' : report.mode === 'fallback' ? '确定性扫描' : '未发现候选'}）: ` +
      `material ${report.byType.material} · common ${report.byType.common} · verify ${report.byType.verify}`,
  );
  if (report.summary) out.push(`总评: ${report.summary}`);
  const verify = report.items.filter((i) => i.supported === 'verify');
  if (verify.length) {
    out.push('必须核对的（verify）:');
    for (const v of verify.slice(0, 10))
      out.push(`  · [${v.type}] ${v.text}${v.reason ? ` — ${v.reason}` : ''}（上下文：${v.context}）`);
  }
  const common = report.items.filter((i) => i.supported === 'common');
  if (common.length) {
    out.push('低风险（common，建议瞄一眼）:');
    for (const c of common.slice(0, 6)) out.push(`  · ${c.text}`);
  }
  if (!report.items.length) out.push('这篇文章没有可核对的硬事实。');
  out.push(line);
  return out.join('\n');
}
