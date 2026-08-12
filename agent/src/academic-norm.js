// v0.55 学术规范审计：把"格式/语言专项评审"的标准做进 Sculptor 本体。
// 覆盖：中英标点混用、正式文体口语化、摘要超长、关键词不规范、
//       引用编号顺序（顺序编码制）、图表顺序引用、术语界定/操作性定义缺失。
// 原则：LLM 优先（主判断），确定性检查只做安全网/兜底；只报告不擅自改稿。
import fs from 'node:fs';
import path from 'node:path';
import { chatWithRetry, parseJsonContent } from './llm.js';
import * as ws from './workspace.js';
import { splitLongText } from './io.js';

const ABSTRACT_MAX = 320; // 摘要正文字数上限（不含关键词）
const FORMAL_GENRES = /学术论文|论文|报告|公文|新闻稿|调研|申报书|合同/;

// 高置信口语词（仅正式文体、仅安全网；引号内内容先剔除）
const COLLOQUIAL = [
  '收走', '接不住', '说白了', '压根', '拿捏', '绝了', '妥妥的',
  '整一个', '搞一下', '咱们', '呗', '嘎嘎', '贼好', '爱咋咋地', '整挺好',
];

export const NORM_PROMPT = (ctx) => `你是顶级学术期刊（ACL/EMNLP 级别）的格式与语言评审。审阅下面这篇${ctx.genre || '中文'}文本，只报确定的问题，不确定的不要报。

【文本】
${String(ctx.text || '').slice(0, 6000)}

【确定性检查命中的疑点（请复核，不确认的不报）】
${ctx.hits || '（无）'}

请按以下四类检查：
1. language：口语化表达、搭配不当、比喻性用词出现在正式语境、主谓衔接断裂；
2. terminology：生造术语首次出现未界定、自造指标无操作性定义；
3. format：中英文标点混用（半角括号紧贴中文、英文逗号后直接中文）、摘要超长、
   关键词不规范（非标准术语）、引用版本错误或来源不可靠（非学术来源未标注）；
4. structure：图表/公式编号顺序引用混乱、章节归属不当。

输出严格 JSON：
{"score":0-100,"issues":[{"type":"language|terminology|format|structure","severity":"high|mid|low","evidence":"原文片段","issue":"问题说明","suggestion":"修改建议"}],"summary":"一句话总评"}
issues ≤ 8 条，只报高置信问题。`;

// ── 确定性安全网（零 LLM）──────────────────────────────

/** 剔除引号/书名号内容，避免把作者引用的口语误判为作者表达。 */
export function stripQuoted(text) {
  return String(text || '')
    .replace(/「[^」]*」/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/‘[^’]*’/g, '')
    .replace(/《[^》]*》/g, '');
}

/** 剔除围栏代码块（伪代码/命令不是正文，不做语言与标点检查）。 */
export function stripCodeBlocks(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, '');
}

export function scanPunctMix(text) {
  // 参考文献区按 GB/T 7714 使用半角冒号（如"北京: 三联书店"），不参与正文标点检查。
  const t = stripCodeBlocks(String(text || '').split('## 参考文献')[0]);
  const out = [];
  const push = (evidence, issue, suggestion, severity = 'mid') => {
    out.push({ type: 'format', severity, evidence, issue, suggestion });
  };
  // 半角括号紧贴中文
  let m;
  const paren = /[\u4e00-\u9fff]\s*\(([^()]{0,48})\)\s*[\u4e00-\u9fff]/g;
  while ((m = paren.exec(t))) {
    push(m[0], `中文语境用了半角括号「${m[0]}」`, m[0].replace('(', '（').replace(')', '）'));
  }
  // 英文逗号/分号/冒号后直接跟中文
  const enp = /[,;:]\s*[\u4e00-\u9fff]/g;
  while ((m = enp.exec(t))) {
    const full = { ',': '，', ';': '；', ':': '：' }[m[0][0]];
    push(m[0], `英文标点「${m[0][0]}」后直接跟中文`, m[0].replace(m[0][0], full));
  }
  return out;
}

export function scanColloquial(text, genre = '') {
  if (!FORMAL_GENRES.test(String(genre || ''))) return [];
  const t = stripQuoted(stripCodeBlocks(String(text || '')));
  const out = [];
  for (const w of COLLOQUIAL) {
    let i = t.indexOf(w);
    if (i >= 0) {
      out.push({
        type: 'language',
        severity: 'mid',
        evidence: w,
        issue: `正式文体中的口语化表达「${w}」，建议替换为书面语`,
        suggestion: '替换为对应书面语（例：收走→提取；接不住→难以捕捉；说白了→换言之）',
        at: t.slice(Math.max(0, i - 10), i + 10 + w.length),
      });
    }
  }
  return out;
}

