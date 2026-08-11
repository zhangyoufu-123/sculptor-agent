#!/usr/bin/env node
// Sculptor Agent CLI 入口。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { chat } from './llm.js';
import * as ws from './workspace.js';
import { clarifyOnce, clarifyInteractive } from './clarify.js';
import { generateOutline } from './outline.js';
import { writeSection } from './write.js';
import { redteam, audit } from './redteam.js';
import { dissect } from './dissect.js';
import { runMcpServer } from './mcp.js';
import { runSetup } from './setup.js';
import { pointEdit } from './point-edit.js';
import { extractInstruction } from './point-edit.js';
import { parseQuoteArg } from './point-edit.js';
import { probeTask } from './observer.js';
import { interviewStep, interviewInteractive, interviewSummary } from './interview.js';
import { runAudience, renderAudience, runDebate, renderDebate } from './reader-gallery.js';
import { styleProgress, backfillFromContext, extractStyleFromSamples } from './style.js';
import { renderStyleProfile } from './style.js';
import { implicitSignalLog } from './style.js';
import { buildStyleShot } from './style-memory.js';
import { restyle } from './restyle.js';
import { runHook } from './hook.js';
import { renderChecklist } from './interview.js';
import { agentStep, agentInteractive } from './director.js';
import { listLibrary, viewCategory, addPiece, distillAll } from './library.js';
import {
  listEntries,
  addEntry,
  removeEntry,
  matchKb,
  normTitle,
  recommendReadings,
  exportKnowledge,
  importKnowledge,
} from './knowledge.js';
import { academicNarrative, argumentScan, academicGap } from './academic.js';
import {
  listCharacters,
  loadCharacter,
  saveCharacter,
  removeCharacter,
  simulateCharacter,
} from './character.js';
import {
  extractInput,
  exportDocx,
  exportOfficialDocx,
  exportAcademicDocx,
  exportHtml,
  exportSrt,
  exportPdf,
  pdfAvailable,
  docxAvailable,
  detectWhisper,
  transcribeAudio,
} from './io.js';
import {
  formatReferences,
  parseEntries,
  readEntriesFile,
  citationStyles,
  extractCitations,
} from './citation.js';
import { GENRES, genreBrief, genreNames } from './genre.js';
import { evaluateStyleFidelity, applyEvalFeedback, renderStyleEval } from './style-eval.js';
import { reviewOutline, renderOutlineReview } from './outline-review.js';
import {
  adapterStatus,
  buildStyleDataset,
  distillStyleAdapter,
  loadStyleAdapter,
  submitFineTune,
} from './style-adapter.js';
import { factCheck, renderFactCheck } from './fact-check.js';
import { recentPulses, renderPulse } from './style-pulse.js';
import { rhythmCurve, renderRhythmCurve } from './style-pulse.js';
import { vectorSummary, renderVectorSummary, refreshStyleVector } from './style-vector.js';
import { checkConsistency, renderConsistency } from './consistency.js';
import { proofread, proofScan, renderProofread } from './proofread.js';
import { transform, PRESETS } from './transform.js';
import { listHistory, rollback } from './history.js';
import { exportProfile, importProfile, profileStatus } from './profile.js';
import {
  buildSearchQueries,
  searchOnline,
  ingestSearchResults,
  ingestAssetResults,
  requestHostSearch,
  pendingDataNeeds,
  ragStatus,
} from './rag.js';
import { buildPersona, personaStatus, personaBrief, personaToVector } from './persona.js';
import { listBibles, readBible, saveBible, distillBible } from './bible.js';
import { emotionCurve, renderEmotionCurve } from './revise.js';
import {
  humanMetrics,
  renderHumanMetrics,
  collectAuthorCorpus,
  corpusStats,
  runPairExperiment,
  runAblation,
  userSurveyTemplate,
  renderBlindSurvey,
  summarizeResults,
} from './experiment.js';
import { originalityScan } from './originality.js';
import { roundtripCheck, renderRoundtrip } from './roundtrip.js';
import {
  discoverCredentials,
  describeCandidate,
  redact,
  saveCredentials,
  clearCredentials,
  credentialsFile,
} from './credentials.js';
import { runReview, renderReview } from './review.js';

