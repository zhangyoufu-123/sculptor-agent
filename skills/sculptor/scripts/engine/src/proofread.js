// 校对纠错：确定性中文检查（易混词/叠字/标点/引号配对）+ 可选 LLM 语法校对。
// 确定性检查零 LLM、毫秒级、永不缺席；LLM 只在配置密钥时跑（apiKey 守卫），
// 覆盖语病/搭配/逻辑等需要语义判断的问题。结果落 vault/proofread.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';

// 高置信易混词/成语（上下文无关，命中即提示）
const CONFUSION_RULES = [
  [/帐号/g, '账号'],
  [/登陆(了|过|系统|网站|账号|平台|页面)/g, '登录'],
  [/截止(目前|到现在|至今天|到[一二三四五六七八九十\d]+月)/g, '截至'],
  [/既使/g, '即使'],
  [/幅射/g, '辐射'],
  [/按排/g, '安排'],
  [/布署/g, '部署'],
  [/亲睐/g, '青睐'],
  [/针炙/g, '针灸'],
  [/渲泄/g, '宣泄'],
  [/再接再励/g, '再接再厉'],
  [/变本加利/g, '变本加厉'],
  [/一如继往/g, '一如既往'],
  [/谈笑风声/g, '谈笑风生'],
  [/迫不急待/g, '迫不及待'],
  [/走头无路/g, '走投无路'],
  [/甘败下风/g, '甘拜下风'],
  [/不径而走/g, '不胫而走'],
  [/以逸代劳/g, '以逸待劳'],
  [/世外桃园/g, '世外桃源'],
  [/饮鸠止渴/g, '饮鸩止渴'],
  [/严惩不待/g, '严惩不贷'],
  [/名符其实/g, '名副其实'],
  [/震憾/g, '震撼'],
  [/风彩/g, '风采'],
  [/气慨/g, '气概'],
  [/神彩/g, '神采'],
  [/姿式/g, '姿势'],
  [/做弊/g, '作弊'],
  [/震奋/g, '振奋'],
  [/萎糜不振/g, '萎靡不振'],
  [/闻名暇迩/g, '闻名遐迩'],
  [/川流不息.*络绎不绝/g, '注意：川流不息与络绎不绝语义重复'],
];

function scanConfusions(text) {
  const out = [];
  for (const [re, fix] of CONFUSION_RULES) {
    let m;
    while ((m = re.exec(text))) {
      out.push({
        text: m[0],
        issue: `疑为「${fix}」`,
        type: 'typo',
        suggestion: fix,
        severity: 'high',
        at: text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12),
      });
    }
  }
  return out;
}

function scanDuplicates(text) {
  const out = [];
  const re = /([\u4e00-\u9fff])\1/g;
  let m;
  while ((m = re.exec(text))) {
    const ch = m[1];
    if ('的了是在和也么呢吧啊呀哦'.includes(ch)) continue; // 语气/助词叠字多为误输入但难以判定，跳过
    out.push({
      text: m[0],
      issue: `疑似叠字/重复字符「${m[0]}」`,
      type: 'typo',
      suggestion: ch,
      severity: 'mid',
      at: text.slice(Math.max(0, m.index - 12), m.index + 12),
    });
  }
  return out;
}

