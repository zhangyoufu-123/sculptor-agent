// Phase 4 红队审计：确定性反 AI 检查（黑名单/重复比喻/重复句式/统计指标）+ 可选 LLM 修订。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chatWithRetry } from './llm.js';
import { REDTEAM_FIX_PROMPT } from './prompts.js';
import * as ws from './workspace.js';
import { buildStyleShot } from './style-memory.js';
import { readVector, perplexityProxy } from './style-vector.js';
import { snapshot } from './history.js';

function fileHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export const BLACKLIST = [
  '在当今社会',
  '在当今时代',
  '在当今世界',
  '随着社会的发展',
  '随着时代的发展',
  '随着科技的发展',
  '近年来',
  '众所周知',
  '毋庸置疑',
  '不可否认',
  '我们生活在一个',
  '这是一个最好的时代',
  '想象一下',
  '让我们想象',
  '让我们来看',
  '值得注意的是',
  '值得关注的是',
  '需要指出的是',
  '值得一提的是',
  '不难看出',
  '不难发现',
  '显而易见',
  '由此可见',
  '我们可以发现',
  '我们可以看到',
  '事实上',
  '实际上',
  '与此同时',
  '综上所述',
  '总而言之',
  '总的来说',
  '无独有偶',
  '底层逻辑',
  '顶层设计',
  '赋能',
  '抓手',
  '闭环',
  '颗粒度',
  '组合拳',
  '护城河',
  '降维打击',
  '认知升维',
  '思维模型',
];

const SENT_SPLIT = /[。！？.!?]+/;