const HELP = `Sculptor Agent v0.23 — 完整写作 Agent（导演模式 · 四层复合风格向量 · 个人知识库 · 多 Agent 协作 · 多模态）

用法:
  sculptor init [目录]                初始化工作区（默认 ./.sculptor）
  sculptor agent [工作区]             导演模式：我主导全程（澄清→大纲→写作→审计→群像→交付）
  sculptor agent --once [工作区]      导演单步：应用 stdin 的回答，返回下一步决策 JSON
  sculptor clarify [工作区]           交互澄清（一次一问）
  sculptor clarify --once [工作区]    单步澄清：应用 stdin 的回答，输出下一个问题
  sculptor interview [工作区]         需求访谈：多轮一问 + 实时确认清单 + 进度
  sculptor interview --once [工作区]  单步访谈：应用 stdin 回答，输出问题+清单+进度
  sculptor interview --summary [工作区]  打包需求确认清单与剩余步骤（不消耗 LLM）
  sculptor outline [工作区]           生成大纲（素材门槛未过会报错）
  sculptor write [工作区]             按大纲逐节写作到 draft.md（--force 强制重写）
  sculptor write --section N [工作区] 只写第 N 节
  sculptor restyle [--direction 方向] [--section N] [--force] [工作区]
                                     按新风格方向重写整篇（或指定节）；缺省用档案最近一条方向
  sculptor transform <预设> [--target N] [--tone x] [--section N] [--force] [工作区]
                                     一键改写矩阵：expand 扩写 / condense 缩写 / continue 续写 /
                                     polish 润色 / imitate 仿写 / tone:formal|casual|warm|authoritative 改语气
  sculptor history [工作区]           版本快照列表（write/restyle/redteam-fix/transform 前自动生成）
  sculptor rollback [N] [工作区]      回滚到第 N 份快照（1=最新；回滚前先存当前版本）
  sculptor profile export [--to file] [工作区]  导出全局风格档案（默认 SCULPTOR_HOME 或工作区 vault）
  sculptor profile import <file> [工作区]  导入合并风格档案（本地高置信维度不被动覆盖）
  sculptor redteam [--fix] [工作区]   反 AI 审计（可选 LLM 修订）
  sculptor redteam --file x.md        直接审计任意文件
  sculptor redteam --proofread [工作区]  反 AI 审计 + 确定性校对
  sculptor style-eval [--file x.md] [工作区]  深度全稿风格保真评估（对照旧稿/修改记录打分；默认不自动跑，需要时手动）
  sculptor outline-review [工作区]    大纲评审：评审当前大纲（低分时自动给出修订版，仍需你确认）
  sculptor audience [--file x.md] [--quick] [工作区]  读者群像：8 个"第一读者"的感性反馈
  sculptor debate [--file x.md] [--quick] [工作区]    读者交锋：分歧最大的 3 位读者互看意见后收敛出共识/争议/优先级
  sculptor dissect [--file x.md] [工作区]  感性解剖 5 维度
  sculptor fact-check [--file x.md] [工作区]  事实核查：数字/年代/引文/人名/机构 → material/common/verify 分级
  sculptor proofread [--file x.md] [工作区]   校对纠错：错别字/叠字/标点（确定性）+ 语病（LLM，可选）
  sculptor quote "<原句>"             生成可粘贴的「Sculptor 引用」块
  sculptor hook <工作区> [payload]    宿主生命周期钩子 → 观察日志 + 压缩守卫
  sculptor checklist <工作区>         渲染需求访谈确认清单（不消耗 LLM）
  sculptor style [--memory 查询] [--export] [--backfill] [--extract] [工作区]
                                     风格档案进度；--memory 预览按论题检索到的旧稿与修改对；--export 导出人类可读档案（vault/style-profile.md）；--backfill 回填对话日志；--extract 提取风格底稿
  sculptor style --pulses [工作区]    风格脉搏：查看澄清/大纲/每节写作/修改建议的即时评估记录
  sculptor style --signals [工作区]   隐式风格信号流水：每轮对话被动采集到的风格证据
  sculptor curve [--file x.md] [工作区]  节奏曲线：每节 张力/信息密度/情绪强度/节奏变化 → vault/curve.md
  sculptor consistency [--file x.md] [工作区]  伏笔回收校验：跨章检查已记伏笔是否回收 → vault/consistency.md
  sculptor style-vector [--refresh] [工作区]  四层复合风格向量：连续向量(EMA) + 动态维度 + 困惑度签名 + 偏好对；--refresh 立即从档案重算
  sculptor style-adapter [--distill] [--dataset [out.jsonl]] [--lora] [工作区]
                                     风格持续微调：--distill 蒸馏风格适配卡（最高优先级注入）；--dataset 生成偏好对 JSONL；--lora 提交微调（未配置端点时给出本地 LoRA 指引）
  sculptor genre [名称]               文体库：结构骨架 + 行文规范（公文/合同/通知/纪要/报告/议论文/散文/演讲稿/记叙文）
  sculptor library [工作区]           个人写作库：查看分类作品与蒸馏 skill
  sculptor library scan [工作区]      蒸馏每类作品的"个人写作 skill"（vault/skills/personal/）
  sculptor library view <类别> [工作区]  查看某类的蒸馏 skill 与作品清单
  sculptor library add <file> [--category 类别] [--session 标识] [工作区]  归档一篇作品（自动分类）
  sculptor knowledge [工作区]           个人知识库：查看读过的书/去过的地方/自己的构想
  sculptor knowledge list|search <关键词>|view <标题或id>|add <标题>|remove <标题或id> [工作区]
                                     列表/检索/查看/收录/移除个人知识（澄清中《书名》与"去过×"
                                     会自动归纳收录，只问一次、可随时在此管理）
  sculptor knowledge export [--to file] [工作区]  导出个人知识库 bundle（可迁移到其他项目）
  sculptor knowledge import <file> [工作区]       导入合并知识库（按标题去重；含个人阅读/经历，注意保管）
  sculptor recommend [工作区]        荐书联想：从思想库匹配与你主题相近的书/理论，说明为什么可用
  sculptor bible list|view <标题>|save <标题>|distill [工作区]
                                     文章圣经：长文/系列文的跨篇一致性文档（交付自动沉淀）
  sculptor emotion [--file x.md] [工作区]  情绪曲线量化（按节输出强度与主导情绪，供节奏检查）
  sculptor experiment metrics <file>        人类化指标：句长标准差/段落变异/TTR/困惑度签名等
  sculptor experiment collect [工作区] [--out file]  采集作者语料包（旧稿/修改/话语/向量/知识）
  sculptor experiment run --topic "题目" [--genre 散文] [--words 800] [--authors "名=文件;名2=文件2"] [工作区]
                                     对照实验：每位作者跑 baseline vs 风格注入 variant，
                                     输出指标对比 + 随机顺序盲评对（vault/experiments/）
  sculptor experiment ablation --topic "题目" --author <样本文件> [工作区]  消融实验（逐模块关闭）
  sculptor experiment survey [--out file]  生成盲评 + 用户体验问卷模板
  sculptor experiment blind <run目录> [--out file]  把盲评对导出成一页问卷（可直接分发）
  sculptor experiment summarize <run目录> [--answers answers.json]
                                     汇总论文表格：客观指标 + 盲评选择率 + 二项检验
  sculptor academic [工作区]         学术论证链：known→gap→tension→insight→method→evidence→limitation
                                     + 成稿论证完备性扫描（claim/evidence/warrant/limitation）
  sculptor persona [--refresh] [工作区]  人物风格肖像：从知识库/旧作/修改记录侧写你的写作人格
                                     （vault/persona.md 可查询）；--refresh 重新生成并映射回风格向量
  sculptor character list|add|view|remove|simulate <名字> [--scene 场景] [工作区]
                                     小说角色档案与预演：add 建档案（--want/--fear/--secret/--speech），
                                     simulate 让角色按档案预测情绪/言语/行为，供写作注入
  sculptor ingest <file...> [工作区]  多模态输入：docx/xlsx/图片/md → 提取成素材
  sculptor dictate <音频...> [--to-draft] [工作区]  语音口述：whisper 转录 → 素材；--to-draft 生成口述草稿
  sculptor export [--docx out.docx] [--md out.md] [工作区]  把 draft.md 导出为 docx/md
  sculptor export --official [--redhead] [--docx out.docx] [工作区]  按 GB/T 9704-2012 公文排版导出 docx
  sculptor export --academic [--docx out.docx] [工作区]  按学术论文排版导出 docx（宋体小四/黑体标题）
  sculptor export --html out.html / --srt out.srt / --pdf out.pdf [工作区]  导出 HTML / 字幕 SRT / PDF
  sculptor cite "<json条目或数组>" [--style gbt7714|apa] [--file refs.json]  生成参考文献（期刊/图书/网页/报纸/论文/报告）
  sculptor citations [--file x.md] [--append refs.json] [--auto] [工作区]  提取文中《引文》清单；--append 追加参考文献到草稿；--auto 从检索回灌来源生成参考文献草稿
  sculptor rag [status|search|ingest|ingest-assets|needs] [工作区]  联网检索：search 生成查询并直连/排队宿主代检；ingest <results.json> 回灌缓存与素材；ingest-assets 回灌联网资产/思想（书目自动入知识库）；needs 查看待办资料请求
  sculptor originality [--file x.md] [工作区]   原创性检查：文内重复句/与个人库自我复用/模板句（内置质量门，交付前自动执行）
  sculptor review [--fix] [--quick] [--file x.md] [工作区]  深度审阅：红队+校对+事实+原创+风格保真+读者交锋 → P0/P1/P2；--fix 一键修复 P0
  sculptor absorb <工作区> <edit.json>   吸收定点修改进风格档案
  sculptor fingerprint <工作区>       刷新压缩守卫风格指纹
  sculptor panel [state.json]         渲染玻璃面板
  sculptor status [工作区]            工作区摘要
  sculptor doctor [--ping]            自检（可选连通性测试）
  sculptor credentials [--ask] [--use N] [--clear] [工作区]
                                     凭据发现：自动读取 Codex/Claude/OpenCode/env 已配置的 API；
                                     --use N 采用候选；--ask 交互选择或手动输入；--clear 清除工作区凭据
  sculptor mcp                       启动 MCP stdio 服务器（供 Codex/Claude Code/OpenCode 调用）
  sculptor setup [--dry-run] [--dir 项目] [--engine 引擎路径] [--hosts codex,claude,opencode]
                                     自动接入：检测宿主→原生注册→装 skill→复用本机凭据
  sculptor point-edit "<引用/原文>" "<修改指令>" [--dir 项目] [--file 文件]
                                     深度定点修改：只改选中的那一处，吸收进风格档案
  sculptor roundtrip [<文本|文件>] [--file x.md] [工作区]
                                     翻译/回译校验：中译英→回译，信息点核对 + 风格对比
  sculptor probe "<任务描述>"         生态位探测：该不该让 Sculptor 主动介入

环境变量（可选，默认指向 DeepSeek）:
  SCULPTOR_LLM_BASE_URL  SCULPTOR_LLM_API_KEY  SCULPTOR_LLM_MODEL
  SCULPTOR_LLM_MAX_TOKENS  SCULPTOR_LLM_TIMEOUT_MS  SCULPTOR_WORKSPACE
  SCULPTOR_QUICK=1          快速模式：读者 3 人、跳过交锋与适配卡重蒸馏（交付更快）
  SCULPTOR_RAG_ENDPOINT/SCULPTOR_RAG_API_KEY  直连检索端点（POST /search {queries}）；不配置则走宿主代检（requests.jsonl）
  SCULPTOR_EMBED_BASE_URL/SCULPTOR_EMBED_API_KEY/SCULPTOR_EMBED_MODEL  风格向量升级为真实 embedding（OpenAI 兼容 /embeddings）；不配置则用稀疏字符二元组
  SCULPTOR_PERPLEXITY_ENDPOINT  困惑度签名真实端点（POST {text} → {perplexity}）；不配置则用确定性代理
  SCULPTOR_STYLE_EMA  风格向量 EMA 系数（默认 0.75：越大越稳、越小越跟手）
  SCULPTOR_BASELINE_TEXT  通用语料文件路径；配置后连续向量输出"作者−基线"偏离方向
  SCULPTOR_CREDENTIALS=auto|ask|off  凭据发现模式：auto 自动采用宿主最佳候选（默认）/ ask 交互 / off 只用显式配置
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      if (val !== true) i += 1;
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

function printError(err) {
  if (process.env.SCULPTOR_DEBUG) console.error(err.stack || String(err));
  else console.error(`[sculptor] ${err.message}`);
  process.exitCode = 1;
}

async function doctor(cfg, { ping = false } = {}) {
  const report = [];
  report.push(
    `Node: ${process.version} ${Number(process.versions.node.split('.')[0]) >= 18 ? '✓' : '✗（需要 ≥18）'}`,
  );
  report.push(
    `LLM 端点: ${cfg.baseUrl}（模型 ${cfg.model}）${cfg.apiKey ? '✓ 已配置密钥' : '⚠ 未配置密钥（可用 mock 或本地服务）'}`,
  );
  report.push(
    `凭据来源: ${cfg.credentialsSource ? `${cfg.credentialsSource}（自动发现，密钥已脱敏）` : cfg.apiKey ? '显式 SCULPTOR_LLM_API_KEY' : '（未配置，可用 sculptor credentials --ask 选择或输入）'}`,
  );
  const w = ws.resolveWorkspace(cfg, '');
  report.push(`工作区: ${w} ${fs.existsSync(w) ? '✓' : '（未初始化）'}`);
  if (fs.existsSync(`${w}/vault/write-style.json`)) {
    report.push(
      `风格档案: write ${ws.styleDimSummary(`${w}/vault/write-style.json`)} · read ${ws.styleDimSummary(`${w}/vault/read-style.json`)}`,
    );
  }
  if (ping) {
    try {
      const r = await chat(cfg, [{ role: 'user', content: 'ping' }], {
        maxTokens: 16,
        temperature: 0,
      });
      report.push(`LLM 连通: ✓（${r.trim().slice(0, 40)}）`);
    } catch (err) {
      report.push(`LLM 连通: ✗ ${err.message.slice(0, 120)}`);
      process.exitCode = 1;
    }
  }
  console.log(report.join('\n'));
}

export async function runCli(argv, io = {}) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();
  const { flags, positional } = parseArgs(rest);
  const workspace = flags.workspace || positional[0] || '';

  try {
    switch (cmd) {
      case 'init': {
        const dir = flags.dir || positional[0] || '';
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, dir), {
          create: true,
        });
        console.log(`Sculptor 工作区已初始化 → ${w}`);
        break;
      }
      case 'agent': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace), { create: true });
        if (flags.once) {
          const r = await agentStep(cfg, w, { lastInput: io.input || '' });
          console.log(JSON.stringify(r, null, 2));
        } else {
          await agentInteractive(cfg, w);
        }
        break;
      }
      case 'panel': {
        const f =
          positional[0] ||
          `${workspace || path.join(process.cwd(), '.sculptor')}/protocol/state.json`;
        console.log(ws.renderPanel(f));
        break;
      }
      case 'status': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        console.log(ws.statusReport(w));
        break;
      }
      case 'clarify': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace), { create: true });
        if (flags.once) {
          const r = await clarifyOnce(cfg, w, { input: io.input });
          console.log(JSON.stringify(r, null, 2));
        } else {
          await clarifyInteractive(cfg, w);
        }
        break;
      }
      case 'interview': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace), { create: true });
        if (flags.once) {
          const r = await interviewStep(cfg, w, { lastInput: io.input || '' });
          console.log(JSON.stringify(r, null, 2));
        } else if (flags.summary) {
          console.log(await interviewSummary(cfg, w));
        } else {
          await interviewInteractive(cfg, w);
        }
        break;
      }
      case 'audience': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await runAudience(cfg, w, {
          file: flags.file || null,
          quick: Boolean(flags.quick),
        });
        console.log(renderAudience(r));
        break;
      }
      case 'debate': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await runDebate(cfg, w, {
          file: flags.file || null,
          quick: Boolean(flags.quick),
        });
        console.log(renderDebate(r));
        break;
      }
      case 'fact-check': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await factCheck(cfg, w, { file: flags.file || null });
        console.log(renderFactCheck(r));
        break;
      }
      case 'proofread': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await proofread(cfg, w, { file: flags.file || null });
        console.log(renderProofread(r));
        break;
      }
      case 'originality': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const file = flags.file ? path.resolve(String(flags.file)) : path.join(w, 'draft.md');
        if (!fs.existsSync(file)) throw new Error(`找不到文稿: ${file}`);
        const r = originalityScan(fs.readFileSync(file, 'utf8'), w);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'review': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await runReview(cfg, w, {
          file: flags.file ? path.resolve(String(flags.file)) : null,
          fix: Boolean(flags.fix),
          quick: Boolean(flags.quick),
        });
        console.log(renderReview(r.report));
        process.exitCode = r.report.passed ? 0 : 1;
        break;
      }
      case 'rag': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const sub = positional[0] || 'status';
        if (sub === 'ingest') {
          if (positional.length < 2) throw new Error('用法: sculptor rag ingest <results.json>');
          const raw = JSON.parse(fs.readFileSync(path.resolve(positional[1]), 'utf8'));
          const results = Array.isArray(raw) ? raw : raw.results;
          const r = ingestSearchResults(w, results);
          console.log(`已回灌 ${r.ingested} 条检索结果（缓存 ${r.cached} 条，已加入素材）`);
        } else if (sub === 'ingest-assets') {
          if (positional.length < 2) throw new Error('用法: sculptor rag ingest-assets <results.json>');
          const raw = JSON.parse(fs.readFileSync(path.resolve(positional[1]), 'utf8'));
          const results = Array.isArray(raw) ? raw : raw.results;
          const r = ingestAssetResults(w, results, { purpose: 'asset-search' });
          console.log(
            `已回灌 ${r.ingested} 组联网资产${r.kbAdded ? `，${r.kbAdded} 本书目入个人知识库` : ''}（缓存 ${r.cached} 条）`,
          );
        } else if (sub === 'search') {
          const text = flags.text || positional.slice(1).join(' ');
          if (!text) throw new Error('用法: sculptor rag search "<要检索的文本>" [--topic 主题]');
          const queries = buildSearchQueries(text, { topic: flags.topic ? String(flags.topic) : '' });
          if (!queries.length) {
            console.log('（没有可检索的高价值查询：需要事实候选或《引文》）');
            break;
          }
          if (cfg.ragEndpoint && cfg.ragApiKey) {
            const r = await searchOnline(cfg, queries);
            if (r.searched) {
              const ing = ingestSearchResults(w, r.results);
              console.log(`直连检索命中并回灌 ${ing.ingested} 组结果 → 缓存与素材`);
            } else {
              console.log(r.hint);
            }
          } else {
            const r = requestHostSearch(w, queries, { purpose: 'manual' });
            console.log(`已排队 ${r.queued} 条宿主检索请求（${r.requestId}）→ requests.jsonl`);
            console.log('宿主检索后用: sculptor rag ingest <results.json> 回灌');
          }
        } else if (sub === 'needs') {
          const needs = pendingDataNeeds(w);
          if (!needs.length) {
            console.log('（当前没有待办检索——需要数据时 Sculptor 会自动排队并提示）');
            break;
          }
          console.log(`待办资料检索 ${needs.length} 组（供宿主/学术/数据分析 agent 供给）：`);
          for (const n of needs) {
            console.log(`  [${n.purpose}] ${(n.queries || []).join(' / ')}`);
          }
          console.log('检索后运行: sculptor rag ingest <results.json> 回灌');
        } else {
          const st = ragStatus(w, cfg);
          console.log(
            `RAG 状态:\n` +
              `  缓存 ${st.cached} 条 · 待办请求 ${st.pendingRequests} 条\n` +
              `  通路: ${st.direct ? `直连 ${st.endpoint}` : '宿主代检（未配置 SCULPTOR_RAG_ENDPOINT）'}`,
          );
        }
        break;
      }
      case 'persona': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const st = personaStatus(w);
        if (flags.refresh || !st.built) {
          const p = await buildPersona(cfg, w);
          if (flags.refresh) await personaToVector(cfg, w);
          console.log(`风格肖像已生成（${p.fallback ? '确定性兜底' : 'LLM 侧写'}）→ vault/persona.md`);
        }
        const brief = personaBrief(w, { limit: 10 });
        console.log(brief || '（还没有风格肖像，先运行 sculptor persona --refresh）');
        break;
      }
      case 'bible': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const sub = positional[0] || 'list';
        if (sub === 'list') {
          const bs = listBibles(w);
          if (!bs.length) {
            console.log('（还没有文章圣经。长文/小说交付时会自动沉淀；也可 sculptor bible distill）');
            break;
          }
          for (const b of bs) {
            console.log(`• ${b.title}（更新 ${(b.updatedAt || '').slice(0, 10)}${b.fallback ? '，确定性' : ''}）`);
          }
        } else if (sub === 'view') {
          if (positional.length < 2) throw new Error('用法: sculptor bible view <标题>');
          const b = readBible(w, positional[1]);
          if (!b) throw new Error(`没有「${positional[1]}」的圣经`);
          console.log(JSON.stringify(b, null, 2));
        } else if (sub === 'save') {
          if (positional.length < 2) throw new Error('用法: sculptor bible save <标题> [--world 世界观] [--style 文风]');
          const b = saveBible(w, {
            title: positional[1],
            world: flags.world || '',
            styleNote: flags.style || '',
            continuityNotes: '续写前先读本文档，保持世界观/角色/时间线一致。',
          });
          console.log(`圣经已保存 → ${b.title}`);
        } else if (sub === 'distill') {
          const r = await distillBible(cfg, w, { title: positional[1] || '' });
          console.log(r.saved ? `圣经已沉淀 → ${r.title}` : '（没有可沉淀的成稿/大纲）');
        } else {
          throw new Error(`未知子命令「${sub}」。可用: list / view / save / distill`);
        }
        break;
      }
      case 'emotion': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const file = flags.file ? path.resolve(String(flags.file)) : path.join(w, 'draft.md');
        if (!fs.existsSync(file)) throw new Error(`找不到文稿: ${file}`);
        console.log(renderEmotionCurve(emotionCurve(fs.readFileSync(file, 'utf8'))));
        break;
      }
      case 'curve': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const file = flags.file ? path.resolve(String(flags.file)) : '';
        const c = rhythmCurve(w, { file });
        console.log(renderRhythmCurve(c));
        if (c.file) console.log(`\n节奏曲线已落盘 → ${c.file}`);
        break;
      }
      case 'consistency': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        const file = flags.file ? path.resolve(String(flags.file)) : '';
        const r = await checkConsistency(cfg, w, { file });
        console.log(renderConsistency(r));
        if (r.file) console.log(`\n伏笔回收报告已落盘 → ${r.file}`);
        break;
      }
      case 'experiment': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const sub = positional[0] || 'help';
        if (sub === 'metrics') {
          if (positional.length < 2) throw new Error('用法: sculptor experiment metrics <file.md>');
          const text = fs.readFileSync(path.resolve(positional[1]), 'utf8');
          console.log(renderHumanMetrics(humanMetrics(text)));
        } else if (sub === 'collect') {
          const corpus = collectAuthorCorpus(w);
          const stats = corpusStats(corpus);
          const out = flags.out ? path.resolve(String(flags.out)) : path.join(w, 'vault', 'experiments', 'corpus.json');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify(corpus, null, 2) + '\n', { mode: 0o600 });
          console.log(
            `已采集作者语料包 → ${out}\n` +
              `  旧稿样本 ${stats.samples} · 修改记录 ${stats.edits} · 对话话语 ${stats.utterances} · ` +
              `知识库 ${stats.knowledge} · 作品 ${stats.libraryPieces} · ${stats.hasVector ? '风格向量 ✓' : '风格向量（无）'}`,
          );
        } else if (sub === 'run') {
          if (!flags.topic) throw new Error('用法: sculptor experiment run --topic "题目" [--authors "名=文件;名2=文件2"]');
          const authors = [];
          if (flags.authors) {
            for (const part of String(flags.authors).split(';')) {
              const [name, file] = part.split('=');
              if (!file) throw new Error(`作者格式应为 "名=文件"：${part}`);
              const sample = fs.readFileSync(path.resolve(file.trim()), 'utf8');
              authors.push({ name: (name || '').trim(), sample });
            }
          } else {
            // 未指定作者：从本工作区的风格样本自动收集（每位样本一位"作者"）
            const corpus = collectAuthorCorpus(w);
            corpus.samples.forEach((s, i) => authors.push({ name: `样本${i + 1}`, sample: s }));
          }
          if (!authors.length) throw new Error('没有作者样本：请用 --authors 指定，或先在本工作区贴风格底稿');
          const r = await runPairExperiment(cfg, {
            topic: String(flags.topic),
            genre: flags.genre ? String(flags.genre) : '散文',
            targetWords: flags.words ? Number(flags.words) : 800,
            authors,
            workspace: w,
          });
          if (!r.ok) throw new Error(r.hint || '实验失败');
          console.log(r.report);
          console.log(`\n结果目录：${r.dir}（results.json / blind.json / report.md）`);
        } else if (sub === 'ablation') {
          if (!flags.topic || !flags.author) throw new Error('用法: sculptor experiment ablation --topic "题目" --author <样本文件>');
          const sample = fs.readFileSync(path.resolve(String(flags.author)), 'utf8');
          const r = await runAblation(cfg, {
            topic: String(flags.topic),
            genre: flags.genre ? String(flags.genre) : '散文',
            targetWords: flags.words ? Number(flags.words) : 800,
            sample,
            workspace: w,
          });
          if (!r.ok) throw new Error(r.hint || '消融失败');
          console.log('消融实验（指标越高越接近真人，对比各变体下降幅度）：');
          for (const v of r.variants) {
            if (!v.ok) {
              console.log(`  ${v.label}：生成失败（无密钥）`);
              continue;
            }
            console.log(
              `  ${v.label}：句长σ ${v.metrics.sentenceLengthStddev} · 段落CV ${v.metrics.paragraphCv} · TTR ${v.metrics.bigramTtr} · 黑名单 ${v.metrics.blacklistHits}`,
            );
          }
          console.log(`\n结果目录：${r.dir}`);
        } else if (sub === 'survey') {
          const out = flags.out ? path.resolve(String(flags.out)) : path.join(w, 'vault', 'experiments', 'survey.json');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify(userSurveyTemplate(), null, 2) + '\n', { mode: 0o600 });
          console.log(`问卷模板已生成 → ${out}（盲评 + 用户体验两部分）`);
        } else if (sub === 'blind') {
          if (positional.length < 2) throw new Error('用法: sculptor experiment blind <run目录> [--out file]');
          const dir = path.resolve(positional[1]);
          const blind = JSON.parse(fs.readFileSync(path.join(dir, 'blind.json'), 'utf8'));
          const md = renderBlindSurvey(blind);
          const out = flags.out ? path.resolve(String(flags.out)) : path.join(dir, 'blind-survey.md');
          fs.writeFileSync(out, md + '\n', { mode: 0o600 });
          console.log(`一页盲评问卷已导出 → ${out}`);
        } else if (sub === 'summarize') {
          if (positional.length < 2) throw new Error('用法: sculptor experiment summarize <run目录> [--answers answers.json]');
          const dir = path.resolve(positional[1]);
          const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
          let answers = [];
          if (flags.answers) answers = JSON.parse(fs.readFileSync(path.resolve(String(flags.answers)), 'utf8'));
          const md = summarizeResults(results, answers);
          const out = path.join(dir, 'summary.md');
          fs.writeFileSync(out, md + '\n', { mode: 0o600 });
          console.log(md);
          console.log(`\n论文表格已写入 → ${out}`);
        } else {
          throw new Error('用法: sculptor experiment metrics|collect|run|ablation|survey|blind|summarize');
        }
        break;
      }
      case 'style-adapter': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        if (flags.distill) {
          const r = await distillStyleAdapter(cfg, w);
          if (!r.distilled) {
            console.log('没有可蒸馏的风格素材：先贴旧稿、归档作品或做 point-edit。');
          } else {
            console.log(`风格适配卡已蒸馏（${r.card.mode}）→ ${r.mdFile}`);
            console.log(loadStyleAdapter(w, 1200));
          }
        }
        if (flags.dataset !== undefined) {
          const ds = buildStyleDataset(w, {
            outFile: flags.dataset && flags.dataset !== true ? String(flags.dataset) : null,
          });
          console.log(
            `微调数据集已生成：${ds.records} 条（样本 ${ds.sources.samples} / 作品 ${ds.sources.pieces} / 修改对 ${ds.sources.edits}）→ ${ds.file}`,
          );
        }
        if (flags.lora) {
          const r = await submitFineTune(cfg, w, {
            file: flags.dataset && flags.dataset !== true ? String(flags.dataset) : null,
            model: flags.model ? String(flags.model) : null,
          });
          if (r.submitted) {
            console.log(`微调任务已提交：${r.jobId}（文件 ${r.fileId}）`);
          } else {
            console.log(r.hint);
          }
        }
        if (!flags.distill && flags.dataset === undefined && !flags.lora) {
          const st = adapterStatus(w);
          console.log(
            `风格微调状态:\n` +
              `  素材: 旧稿 ${st.samples} · 作品 ${st.pieces} · 修改对 ${st.edits}\n` +
              `  适配卡: ${st.hasAdapter ? '✓ 已蒸馏' : '（未蒸馏，--distill）'}\n` +
              `  数据集: ${st.hasDataset ? '✓ 已生成' : '（未生成，--dataset）'}`,
          );
        }
        break;
      }
      case 'profile': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const sub = positional[0] || 'status';
        if (sub === 'export') {
          const r = exportProfile(w, flags.to ? String(flags.to) : '');
          console.log(
            `风格档案已导出 → ${r.file}（样本 ${r.samples}、修改记录 ${r.edits}${r.hasAdapter ? '、适配卡' : ''}）`,
          );
        } else if (sub === 'import') {
          if (positional.length < 2) throw new Error('用法: sculptor profile import <bundle.json>');
          const r = importProfile(w, positional[1]);
          console.log(
            `已导入合并：${r.dimsMerged} 维、样本 +${r.samplesAdded}、修改记录 +${r.editsAdded}（本地高置信维度未被动覆盖）`,
          );
        } else {
          const st = profileStatus(w);
          console.log(
            `风格档案状态:\n` +
              `  write ${st.write}/14 维 · read ${st.read}/7 维\n` +
              `  样本 ${st.samples} · 修改记录 ${st.edits} · 适配卡 ${st.hasAdapter ? '✓' : '（无）'}\n` +
              `  全局路径: ${st.globalPath || '（未设置 SCULPTOR_HOME；export 默认导出到工作区 vault/style-profile-export.json）'}`,
          );
        }
        break;
      }
      case 'quote': {
        const raw = positional.join(' ');
        if (!raw) throw new Error('用法: sculptor quote "<选中的原句>"');
        const q = parseQuoteArg(raw);
        if (!q) throw new Error('引用为空');
        console.log(
          `〔Sculptor 引用〕《${q}》\n修改指令：<在这里写你要怎么改，例如：这句太文艺，收一点>`,
        );
        break;
      }
      case 'hook': {
        const w = positional[0] || workspace;
        if (!w) throw new Error('用法: sculptor hook <工作区> [payload]');
        runHook(w, positional[1] || '');
        break;
      }
      case 'checklist': {
        const w = ws.resolveWorkspace(cfg, workspace);
        ws.ensureWorkspace(w);
        console.log(renderChecklist(ws.readState(w)));
        break;
      }
      case 'style': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        if (flags.memory) {
          const shot = buildStyleShot(w, { topic: String(flags.memory) });
          if (!shot) {
            console.log('（没有可检索的风格记忆：工作区还没有旧稿或编辑记录）');
          } else {
            console.log(`风格记忆检索「${flags.memory}」:`);
            if (!shot.samples.length) console.log('  旧稿: （无）');
            for (const s of shot.samples)
              console.log(
                `  [旧稿 ${s.score}] ${s.source}\n    ${s.text.slice(0, 80)}${s.text.length > 80 ? '…' : ''}`,
              );
            if (!shot.edits.length) console.log('  修改对: （无）');
            for (const e of shot.edits)
              console.log(
                `  [修改 ${e.score}] ${e.original} → ${e.changed}${e.intent ? `（${e.intent}）` : ''}`,
              );
            if (shot.associations?.length) console.log(`  联想库: ${shot.associations.join('、')}`);
          }
        }
        if (flags.extract) {
          const ex = await extractStyleFromSamples(w, cfg);
          console.log(`风格底稿提取：${ex.extracted} 份已提取，${ex.skipped} 份跳过/失败`);
        }
        if (flags.backfill) {
          const r = backfillFromContext(w);
          console.log(`已从对话日志回填 ${r.applied} 条风格信号（跳过 ${r.skipped} 条）`);
        }
        if (flags.pulses) {
          const pulses = recentPulses(w);
          if (!pulses.length) {
            console.log('（还没有风格脉搏：澄清/大纲/写作/修改时会自动记录）');
          } else {
            console.log('风格脉搏（最近记录）:');
            for (const p of pulses) console.log(`  · ${renderPulse(p)}`);
          }
        }
        if (flags.signals) {
          const log = implicitSignalLog(w);
          if (!log.length) {
            console.log('（还没有隐式风格信号流水：澄清每轮对话会自动记录）');
          } else {
            console.log('隐式风格信号流水（每轮对话被动采集）:');
            for (const s of log) {
              console.log(
                `  · 第 ${s.round} 轮 ${(s.ts || '').slice(11, 19)}：${s.text}${
                  s.dims?.length ? ` → ${s.dims.slice(0, 5).join('、')}` : ''
                }`,
              );
            }
          }
        }
        if (flags.export) {
          const dest = path.join(w, 'vault', 'style-profile.md');
          fs.writeFileSync(dest, renderStyleProfile(w) + '\n');
          console.log(`风格档案已导出 → ${dest}`);
        }
        const p = styleProgress(w);
        console.log(
          `风格档案进度:\n` +
            `  write（语言层）: 已学 ${p.write.learned}/${p.write.total} 维\n` +
            `  read（结构层）: 已学 ${p.read.learned}/${p.read.total} 维`,
        );
        for (const [style, s] of Object.entries(p)) {
          if (!s.top.length) continue;
          console.log(`\n${style === 'write' ? '语言层' : '结构层'}最近信号:`);
          for (const t of s.top) {
            console.log(
              `  · ${t.dim} → ${t.value}（置信 ${(t.confidence * 100).toFixed(0)}%${t.evidence?.length ? '，依据: ' + t.evidence.slice(-1)[0] : ''}）`,
            );
          }
        }
        break;
      }
      case 'style-vector': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, workspace));
        if (flags.refresh) {
          const r = await refreshStyleVector(cfg, w, { kind: 'manual', evidence: '手动刷新' });
          console.log(
            `已刷新风格向量：模式 ${r.mode} · 动态维度 ${r.dynamic} · 困惑度采样 ${r.samples}`,
          );
        }
        console.log(renderVectorSummary(vectorSummary(w)));
        break;
      }
      case 'outline': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await generateOutline(cfg, w);
        console.log(`《${r.outline.title}》 ${r.outline.sections.length} 节\n`);
        r.outline.sections.forEach((s, i) =>
          console.log(
            `${i + 1}. ${s.heading}（${s.function}）\n   ${(s.keyPoints || []).join(' / ')}`,
          ),
        );
        break;
      }
      case 'outline-review': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const state = ws.readState(w);
        const r = await reviewOutline(cfg, w, { outline: state.outline || null });
        if (r.revised) {
          state.outline = r.outline;
          ws.writeState(w, state);
          console.log(`已按评审自动修订大纲（${r.report.score} 分）。`);
        }
        console.log(renderOutlineReview(r.report, { revised: r.revised }));
        break;
      }
      case 'style-eval': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await evaluateStyleFidelity(cfg, w, { file: flags.file || null });
        const fb = applyEvalFeedback(w, r);
        console.log(renderStyleEval(r));
        if (fb.applied) console.log(`已把 ${fb.applied} 条漂移证据写回风格档案。`);
        break;
      }
      case 'write': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const index = flags.section !== undefined ? Number(flags.section) : null;
        const r = await writeSection(cfg, w, {
          index,
          force: Boolean(flags.force),
        });
        console.log(`已写入 ${r.sections} 节 → ${r.draftFile}`);
        for (const s of r.report) {
          console.log(
            `  ${s.index}. ${s.heading}：目标 ${s.target} 字 / 实际 ${s.actual} 字${s.expanded ? '（已扩写）' : ''}`,
          );
        }
        console.log(`合计 ${r.total} 字（目标 ${cfg.targetWords} 字）`);
        if (r.hint) console.log(`提示: ${r.hint}`);
        break;
      }
      case 'restyle': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await restyle(cfg, w, {
          direction: flags.direction ? String(flags.direction) : '',
          section: flags.section !== undefined ? Number(flags.section) : null,
          force: Boolean(flags.force),
        });
        console.log(`已按「${r.direction}」重写 ${r.sections} 节 → ${r.draftFile}`);
        for (const s of r.report) {
          if (s.skipped) {
            console.log(`  ${s.index}. ${s.heading}：跳过（本节为空）`);
          } else {
            console.log(`  ${s.index}. ${s.heading}：${s.oldLen} 字 → ${s.newLen} 字`);
          }
        }
        break;
      }
      case 'transform': {
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        const preset = positional[0];
        if (!preset || !Object.keys(PRESETS).some((k) => preset === k || preset.startsWith(k + ':'))) {
          throw new Error(`用法: sculptor transform <预设>，可用: ${Object.keys(PRESETS).join(' / ')}（tone 可用 tone:formal）`);
        }
        const r = await transform(cfg, w, {
          preset,
          tone: flags.tone ? String(flags.tone) : '',
          target: flags.target !== undefined ? Number(flags.target) : 0,
          section: flags.section !== undefined ? Number(flags.section) : null,
          force: Boolean(flags.force),
        });
        console.log(`已${r.preset === 'tone' ? '改语气' : PRESETS[r.preset].label} ${r.sections} 节 → ${r.draftFile}`);
        for (const s of r.report) {
          if (s.skipped) console.log(`  ${s.index}. ${s.heading}：跳过`);
          else console.log(`  ${s.index}. ${s.heading}：${s.oldLen} → ${s.newLen} 字（目标 ${s.target}）`);
        }
        break;
      }
      case 'history': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const list = listHistory(w);
        if (!list.length) {
          console.log('（还没有版本快照：write/restyle/redteam --fix/transform 会自动生成）');
        } else {
          console.log(`版本快照（${list.length} 份，新→旧）:`);
          for (const h of list) {
            console.log(
              `  ${list.indexOf(h) + 1}. ${h.ts || '?'} [${h.reason}] ${h.chars} 字 ${h.preview ? '— ' + h.preview : ''}`,
            );
          }
        }
        break;
      }
      case 'rollback': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const r = rollback(w, { index: Number(positional[0] || 1) });
        console.log(`已回滚到第 ${positional[0] || 1} 份快照（[${r.reason}] ${r.ts}，${r.chars} 字）→ draft.md`);
        break;
      }
      case 'genre': {
        const name = positional[0] || '';
        if (!name || name === 'list') {
          console.log(`文体库（${genreNames().length} 种）: ${genreNames().join('、')}`);
          console.log('查看规范: sculptor genre <名称>');
        } else if (GENRES[name]) {
          console.log(genreBrief(name));
        } else {
          throw new Error(`未知文体「${name}」。可用: ${genreNames().join('、')}`);
        }
        break;
      }
      case 'library': {
        // 子命令占用了 positional[0]，工作区统一走 --workspace 或 SCULPTOR_WORKSPACE
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        ws.ensureWorkspace(w);
        const sub = positional[0] || 'list';
        if (sub === 'list') {
          console.log(listLibrary(w));
        } else if (sub === 'scan') {
          const r = await distillAll(w, cfg);
          for (const x of r)
            console.log(
              `  ${x.category}: ${x.distilled ? `已蒸馏（${x.pieces} 篇）` : '（无作品）'}`,
            );
        } else if (sub === 'view') {
          if (positional.length < 2) throw new Error('用法: sculptor library view <类别>');
          console.log(viewCategory(w, positional[1]));
        } else if (sub === 'add') {
          if (positional.length < 2)
            throw new Error('用法: sculptor library add <file> [--category 类别]');
          const file = positional[1];
          const text = fs.readFileSync(file, 'utf8');
          const r = addPiece(w, {
            title: flags.title || path.basename(file, path.extname(file)),
            text,
            source: file,
            category: flags.category || '',
            session: flags.session || '',
          });
          console.log(`已归档 → ${r.file}（分类: ${r.category}）`);
        } else {
          throw new Error(`未知子命令「${sub}」。可用: list / scan / view / add`);
        }
        break;
      }
      case 'knowledge': {
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        ws.ensureWorkspace(w);
        const sub = positional[0] || 'list';
        const find = (q) => {
          const es = listEntries(w);
          return es.find((e) => e.id === q || normTitle(e.title) === normTitle(q));
        };
        if (sub === 'list') {
          const es = listEntries(w);
          if (!es.length) {
            console.log(
              '个人知识库为空。澄清时你提到读过的书/去过的地方会自动归纳收录；也可用 sculptor knowledge add 手动加入。',
            );
            break;
          }
          for (const e of es) {
            console.log(
              `• ${e.title}${e.author ? `（${e.author}）` : ''} [${e.type}] 使用 ${e.usageCount || 0} 次${(e.confidence || 0) < 0.7 ? ' ⚠待核实' : ''} · ${
                (e.createdAt || '').slice(0, 10) || ''
              }`,
            );
          }
        } else if (sub === 'add') {
          if (positional.length < 2)
            throw new Error(
              '用法: sculptor knowledge add <标题> [--author 作者] [--type book|place|theory|work] [--note 备注]',
            );
          const r = addEntry(w, {
            title: positional[1],
            author: flags.author || '',
            type: flags.type || 'book',
            note: flags.note || '',
          });
          console.log(r.created ? `已收录 → ${r.entry.id}` : `已存在（${r.entry.id}），未重复收录`);
        } else if (sub === 'remove') {
          if (positional.length < 2)
            throw new Error('用法: sculptor knowledge remove <标题或id>');
          const hit = find(positional[1]);
          if (!hit) throw new Error(`未找到「${positional[1]}」`);
          removeEntry(w, hit.id);
          console.log(`已移除「${hit.title}」`);
        } else if (sub === 'search') {
          if (positional.length < 2)
            throw new Error('用法: sculptor knowledge search <关键词>');
          const hits = matchKb(w, positional.slice(1).join(' '), { limit: 10 });
          if (!hits.length) {
            console.log('无匹配');
            break;
          }
          for (const h of hits) {
            console.log(
              `• 《${h.title.replace(/^《|》$/g, '')}》${h.author ? `（${h.author}）` : ''} [${h.type}] score=${h.score}${
                h.note ? ` — ${h.note.slice(0, 60)}` : ''
              }`,
            );
          }
        } else if (sub === 'view') {
          if (positional.length < 2) throw new Error('用法: sculptor knowledge view <标题或id>');
          const hit = find(positional[1]);
          if (!hit) throw new Error(`未找到「${positional[1]}」`);
          console.log(`# ${hit.title}（${hit.type}）`);
          console.log(
            `作者: ${hit.author || '—'}  来源: ${hit.source}  置信度: ${hit.confidence || '—'}${(hit.confidence || 0) < 0.7 ? '（待核实）' : ''}  使用: ${hit.usageCount || 0} 次`,
          );
          if (hit.note) console.log(`\n${hit.note}\n`);
        } else if (sub === 'export') {
          const r = exportKnowledge(w, flags.to ? String(flags.to) : '');
          console.log(`已导出 ${r.entries} 条知识 + ${r.asked} 条提问记录 → ${r.file}`);
          console.log('⚠ 知识库含个人阅读/经历，注意保管，不要上传到公开仓库。');
        } else if (sub === 'import') {
          if (positional.length < 2) throw new Error('用法: sculptor knowledge import <file.json>');
          const r = importKnowledge(w, positional[1]);
          console.log(`已导入 ${r.added} 条新知识（重复项跳过），${r.askedAdded} 条提问记录`);
        } else {
          throw new Error(`未知子命令「${sub}」。可用: list / add / remove / search / view / export / import`);
        }
        break;
      }
      case 'recommend': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const state = ws.readState(w);
        const r = recommendReadings(state, w, { sessionAsked: false });
        console.log(r || '（暂时没匹配到与你主题相近的思想库条目——再多说一点你的主题/立意试试）');
        break;
      }
      case 'academic': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const state = ws.readState(w);
        console.log('【学术论证链】（行文思路骨架）');
        console.log(academicNarrative(state));
        const gap = academicGap(state);
        if (!gap.ok) console.log(`\n缺口：${gap.missing.join('、')}（写作时会按论证链补全）`);
        const draft = path.join(w, 'draft.md');
        if (flags.file || fs.existsSync(draft)) {
          const text = fs.readFileSync(flags.file ? path.resolve(String(flags.file)) : draft, 'utf8');
          const scan = argumentScan(text);
          console.log('\n【论证完备性扫描】');
          for (const s of scan) {
            console.log(`  ${s.ok ? '✓' : '✗'} ${s.heading}${s.issues.length ? ` — ${s.issues.join('；')}` : ''}`);
          }
        } else {
          console.log('\n（还没有 draft.md；写作完成后可再跑一次看完备性）');
        }
        break;
      }
      case 'character': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const sub = positional[0] || 'list';
        if (sub === 'list') {
          const chars = listCharacters(w);
          if (!chars.length) {
            console.log('（还没有角色档案。小说/推理写作时，澄清里答"角色"会自动建档；也可 sculptor character add <名字>）');
            break;
          }
          for (const c of chars) {
            console.log(`• ${c.name}${c.mood ? `（情绪：${c.mood}）` : ''}${c.want ? ` — 想要：${c.want}` : ''}`);
          }
        } else if (sub === 'add') {
          if (positional.length < 2) throw new Error('用法: sculptor character add <名字> [--background 背景] [--want 想要的] [--fear 最怕的] [--secret 秘密] [--speech 说话方式]');
          const c = saveCharacter(w, {
            name: positional[1],
            background: flags.background || '',
            want: flags.want || '',
            fear: flags.fear || '',
            secret: flags.secret || '',
            speech: flags.speech || '',
            mood: flags.mood || '',
          });
          console.log(`角色档案已建 → vault/characters/${c.name}.json`);
        } else if (sub === 'view') {
          if (positional.length < 2) throw new Error('用法: sculptor character view <名字>');
          const c = loadCharacter(w, positional[1]);
          if (!c) throw new Error(`角色不存在: ${positional[1]}`);
          console.log(JSON.stringify(c, null, 2));
        } else if (sub === 'remove') {
          if (positional.length < 2) throw new Error('用法: sculptor character remove <名字>');
          const r = removeCharacter(w, positional[1]);
          console.log(`已移除角色 ${r.removed}`);
        } else if (sub === 'simulate') {
          if (positional.length < 2) throw new Error('用法: sculptor character simulate <名字> [--scene "场景"]');
          const scene = flags.scene || '一个关键场景：他/她必须做一个决定';
          const r = await simulateCharacter(cfg, w, { name: positional[1], scene });
          if (!r.ok) {
            console.log(r.hint);
            break;
          }
          console.log(`【角色预演：${r.name}】${r.fallback ? '（LLM 不可用，确定性兜底）' : ''}`);
          console.log(`心里想：${r.prediction.thoughts}`);
          console.log(`会说：${r.prediction.speech}`);
          console.log(`会做：${r.prediction.action}`);
          console.log(`情绪：${r.prediction.mood}`);
          console.log(`被推向：${r.prediction.nextPull}`);
        } else {
          throw new Error(`未知子命令「${sub}」。可用: list / add / view / remove / simulate`);
        }
        break;
      }
      case 'ingest': {
        if (!positional.length) throw new Error('用法: sculptor ingest <file...>');
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        ws.ensureWorkspace(w);
        const state = ws.readState(w);
        state.materials = state.materials || [];
        for (const f of positional) {
          const r = await extractInput(f, cfg);
          if (r.kind === 'text') {
            state.materials.push(`[文件 ${path.basename(f)}] ${r.text.slice(0, 2000)}`);
            console.log(`✓ ${f}（${r.source}，${r.text.length} 字）→ 素材`);
          } else {
            console.log(`✗ ${f}: ${r.hint || '无法提取'}`);
          }
        }
        ws.writeState(w, state);
        break;
      }
      case 'dictate': {
        if (!positional.length) throw new Error('用法: sculptor dictate <音频文件...> [--to-draft]');
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''));
        const state = ws.readState(w);
        state.materials = state.materials || [];
        const dictDir = path.join(w, 'vault', 'dictations');
        fs.mkdirSync(dictDir, { recursive: true });
        for (const f of positional) {
          const r = await transcribeAudio(path.resolve(f), cfg);
          if (!r.ok) {
            console.log(`✗ ${f}: ${r.hint}`);
            continue;
          }
          const ts = Date.now();
          const base = path.basename(f, path.extname(f)).replace(/[^\w\u4e00-\u9fff-]+/g, '-');
          const rawFile = path.join(dictDir, `${base}-${ts}.md`);
          fs.writeFileSync(rawFile, `# 口述素材 ${base}\n\n${r.text}\n`);
          state.materials.push(`[口述 ${path.basename(f)}] ${r.text.slice(0, 2000)}`);
          console.log(`✓ ${f}（voice，${r.text.length} 字）→ ${rawFile}，已加入素材`);
          if (flags['to-draft'] && cfg.apiKey) {
            const { chatWithRetry } = await import('./llm.js');
            const { DICTATE_DRAFT_PROMPT } = await import('./prompts.js');
            const draft = await chatWithRetry(
              cfg,
              [
                { role: 'system', content: '你是口述整理师：把口述内容整理成可直接写作的结构化草稿。' },
                { role: 'user', content: DICTATE_DRAFT_PROMPT(r.text) },
              ],
              { temperature: 0.5, maxTokens: 2500 },
            );
            const draftFile = path.join(dictDir, `${base}-${ts}-draft.md`);
            fs.writeFileSync(draftFile, draft.trim() + '\n');
            console.log(`口述草稿已生成 → ${draftFile}`);
          } else if (flags['to-draft'] && !cfg.apiKey) {
            console.log('（--to-draft 需要配置 SCULPTOR_LLM_API_KEY；已保留口述素材）');
          }
        }
        ws.writeState(w, state);
        break;
      }
      case 'export': {
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        ws.ensureWorkspace(w);
        const draft = path.join(w, 'draft.md');
        if (!fs.existsSync(draft)) throw new Error('没有 draft.md，先 sculptor write');
        const text = fs.readFileSync(draft, 'utf8');
        let out = '';
        if (flags.official) {
          if (!docxAvailable()) throw new Error('本机没有 python-docx，无法导出公文 docx');
          const dest = flags.docx ? path.resolve(String(flags.docx)) : path.join(w, 'draft-公文.docx');
          const state = ws.readState(w);
          const title = state.outline?.title || state.confirmed?.topic || '';
          out = exportOfficialDocx(text, dest, {
            redhead: Boolean(flags.redhead),
            title,
          });
          console.log(`已按 GB/T 9704-2012 排版导出公文 docx → ${out}${flags.redhead ? '（红头）' : ''}`);
          break;
        }
        if (flags.academic) {
          if (!docxAvailable()) throw new Error('本机没有 python-docx，无法导出学术 docx');
          const dest = flags.docx ? path.resolve(String(flags.docx)) : path.join(w, 'draft-学术.docx');
          out = exportAcademicDocx(text, dest);
          console.log(`已按学术论文排版导出 docx → ${out}`);
          break;
        }
        if (flags.docx) {
          out = exportDocx(text, path.resolve(String(flags.docx)));
          console.log(`已导出 docx → ${out}`);
        } else if (flags.html) {
          out = exportHtml(text, path.resolve(String(flags.html)));
          console.log(`已导出 HTML → ${out}`);
        } else if (flags.srt) {
          out = exportSrt(text, path.resolve(String(flags.srt)));
          console.log(`已导出字幕 SRT → ${out}`);
        } else if (flags.pdf) {
          out = exportPdf(text, path.resolve(String(flags.pdf)));
          console.log(`已导出 PDF → ${out}`);
        } else if (flags.md) {
          out = path.resolve(String(flags.md));
          fs.writeFileSync(out, text);
          console.log(`已导出 md → ${out}`);
        } else {
          if (docxAvailable()) {
            out = exportDocx(text, path.join(w, 'draft.docx'));
            console.log(`已导出 docx → ${out}`);
          } else {
            console.log('本机没有 python-docx，改用 md 导出:');
            out = path.join(w, 'draft.md');
            console.log(`  draft 即 md → ${out}`);
          }
        }
        break;
      }
      case 'cite': {
        const style = flags.style ? String(flags.style) : 'gbt7714';
        if (!citationStyles().includes(style)) {
          throw new Error(`未知引用格式「${style}」。可用: ${citationStyles().join(' / ')}`);
        }
        const entries = flags.file
          ? readEntriesFile(path.resolve(String(flags.file)))
          : parseEntries(positional[0]);
        if (!entries.length) throw new Error('没有可格式化的条目');
        console.log(formatReferences(entries, style).join('\n'));
        break;
      }
      case 'citations': {
        const w = ws.resolveWorkspace(cfg, workspace);
        ws.ensureWorkspace(w);
        if (flags.auto) {
          const { autoReferences } = await import('./rag.js');
          const r = autoReferences(w, { style: flags.style ? String(flags.style) : 'gbt7714' });
          console.log(
            r.file
              ? `已从检索回灌来源生成参考文献草稿（${r.refs} 条，${flags.style || 'gbt7714'}）→ ${r.file}`
              : '（没有检索回灌的来源，无法自动生成；可先 sculptor rag ingest）',
          );
        } else if (flags.append) {
          const draft = path.join(w, 'draft.md');
          if (!fs.existsSync(draft)) throw new Error('没有 draft.md，先 sculptor write');
          const style = flags.style ? String(flags.style) : 'gbt7714';
          const entries = readEntriesFile(path.resolve(String(flags.append)));
          const list = formatReferences(entries, style);
          const { snapshot } = await import('./history.js');
          snapshot(w, 'citations-append');
          const md = fs.readFileSync(draft, 'utf8').trimEnd();
          fs.writeFileSync(draft, `${md}\n\n## 参考文献\n\n${list.map((x) => `- ${x}`).join('\n')}\n`);
          console.log(`已追加 ${list.length} 条参考文献（${style}）→ ${draft}`);
        } else {
          const file = flags.file ? path.resolve(String(flags.file)) : path.join(w, 'draft.md');
          if (!fs.existsSync(file)) throw new Error(`找不到文稿: ${file}`);
          const cites = extractCitations(fs.readFileSync(file, 'utf8'));
          if (!cites.length) {
            console.log('（文稿中没有检测到《书名号》引文）');
          } else {
            console.log(`文中引文（${cites.length} 处）:`);
            for (const c of cites) console.log(`  · 《${c.title}》${c.context ? `（${c.context.slice(0, 50)}…）` : ''}`);
          }
        }
        break;
      }
      case 'redteam': {
        const w = ws.resolveWorkspace(cfg, workspace);
        if (flags.file) {
          const text = fs.readFileSync(flags.file, 'utf8');
          const report = audit(text);
          if (flags.proofread) report.proofread = proofScan(text);
          console.log(JSON.stringify(report, null, 2));
          process.exitCode = report.passed ? 0 : 1;
        } else {
          const r = await redteam(cfg, w, { fix: Boolean(flags.fix) });
          if (flags.proofread) {
            r.report.proofread = proofScan(fs.readFileSync(r.draftFile, 'utf8'));
          }
          console.log(JSON.stringify(r.report, null, 2));
          process.exitCode = r.report.passed ? 0 : 1;
        }
        break;
      }
      case 'dissect': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const r = await dissect(cfg, w, { file: flags.file || null });
        console.log(JSON.stringify(r.report, null, 2));
        break;
      }
      case 'absorb': {
        if (positional.length < 2) throw new Error('用法: sculptor absorb <工作区> <edit.json>');
        const w = ws.resolveWorkspace(cfg, positional[0]);
        const edit = JSON.parse(fs.readFileSync(positional[1], 'utf8'));
        const r = ws.absorbEdit(w, edit);
        console.log(`write ${r.writeUpdated} 维 + read ${r.readUpdated} 维已更新`);
        break;
      }
      case 'fingerprint': {
        const w = ws.resolveWorkspace(cfg, workspace);
        const fp = ws.refreshFingerprint(w);
        console.log(`风格指纹已刷新: ${fp.highConfidenceDimensions.length} 个高置信度维度`);
        break;
      }
      case 'doctor':
        await doctor(cfg, { ping: Boolean(flags.ping) });
        break;
      case 'mcp':
        await runMcpServer(io);
        break;
      case 'setup':
        await runSetup(flags);
        break;
      case 'credentials': {
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''), {
          create: true,
        });
        const candidates = discoverCredentials(process.env);
        if (flags.clear) {
          clearCredentials(w);
          console.log(`已清除工作区凭据 → ${credentialsFile(w)}`);
          break;
        }
        if (flags.use) {
          const idx = Number(flags.use) - 1;
          const c = candidates[idx];
          if (!c) throw new Error(`候选索引无效（1-${candidates.length}）`);
          const file = saveCredentials(w, c);
          console.log(`已采用 [${c.source}]（key ${redact(c.apiKey)}，${c.baseUrl}）→ ${file}`);
          break;
        }
        if (flags.ask) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
          console.log('检测到的可用凭据:');
          candidates.forEach((c, i) => console.log(`  ${i + 1}. ${describeCandidate(c)}`));
          console.log(`  0. 手动输入 API key（用于 ${cfg.baseUrl}）`);
          const ans = (await ask('选择编号或粘贴 key（回车跳过）: ')).trim();
          rl.close();
          if (/^\d+$/.test(ans)) {
            const n = Number(ans);
            if (n === 0) {
              const key = (await ask('粘贴 API key: ')).trim();
              if (!key) {
                console.log('未输入，取消。');
                break;
              }
              const file = saveCredentials(w, {
                baseUrl: cfg.baseUrl,
                apiKey: key,
                model: cfg.model,
                source: 'manual',
              });
              console.log(`已保存手动凭据（key ${redact(key)}）→ ${file}`);
            } else {
              const c = candidates[n - 1];
              if (!c) throw new Error(`候选索引无效（1-${candidates.length}）`);
              const file = saveCredentials(w, c);
              console.log(`已采用 [${c.source}]（key ${redact(c.apiKey)}）→ ${file}`);
            }
          } else if (ans) {
            const file = saveCredentials(w, {
              baseUrl: cfg.baseUrl,
              apiKey: ans,
              model: cfg.model,
              source: 'manual',
            });
            console.log(`已保存手动凭据（key ${redact(ans)}）→ ${file}`);
          } else {
            console.log('未保存（回车跳过）。');
          }
          break;
        }
        console.log(
          `当前生效: ${cfg.credentialsSource ? cfg.credentialsSource : cfg.apiKey ? '显式 SCULPTOR_LLM_API_KEY' : '（未配置）'}`,
        );
        if (!candidates.length) {
          console.log('未发现宿主凭据。可配置 SCULPTOR_LLM_API_KEY，或运行: sculptor credentials --ask');
        } else {
          console.log(`检测到 ${candidates.length} 个可用凭据:`);
          candidates.forEach((c, i) => console.log(`  ${i + 1}. ${describeCandidate(c)}`));
          console.log('采用: sculptor credentials --use <编号>；交互选择: --ask');
        }
        break;
      }
      case 'point-edit': {
        const instruction = positional[1] || extractInstruction(positional[0] || '');
        if (!positional[0] || !instruction)
          throw new Error(
            '用法: sculptor point-edit "<引用/原文>" "<修改指令>" [--dir 项目] [--file 文件]\n或: sculptor point-edit "〔Sculptor 引用〕《原句》\\n修改指令：…"',
          );
        const r = await pointEdit(cfg, ws.resolveWorkspace(cfg, flags.workspace || ''), {
          quote: positional[0],
          instruction,
          dir: flags.dir,
          file: flags.file,
        });
        console.log(`已定点修改: ${r.file}`);
        console.log(`- ${r.quote}`);
        console.log(`+ ${r.replacement}`);
        console.log(`风格吸收: write ${r.writeUpdated} 维 + read ${r.readUpdated} 维`);
        break;
      }
      case 'roundtrip': {
        // 文本在 positional[0]，工作区只认 --workspace，避免把文本当目录创建。
        const w = ws.ensureWorkspace(ws.resolveWorkspace(cfg, flags.workspace || ''), { create: true });
        const arg = String(positional[0] || '').trim();
        let file = null;
        if (flags.file) file = path.resolve(String(flags.file));
        else if (arg) {
          try {
            if (fs.statSync(arg).isFile()) file = path.resolve(arg);
          } catch {}
        }
        const text = file ? '' : arg;
        const r = await roundtripCheck(cfg, w, { text, file });
        console.log(renderRoundtrip(r));
        break;
      }
      case 'probe': {
        const text = flags.text || positional.join(' ');
        if (!text) throw new Error('用法: sculptor probe "<任务描述>"');
        console.log(JSON.stringify(probeTask(text), null, 2));
        break;
      }
      default:
        console.error(`[sculptor] 未知命令: ${cmd}`);
        console.error('[sculptor] 提示：如果是新命令（如 web），先 git push 并运行更新器 bash ~/.codex/skills/sculptor/scripts/update.sh，再重试。');
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    printError(err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