function scanPunctuation(text) {
  const out = [];
  // 英文逗号/分号/冒号出现在中文之间
  const mixed = /[\u4e00-\u9fff][,;:][\u4e00-\u9fff]/g;
  let m;
  while ((m = mixed.exec(text))) {
    out.push({
      text: m[0],
      issue: `中文之间用了英文标点「${m[0][1]}」`,
      type: 'punctuation',
      suggestion: m[0][0] + (m[0][1] === ',' ? '，' : m[0][1] === ';' ? '；' : '：') + m[0][2],
      severity: 'mid',
      at: m[0],
    });
  }
  // 连续逗号/句号
  for (const [re, issue] of [
    [/[，,]{2,}/g, '连续逗号'],
    [/[。．.]{2,}/g, '连续句号'],
    [/[？！?!]{2,}/g, '连续感叹/问号'],
  ]) {
    let mm;
    while ((mm = re.exec(text))) {
      out.push({
        text: mm[0],
        issue,
        type: 'punctuation',
        suggestion: mm[0][0],
        severity: 'low',
        at: mm[0],
      });
    }
  }
  // 引号/书名号不配对
  for (const [open, close, name] of [
    ['“', '”', '中文双引号'],
    ['‘', '’', '中文单引号'],
    ['《', '》', '书名号'],
    ['（', '）', '括号'],
  ]) {
    const o = (text.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const c = (text.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (o !== c) {
      out.push({
        text: `${open}${close}`,
        issue: `${name}不配对（开 ${o} / 闭 ${c}）`,
        type: 'punctuation',
        suggestion: '',
        severity: 'mid',
        at: '',
      });
    }
  }
  // 省略号不规范
  if (/\.{3}/.test(text) || /…(?!…)/.test(text)) {
    out.push({
      text: '…',
      issue: '省略号请用「……」两个字符',
      type: 'punctuation',
      suggestion: '……',
      severity: 'low',
      at: '',
    });
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const key = `${i.type}:${i.text}:${i.issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 确定性校对扫描（零 LLM）。 */
export function proofScan(text) {
  const t = String(text || '');
  return {
    items: dedupe([...scanConfusions(t), ...scanDuplicates(t), ...scanPunctuation(t)]).slice(0, 60),
  };
}

const PROOF_PROMPT = (ctx) => `你是 Sculptor 的校对员。校对下面这段中文，只报确定的问题：

【文本】
${ctx.text}

检查：错别字、病句、搭配不当、语义重复、逻辑不通、标点错误。不确定的不要报。

输出严格 JSON：
{"items":[{"text":"原文片段","issue":"问题说明","type":"typo|grammar|punctuation|style","suggestion":"修改建议","severity":"high|mid|low"}],"summary":"一句话总评"}
items ≤ 10 条。`;

async function llmProof(cfg, text) {
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是中文校对员，输出严格 JSON。' },
      { role: 'user', content: PROOF_PROMPT({ text: text.slice(0, 6000) }) },
    ],
    { json: true, temperature: 0.15, maxTokens: 2000 },
  );
  const r = parseJsonContent(content, '校对');
  return {
    items: Array.isArray(r.items)
      ? r.items
          .filter((x) => x && x.text)
          .map((x) => ({
            text: String(x.text),
            issue: String(x.issue || ''),
            type: String(x.type || 'grammar'),
            suggestion: String(x.suggestion || ''),
            severity: String(x.severity || 'mid'),
            at: String(x.at || ''),
          }))
      : [],
    summary: String(r.summary || ''),
    mode: 'llm',
  };
}

/**
 * 校对主入口：确定性扫描 → LLM 语法校对合并（无密钥时只用确定性）。
 * @param file 指定要校对的 md；缺省读工作区 draft.md。
 */
export async function proofread(cfg, wsDir, { file = null } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = file ? path.resolve(file) : path.join(workspace, 'draft.md');
  if (!fs.existsSync(draftFile)) {
    throw new Error(`找不到要校对的文稿: ${draftFile}（先 sculptor write，或 --file 指定）`);
  }
  const text = fs.readFileSync(draftFile, 'utf8');
  const deter = proofScan(text);
  let report;
  if (cfg.apiKey && text.length >= 40) {
    try {
      const llm = await llmProof(cfg, text);
      report = {
        items: dedupe([...deter.items, ...llm.items]).slice(0, 60),
        summary: llm.summary,
        mode: 'llm',
      };
    } catch {
      report = {
        items: deter.items,
        summary: `${deter.items.length} 处提示（确定性扫描；LLM 校对失败已降级）`,
        mode: 'fallback',
      };
    }
  } else {
    report = {
      items: deter.items,
      summary: `${deter.items.length} 处提示（确定性扫描${cfg.apiKey ? '' : '；配置 SCULPTOR_LLM_API_KEY 可启用语义校对'}）`,
      mode: deter.items.length ? 'fallback' : 'none',
    };
  }
  report.file = draftFile;
  report.ts = ws.nowIso();
  report.byType = {
    typo: report.items.filter((i) => i.type === 'typo').length,
    grammar: report.items.filter((i) => i.type === 'grammar').length,
    punctuation: report.items.filter((i) => i.type === 'punctuation').length,
    style: report.items.filter((i) => i.type === 'style').length,
  };
  const logFile = path.join(workspace, 'vault', 'proofread.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    JSON.stringify({
      ts: report.ts,
      file: report.file,
      mode: report.mode,
      byType: report.byType,
      items: report.items.map((i) => ({ text: i.text, type: i.type, severity: i.severity, issue: i.issue })),
    }) + '\n',
  );
  ws.logContext(
    workspace,
    'proofread',
    `校对（${report.mode}）：错别字 ${report.byType.typo} / 语病 ${report.byType.grammar} / 标点 ${report.byType.punctuation} / 风格 ${report.byType.style}`,
  );
  return report;
}

/** 人类可读的校对报告。 */
export function renderProofread(report) {
  const out = [];
  const line = '─'.repeat(46);
  out.push(`\n${line}`, 'Sculptor 校对 · 交付前检查', line);
  out.push(
    `结果（${report.mode === 'llm' ? '确定性 + LLM' : '确定性扫描'}）: 错别字 ${report.byType.typo} · 语病 ${report.byType.grammar} · 标点 ${report.byType.punctuation} · 风格 ${report.byType.style}`,
  );
  if (report.summary) out.push(`总评: ${report.summary}`);
  if (report.items.length) {
    out.push('明细:');
    for (const i of report.items.slice(0, 12))
      out.push(
        `  · [${i.severity || 'mid'}/${i.type}] 「${i.text}」${i.issue ? ` — ${i.issue}` : ''}${i.suggestion ? ` → ${i.suggestion}` : ''}`,
      );
  } else {
    out.push('没有发现确定的问题。');
  }
  out.push(line);
  return out.join('\n');
}