export function scanAbstractLength(text) {
  const t = String(text || '');
  const start = t.search(/摘要/);
  if (start < 0) return [];
  let end = t.length;
  const nextH = t.indexOf('\n#', start);
  if (nextH > 0) end = nextH;
  let seg = t.slice(start, end);
  const kw = seg.search(/关键词/);
  if (kw > 0) seg = seg.slice(0, kw);
  const n = (seg.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
  if (n > ABSTRACT_MAX) {
    return [{
      type: 'format',
      severity: 'high',
      evidence: `摘要约 ${n} 字`,
      issue: `摘要 ${n} 字，超过常见上限（200–300 字）`,
      suggestion: '压缩为：问题一句、方法一句、关键发现（一个数据点）、一句意义/结论',
    }];
  }
  return [];
}

export function scanCitationOrder(text) {
  // 顺序编码制只约束正文；参考文献区本身按编号排列，跳过。
  const t = String(text || '').split('## 参考文献')[0];
  const cites = [...t.matchAll(/\[(\d{1,2})\]/g)].map((mm) => ({ n: +mm[1], pos: mm.index }));
  const out = [];
  // 只校验"首次出现"顺序：同一编号的再次引用（如"参见 [7]"）允许出现在任何位置。
  const seen = new Set();
  let prevN = 0;
  for (const c of cites) {
    if (seen.has(c.n)) continue;
    seen.add(c.n);
    if (c.n < prevN) {
      out.push({
        type: 'format',
        severity: 'high',
        evidence: `[${prevN}] 之后首次出现 [${c.n}]`,
        issue: '引用编号顺序错误：顺序编码制应按正文首次出现顺序编号',
        suggestion: '重排参考文献编号，使 [n] 首次出现顺序严格递增',
        at: `…${t.slice(Math.max(0, c.pos - 14), c.pos + 12)}…`,
      });
      break;
    }
    prevN = c.n;
  }
  const nums = [...new Set(cites.map((c) => c.n))].sort((a, b) => a - b);
  for (let k = 1; k <= nums.length; k++) {
    if (!nums.includes(k)) {
      out.push({
        type: 'format',
        severity: 'high',
        evidence: `缺少 [${k}]`,
        issue: '引用编号不连续',
        suggestion: `补齐或合并编号 [${k}]`,
      });
      break;
    }
  }
  return out;
}

export function scanFigureTableOrder(text, kind = '图') {
  const t = String(text || '');
  const re = new RegExp(`${kind}\\s*(\\d{1,2})`, 'g');
  const seen = new Map();
  let m;
  const out = [];
  let prev = 0;
  while ((m = re.exec(t))) {
    const n = +m[1];
    if (seen.has(n)) continue;
    seen.set(n, m.index);
    if (n < prev) {
      out.push({
        type: 'structure',
        severity: 'mid',
        evidence: `${kind} ${prev} 之后首次出现 ${kind} ${n}`,
        issue: `${kind}编号顺序引用错误`,
        suggestion: `正文按 ${kind} 1→2→3… 的顺序引用，图表位置与首次引用保持一致`,
      });
      break;
    }
    prev = n;
  }
  return out;
}

export function scanKeywords(text) {
  const m = String(text || '').match(/关键词[^：\n]{0,6}[:：]\s*([^\n]+)/);
  const out = [];
  if (!m) {
    out.push({
      type: 'format', severity: 'low', evidence: '（无关键词行）',
      issue: '缺少关键词', suggestion: '给出 3–6 个领域通用术语作为关键词',
    });
    return out;
  }
  const kws = m[1].split(/[；;，,]/).map((s) => s.trim()).filter(Boolean);
  if (kws.length < 3 || kws.length > 8) {
    out.push({
      type: 'format', severity: 'mid', evidence: kws.join('；'),
      issue: `关键词 ${kws.length} 个，超出 3–6 个的常见范围`,
      suggestion: '精简到 3–6 个',
    });
  }
  const nonStd = kws.filter((k) => /Agent|AI 味|深协作|skill|CLI|MCP|模板|腔/.test(k));
  if (nonStd.length) {
    out.push({
      type: 'format', severity: 'low', evidence: nonStd.join('、'),
      issue: '关键词含非标准/领域外术语',
      suggestion: '优先使用领域通用术语（个性化文本生成、人机交互、检索增强生成等）',
    });
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const key = `${i.type}:${i.evidence}:${i.issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 确定性安全网（零 LLM）：质量门静默调用。 */
export function normScan(text, genre = '') {
  const t = String(text || '');
  return {
    items: dedupe([
      ...scanPunctMix(t),
      ...scanColloquial(t, genre),
      ...scanAbstractLength(t),
      ...scanCitationOrder(t),
      ...scanFigureTableOrder(t, '图'),
      ...scanFigureTableOrder(t, '表'),
      ...scanKeywords(t),
    ]).slice(0, 40),
  };
}

async function llmNormReview(cfg, text, deterministicHits, genre = '') {
  const content = await chatWithRetry(
    cfg,
    [
      { role: 'system', content: '你是学术规范评审员，输出严格 JSON。' },
      { role: 'user', content: NORM_PROMPT({ text: text.slice(0, 6000), genre, hits: deterministicHits }) },
    ],
    { json: true, temperature: 0.15, maxTokens: 2200 },
  );
  const r = parseJsonContent(content, '学术规范审计');
  return {
    score: Number.isFinite(Number(r.score)) ? Math.max(0, Math.min(100, Number(r.score))) : null,
    issues: Array.isArray(r.issues)
      ? r.issues
          .filter((x) => x && x.evidence)
          .map((x) => ({
            type: String(x.type || 'language'),
            severity: String(x.severity || 'mid'),
            evidence: String(x.evidence),
            issue: String(x.issue || ''),
            suggestion: String(x.suggestion || ''),
            source: 'llm',
          }))
          .slice(0, 12)
      : [],
    summary: String(r.summary || ''),
    mode: 'llm',
  };
}

function scoreOf(items) {
  let s = 100;
  for (const it of items) {
    if (it.severity === 'high') s -= 12;
    else if (it.severity === 'mid') s -= 6;
    else s -= 2;
  }
  return Math.max(0, s);
}

/**
 * 学术规范审计主入口：确定性安全网 → LLM 深审（有密钥时）→ 合并落盘。
 * @param file 指定 md 文件；缺省读工作区 draft.md。只报告，不擅自改稿。
 */
export async function academicNorm(cfg, workspace, { text = '', genre = '', file = null } = {}) {
  const w = workspace || '.';
  let t = text;
  if (!t && file) t = fs.readFileSync(path.resolve(String(file)), 'utf8');
  if (!t && fs.existsSync(path.join(w, 'draft.md'))) t = fs.readFileSync(path.join(w, 'draft.md'), 'utf8');
  const det = normScan(t, genre).items;
  let llm = { skipped: true, reason: '未配置 LLM 密钥，仅确定性安全网' };
  if (cfg.apiKey) {
    try {
      // 长文档分段审计（v0.60）：按标题/6000 字分片逐段 LLM 审阅，合并去重，
      // 避免整篇截断导致后半部分完全漏检。
      const chunks = splitLongText(t, { maxChars: 6000 });
      const hits = det.map((i) => `${i.type}:${i.issue}`).join('；') || '（无）';
      const reviews = [];
      for (const c of chunks) {
        reviews.push(await llmNormReview(cfg, c.text, hits, genre));
      }
      const scores = reviews.map((r) => r.score).filter((n) => Number.isFinite(n));
      const issues = [];
      for (const r of reviews) issues.push(...(Array.isArray(r.issues) ? r.issues : []));
      llm = {
        mode: 'llm',
        score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
        issues,
        summary: reviews.map((r) => r.summary || '').filter(Boolean).join('；'),
      };
    } catch (e) {
      llm = { skipped: true, reason: `LLM 审阅失败（${String(e?.message || e).slice(0, 80)}）——确定性检查仍可用` };
    }
  }
  const llmItems = Array.isArray(llm.issues) ? llm.issues : [];
  const items = dedupe([...det, ...llmItems]).slice(0, 50);
  const report = {
    ts: ws.nowIso(),
    genre,
    score: llm.score ?? scoreOf(items),
    items,
    summary: llm.summary || (items.length ? `确定性检查发现 ${items.length} 处疑点` : '未发现确定性问题'),
    llmMode: llm.mode || 'skipped',
    llmReason: llm.reason || '',
  };
  try {
    const out = path.join(w, 'vault', 'norm-report.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderNormReport(report), 'utf8');
  } catch {}
  return report;
}

export function renderNormReport(r) {
  const lines = [
    '# 学术规范审计报告',
    '',
    `- 时间：${r.ts || ''}`,
    `- 文体：${r.genre || '未指定'}`,
    `- 综合评分：${r.score ?? '—'}/100（LLM 模式：${r.llmMode || 'skipped'}${r.llmReason ? '，' + r.llmReason : ''}）`,
    `- 总评：${r.summary || ''}`,
    '',
  ];
  if (!r.items?.length) {
    lines.push('未发现确定性问题。');
  } else {
    const order = { high: 0, mid: 1, low: 2 };
    const sorted = [...r.items].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    lines.push('## 问题清单', '', '| 级别 | 类型 | 证据 | 问题 | 建议 |', '| --- | --- | --- | --- | --- |');
    for (const it of sorted) {
      lines.push(`| ${it.severity} | ${it.type}${it.source === 'llm' ? '（LLM）' : ''} | ${(it.evidence || '').replace(/\|/g, '\\|')} | ${(it.issue || '').replace(/\|/g, '\\|')} | ${(it.suggestion || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('', '> 本报告只提示不擅自改稿；如需修改请走定点修改（point-edit），修改即风格教学。');
  }
  return lines.join('\n') + '\n';
}