function sentences(text) {
  return text
    .split(SENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function paragraphs(text) {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function audit(text, opts = {}) {
  const report = {
    blacklistHits: [],
    repeatedMetaphors: [],
    repeatedPatterns: [],
    metrics: {},
    structuralSignals: [],
    passed: true,
    suggestions: [],
    smoothness: null,
  };
  const all = paragraphs(text).join('\n');

  for (const phrase of BLACKLIST) {
    let idx = 0;
    while ((idx = all.indexOf(phrase, idx)) !== -1) {
      report.blacklistHits.push({
        phrase,
        context: all.slice(Math.max(0, idx - 20), idx + phrase.length + 20),
      });
      idx += phrase.length;
    }
  }

  // 重复比喻：提取 像/如同/仿佛 X 的喻体，跨句重复即标记
  const vehicles = {};
  for (const s of sentences(all)) {
    for (const m of s.matchAll(/(?:像|如同|仿佛)([^，。；、！？]{2,14})/g)) {
      let v = m[1]
        .trim()
        .replace(/(一样|般|似的).*$/, '')
        // 归一化同喻体：像赶火车 / 像在赶火车 / 像正赶火车 → 赶火车
        .replace(/^(在|着|是|地|得|不|也|又|正|就|还|都)/, '');
      if (v.length > 4) v = v.slice(0, 4); // 归一化"X一样…"与"X踏过…"为同一喻体
      if (!v) continue;
      vehicles[v] = vehicles[v] || { count: 0, sentences: [] };
      vehicles[v].count += 1;
      if (vehicles[v].sentences.length < 2) vehicles[v].sentences.push(s.slice(0, 40));
    }
  }
  for (const [v, info] of Object.entries(vehicles)) {
    if (info.count > 1)
      report.repeatedMetaphors.push({
        vehicle: v,
        count: info.count,
        sentences: info.sentences,
      });
  }

  // 重复句式
  for (const [name, re] of [
    ['虽然…但是…', /虽然[^。！？]{2,40}但是/g],
    ['不是…而是…', /不是[^。！？]{2,40}而是/g],
    ['因为…所以…', /因为[^。！？]{2,40}所以/g],
  ]) {
    const hits = all.match(re) || [];
    if (hits.length > 1) report.repeatedPatterns.push({ pattern: name, count: hits.length });
  }

  // 统计指标
  const ss = sentences(all);
  const lens = ss.map((s) => [...s].length);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const stddev = Math.sqrt(
    lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length),
  );
  const plens = paragraphs(all).map((p) => [...p].length);
  const pmean = plens.reduce((a, b) => a + b, 0) / Math.max(1, plens.length);
  const pcv =
    Math.sqrt(plens.reduce((a, b) => a + (b - pmean) ** 2, 0) / Math.max(1, plens.length)) /
    Math.max(1, pmean);
  const starts = new Set(ss.map((s) => s.slice(0, 2)));
  const startDedup = ss.length ? starts.size / ss.length : 1;
  const bigrams = new Map();
  const chars = all.replace(/[\s，。！？、；：""''（）]/g, '');
  for (let i = 0; i < chars.length - 1; i++) {
    const bg = chars.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  const ttr = bigrams.size / Math.max(1, chars.length - 1);
  const dashCount = (all.match(/——/g) || []).length;

  report.metrics = {
    sentenceLengthStddev: Number(stddev.toFixed(1)),
    paragraphCv: Number(pcv.toFixed(2)),
    sentenceStartDedup: Number((startDedup * 100).toFixed(0)),
    bigramTtr: Number(ttr.toFixed(2)),
    dashPerThousand: Number(((dashCount * 1000) / Math.max(1, chars.length)).toFixed(1)),
  };
  if (report.metrics.sentenceLengthStddev < 8)
    report.suggestions.push('句长标准差 < 8，节奏偏平，拆长句/合并碎句');
  if (report.metrics.paragraphCv < 0.35)
    report.suggestions.push('段落长度变异系数 < 0.35，段落等长，调整长短错落');
  if (report.metrics.sentenceStartDedup < 75)
    report.suggestions.push(`句首去重率 ${report.metrics.sentenceStartDedup}% < 75%，句首太重复`);
  if (report.metrics.bigramTtr < 0.7) report.suggestions.push('词汇二元 TTR < 0.7，用词重复偏高');

  // ── 结构性 AI 痕迹（长文级，从《差生》等长稿审计提炼）────────────
  // 这些是"单句检查抓不到、整篇一看全是模板"的痕迹：
  // 章节开头单句定场、章节结尾金句收束、三连排比、同语反复（A是A）、
  // 重复动作模板（数…数到…）、内心话"不出口"收束、单字句意象重复、对话口头禅。
  const structural = [];

  // 章节开头/结尾模式化（只统计有 ## 标题的章节块）
  const chapterBlocks = all.split(/\n(?=#{1,6}\s)/).filter((b) => /^#{1,6}\s/.test(b.trim()));
  if (chapterBlocks.length >= 3) {
    let shortOpen = 0;
    let shortEnd = 0;
    for (const block of chapterBlocks) {
      const body = block.replace(/^#{1,6}\s+[^\n]*\n?/, '').trim();
      const firstSent = sentences(body)[0] || '';
      if (firstSent && [...firstSent].length <= 8) shortOpen += 1;
      const paras = body.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      const lastPara = paras.at(-1) || '';
      const lastSents = sentences(lastPara);
      if (lastSents.length === 1 && [...lastPara].length <= 14) shortEnd += 1;
    }
    if (shortOpen / chapterBlocks.length >= 0.6) {
      structural.push(
        `章节开头模式化：${shortOpen}/${chapterBlocks.length} 章以 ≤8 字单句定场（"期中考试。"式），长文结构像模板`,
      );
    }
    if (shortEnd / chapterBlocks.length >= 0.6) {
      structural.push(
        `章节结尾模式化：${shortEnd}/${chapterBlocks.length} 章以 ≤14 字单句金句收束，每章都在"点题"`,
      );
    }
  }

  // 三连排比：连续 6 句内同一句首出现 ≥3 次（"我想说…我想说…我想说…"）
  {
    const ss = sentences(all);
    const pref = new Map();
    for (let i = 0; i < ss.length; i++) {
      const p = ss[i].slice(0, 2);
      if (!/[\u4e00-\u9fff]/.test(p[0] || '')) continue;
      let n = 1;
      for (let j = i + 1; j < ss.length && j <= i + 5; j++) {
        if (ss[j].slice(0, 2) === p) n += 1;
      }
      if (n >= 3 && !pref.has(p)) pref.set(p, { count: n, example: ss[i].slice(0, 24) });
    }
    for (const [p, info] of pref) {
      structural.push(`三连排比：连续 6 句内"${p}"开头 ${info.count} 次（如"${info.example}…"）`);
    }
  }

  // 同语反复："迟到是迟到，白卷是白卷，打架是打架"（A是A）
  {
    const hits = all.match(/([\u4e00-\u9fff]{2,6})是\1[，。]/g) || [];
    if (hits.length >= 3) {
      structural.push(`同语反复句式（"A是A，B是B"）${hits.length} 处：${hits.slice(0, 3).join('；')}`);
    }
  }

  // 重复动作模板："数…，数到…"（注意力漂移技巧被用滥）
  {
    const n = (all.match(/数[^。！？]{0,10}，数到/g) || []).length;
    if (n >= 3) structural.push(`重复动作模板："数…，数到…" ${n} 次（同一种细节手法反复用）`);
  }

  // 内心话"不出口"收束："这句话我没有说出口" / "我没有告诉任何人"
  {
    const n =
      (all.match(/这句话[^。！？]{0,12}(没有说|说不出口)/g) || []).length +
      (all.match(/没有说出口/g) || []).length +
      (all.match(/我(没有|没)[^。！？]{0,8}(告诉|解释)/g) || []).length;
    if (n >= 3) structural.push(`内心话"不出口"收束 ${n} 次（"这句话我没有说出口"式结尾用滥）`);
  }

  // 单字句意象重复："白的。"独立成句或作句尾 ≥3 次
  {
    const frag = {};
    const EXCLUDE = new Set(['好', '了', '吗', '吧', '啊', '呀', '嘛', '呢', '是', '的', '有', '没', '不']);
    // 保留标点的原始分句（sentences() 会剥掉句号，导致"X的。"匹配不上）
    const rawSents = all
      .split(/(?<=[。！？.!?])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of rawSents) {
      if ([...s].length > 16) continue;
      const m = s.match(/([\u4e00-\u9fff]{1,3})的。$/);
      if (!m) continue;
      const k = m[1].slice(-1);
      if (EXCLUDE.has(k)) continue;
      frag[k] = (frag[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(frag)) {
      if (n >= 3) structural.push(`单字句意象重复："${k}的。"作句尾/独立句 ${n} 次（意象单点反复出现）`);
    }
  }

  // 对话口头禅：同一句对话出现 ≥5 次（如为刻意人设可忽略，否则是 AI 复读）
  {
    const tic = {};
    for (const m of all.matchAll(/[“"]([^”"]{1,16})[”"]/g)) {
      const k = m[1].trim();
      if (k) tic[k] = (tic[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(tic)) {
      if (n >= 5) structural.push(`对话口头禅重复："${k}" 出现 ${n} 次（若为刻意人设请忽略，否则是 AI 复读）`);
    }
  }

  // ── 假思考痕迹（v0.52）：统计层抓不到的姿态层 AI 味 ──────────────
  // "表演思考" = 用金句排比做形式高潮、用路标式转折假装在推进、用点题式收尾假装想通了。
  // 这类问题 redteam 单句检查抓不到，但对读者体感伤害最大（《语言匮乏》诊断的"正确语言的堆积"）。
  const fakeThinking = [];
  const goldenClosers = all.match(/(，是[\u4e00-\u9fff]{1,10}){2,}[。！？]/g) || [];
  if (goldenClosers.length >= 1) {
    fakeThinking.push(
      `金句排比收束 ${goldenClosers.length} 处（"…，是…，是…，是…"式同义反复，如「${goldenClosers[0].slice(0, 26)}…」）——形式高潮、内容悬空`,
    );
  }
  const signposts =
    (all.match(/后来我想|然后我就想|但这里头有个悖论|我绕了很久才绕出来|想了很久，|让我重新想/g) || [])
      .length;
  if (signposts >= 3) {
    fakeThinking.push(`路标式转折 ${signposts} 次（"后来我想/但这里头有个悖论"——作者在走流程，不在思考）`);
  }
  const epiphanies = (all.match(/我终于明白|原来[^。！？]{0,14}才是|其实[^。！？]{0,10}就是/g) || []).length;
  if (epiphanies >= 2) {
    fakeThinking.push(`点题式顿悟 ${epiphanies} 处（"我终于明白/原来…才是"——思考被提前宣告完成）`);
  }
  report.fakeThinking = fakeThinking;
  for (const s of fakeThinking) structural.push(s);

  report.structuralSignals = structural;
  for (const s of structural.slice(0, 5)) report.suggestions.push(s);

  // 困惑度签名对照：作者基线均值 vs 本文 surprisal（软提示，不计入硬失败）
  const sig = perplexityProxy(all);
  const baseline = opts.vectorSignature;
  if (sig && baseline && baseline.samples >= 3 && baseline.mean) {
    if (sig.surprisal < baseline.mean * 0.75) {
      report.smoothness = {
        hint: `平滑度偏离：本文 surprisal ${sig.surprisal.toFixed(3)}，低于作者基线均值 ${Number(baseline.mean).toFixed(3)}（×0.75）——比作者本人更"顺"，可能是 AI 平滑痕迹`,
        textSurprisal: Number(sig.surprisal.toFixed(3)),
        authorMean: Number(baseline.mean.toFixed(3)),
      };
    } else if (report.blacklistHits.length === 0) {
      report.smoothness = {
        hint: `本文 surprisal ${sig.surprisal.toFixed(3)}，与作者基线均值 ${Number(baseline.mean).toFixed(3)} 同一量级，人类化通过`,
        textSurprisal: Number(sig.surprisal.toFixed(3)),
        authorMean: Number(baseline.mean.toFixed(3)),
      };
    }
  }

  report.passed =
    report.blacklistHits.length === 0 &&
    report.repeatedMetaphors.length === 0 &&
    report.repeatedPatterns.length === 0 &&
    report.suggestions.length === 0;
  return report;
}

function collectIssues(report) {
  const issues = [];
  for (const h of report.blacklistHits) issues.push(`黑名单「${h.phrase}」`);
  for (const m of report.repeatedMetaphors)
    issues.push(`重复比喻「像${m.vehicle}」（${m.count}次）`);
  for (const p of report.repeatedPatterns) issues.push(`重复句式「${p.pattern}」（${p.count}次）`);
  for (const s of report.structuralSignals || []) issues.push(`结构痕迹：${s}`);
  return issues.join('；');
}

export async function redteam(cfg, wsDir, { fix = false } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const draftFile = `${workspace}/draft.md`;
  if (!fs.existsSync(draftFile)) throw new Error('没有 draft.md，先运行 sculptor write');
  const writeStyle = JSON.stringify(
    ws.readJson(`${workspace}/vault/write-style.json`).dimensions || {},
    null,
    0,
  ).slice(0, 800);
  let state = {};
  try {
    state = ws.readState(workspace); // state 缺失时不影响审计（仅风格检索退化为论题为空）
  } catch {}
  const sv = readVector(workspace);
  const pp = sv?.perplexity;
  const vectorSignature = pp && pp.samples >= 3 ? { samples: pp.samples, mean: pp.mean } : null;
  const styleShot = buildStyleShot(workspace, {
    topic: state.confirmed?.topic || state.outline?.title || '',
    genre: state.confirmed?.genre || '',
  });
  let text = fs.readFileSync(draftFile, 'utf8');
  let report = audit(text, { vectorSignature });

  if (fix && !report.passed) {
    const issues = collectIssues(report);
    const fixed = await chatWithRetry(
      cfg,
      [
        {
          role: 'system',
          content: '你是修订者，用用户风格改写有 AI 痕迹的片段。',
        },
        {
          role: 'user',
          content: REDTEAM_FIX_PROMPT({ issues, text, writeStyle, styleShot }),
        },
      ],
      { temperature: 0.7, maxTokens: 6000 },
    );
    snapshot(workspace, 'redteam-fix');
    fs.writeFileSync(draftFile, fixed.trim() + '\n');
    text = fs.readFileSync(draftFile, 'utf8');
    state.lastDraftHash = fileHash(text); // 修订即写作：同步哈希，避免后续改写误判"外部修改"
    ws.writeState(workspace, state);
    report = audit(text);
    report.fixedBy = 'llm';
  }
  ws.logContext(
    workspace,
    'redteam',
    `审计: 黑名单 ${report.blacklistHits.length}、重复比喻 ${report.repeatedMetaphors.length}、句式 ${report.repeatedPatterns.length}、结构痕迹 ${report.structuralSignals?.length || 0}、通过=${report.passed}${report.smoothness?.hint ? '、' + report.smoothness.hint : ''}`,
  );
  return { report, draftFile };
}
