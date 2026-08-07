// MCP stdio server：让 Codex / Claude Code / OpenCode 等宿主通过标准 MCP 调用 Sculptor。
// 协议：换行分隔的 JSON-RPC 2.0。宿主自己决定何时调用，Sculptor 不监听宿主任何事件。
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import * as ws from './workspace.js';
import { clarifyStep } from './clarify.js';
import { generateOutline } from './outline.js';
import { writeSection } from './write.js';
import { redteam } from './redteam.js';
import { dissect } from './dissect.js';
import { pointEdit } from './point-edit.js';
import { probeTask } from './observer.js';
import { interviewStep } from './interview.js';
import { runAudience, renderAudience, runDebate, renderDebate } from './reader-gallery.js';
import { styleProgress } from './style.js';
import { buildStyleShot } from './style-memory.js';
import { restyle } from './restyle.js';
import { agentStep } from './director.js';
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
import { proofread, renderProofread } from './proofread.js';
import { transform, PRESETS } from './transform.js';
import { listHistory, rollback, snapshot } from './history.js';
import { exportProfile, importProfile, profileStatus } from './profile.js';
import { extractCitations, formatReferences, readEntriesFile, citationStyles } from './citation.js';
import {
  buildSearchQueries,
  searchOnline,
  ingestSearchResults,
  requestHostSearch,
  ragStatus,
} from './rag.js';
import { originalityScan } from './originality.js';
import { runReview, renderReview } from './review.js';

const TOOLS = [
  {
    name: 'init',
    description: '初始化 Sculptor 工作区（.sculptor/）',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
  },
  {
    name: 'panel',
    description: '渲染玻璃面板（当前写作进度白话视图）',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'status',
    description: '显示工作区摘要',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'clarify_step',
    description: '澄清单步：传入用户最新消息，返回下一个问题（含建议与选项）',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        lastInput: { type: 'string' },
      },
      required: ['lastInput'],
    },
  },
  {
    name: 'agent_step',
    description:
      '导演单步（自主决策）：传入用户最新消息（可为空），Sculptor 自己决定下一步并执行——返回 ask（提问）/ confirm_outline（大纲待确认）/ working（自动推进进度）/ deliver（交付）。宿主只负责转发用户消息，写作流程由 Sculptor 主导。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, lastInput: { type: 'string' } },
    },
  },
  {
    name: 'interview_step',
    description: '需求访谈单步：传入用户最新消息，返回下一个问题 + 确认清单 + 进度 + 风格档案进度',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        lastInput: { type: 'string' },
      },
      required: ['lastInput'],
    },
  },
  {
    name: 'audience',
    description: '读者群像：8 个"第一读者"对草稿的感性反馈（交付前强制环节）',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        file: { type: 'string' },
        quick: { type: 'boolean' },
      },
    },
  },
  {
    name: 'reader_debate',
    description:
      '读者交锋（MAJ-EVAL 式）：分歧最大的 3 位"第一读者"互看意见后收敛出共识/争议/优先级——共识直接改，争议留给作者拍板。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        file: { type: 'string' },
        quick: { type: 'boolean' },
      },
    },
  },
  {
    name: 'fact_check',
    description:
      '事实核查：把成稿里的数字/年代/引文/人名/机构分级为 material（来自素材）/common（低风险）/verify（交付前必须核对）。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'proofread',
    description:
      '校对纠错：错别字/叠字/标点（确定性，毫秒级）+ 语病/搭配（LLM，配置密钥时启用），按 type/severity 分级。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'transform',
    description:
      '一键改写矩阵：preset 为 expand 扩写 / condense 缩写 / continue 续写 / polish 润色 / imitate 仿写 / tone 改语气（tone:formal|casual|warm|authoritative）。与 restyle 同退让协议。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        preset: { type: 'string' },
        target: { type: 'integer' },
        tone: { type: 'string' },
        section: { type: 'integer' },
        force: { type: 'boolean' },
      },
      required: ['preset'],
    },
  },
  {
    name: 'history',
    description: '版本快照列表（write/restyle/redteam-fix/transform 前自动生成，最多 30 份）。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'rollback',
    description: '回滚到第 N 份快照（1=最新）；回滚前先快照当前版本，保证可恢复。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, index: { type: 'integer' } },
    },
  },
  {
    name: 'profile_export',
    description: '导出全局风格档案 bundle（write/read 档案 + 样本 + 修改记录 + 适配卡）。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, to: { type: 'string' } },
    },
  },
  {
    name: 'profile_import',
    description: '导入合并风格档案 bundle（本地高置信维度不被动覆盖，证据并集）。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'citations',
    description:
      '引文管理：extract 提取文中《书名号》引文清单；append 把 refs.json 的参考文献附录（gbt7714/apa）追加到草稿。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        file: { type: 'string' },
        action: { type: 'string', enum: ['extract', 'append'] },
        refs: { type: 'string' },
        style: { type: 'string' },
      },
    },
  },
  {
    name: 'rag_search',
    description:
      '联网检索：对文稿/文本生成高价值查询（事实 verify 项、《引文》、年份数字）；配置 SCULPTOR_RAG_ENDPOINT 时直连检索并回灌，否则排队宿主代检（requests.jsonl）。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        text: { type: 'string' },
        topic: { type: 'string' },
      },
    },
  },
  {
    name: 'rag_ingest',
    description: '回灌宿主检索结果：[{query, results:[{title,url,snippet,source}]}] → 缓存 vault/rag-cache.json + 素材。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        results: { type: 'array', items: { type: 'object' } },
        file: { type: 'string' },
      },
    },
  },
  {
    name: 'originality',
    description:
      '原创性检查（确定性）：文内重复句、与个人写作库/旧稿的自我复用、模板句；交付前静默自动执行，此处可手动查看。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'review',
    description:
      '深度审阅（核心功能）：聚合红队审计 + 校对 + 事实核查 + 原创性 + 风格保真 + 读者群像/交锋，输出 P0 硬伤 / P1 建议 / P2 争议 / 亮点；fix=true 自动修复 P0 并复检。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        file: { type: 'string' },
        fix: { type: 'boolean' },
        quick: { type: 'boolean' },
      },
    },
  },
  {
    name: 'style_adapter',
    description:
      '风格持续微调基建：status 查看素材/适配卡/数据集；distill 蒸馏风格适配卡（写作时最高优先级注入）；dataset 生成偏好对 JSONL；lora 提交微调任务（未配置端点时给出本地 LoRA 指引）。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        action: { type: 'string', enum: ['status', 'distill', 'dataset', 'lora'] },
        outFile: { type: 'string' },
        model: { type: 'string' },
      },
    },
  },
  {
    name: 'quote',
    description: '生成可粘贴的〔Sculptor 引用〕块（选中原句 → 右键/粘贴 → 定点修改）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'style_status',
    description: '查看风格档案进度（已学维度 + 最近证据），确认风格被读到了',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'style_memory',
    description:
      '检索风格记忆：按论题/文体返回作者旧稿片段与亲手修改对（少样本注入素材），供宿主把作者原话喂给写作模型',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        topic: { type: 'string' },
        genre: { type: 'string' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'outline',
    description: '生成结构化大纲（素材门槛未过会报错）',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'write_section',
    description: '按大纲写一节（双风格注入 + 反 AI 硬规则）',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, index: { type: 'integer' } },
    },
  },
  {
    name: 'write_all',
    description: '按大纲写完所有节到 draft.md',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'restyle',
    description:
      '按新风格方向重写整篇草稿（或指定节）：direction 给一句话（如"更克制一点"），缺省用档案最近一条风格方向',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        direction: { type: 'string' },
        section: { type: 'integer' },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'redteam',
    description: '反 AI 审计（黑名单/重复比喻/重复句式/统计指标），可选 LLM 修订',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, fix: { type: 'boolean' } },
    },
  },
  {
    name: 'style_eval',
    description:
      '风格保真评估：对照作者本人的旧稿样本/亲手修改对打分，输出"像不像作者本人"的分数、最像/最不像的句子与可执行修订建议；LLM 失败时确定性统计兜底。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'outline_review',
    description:
      '大纲评审-修订回路：按立意贯穿/论点-功能匹配/逻辑递进/素材利用/篇幅分配/文体规范评审当前大纲，低分时自动给出修订版（是否采用由宿主/用户决定）。',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'dissect',
    description: '感性解剖：5 维度报告（立场/局限/困惑/多视角/风格兑现度）',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'absorb',
    description: '把一次定点修改吸收进风格档案',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        target: { type: 'string' },
        original: { type: 'string' },
        changed: { type: 'string' },
        intent: { type: 'string' },
        evidence: { type: 'string' },
        writeDims: { type: 'object' },
        readDims: { type: 'object' },
      },
      required: ['target'],
    },
  },
  {
    name: 'fingerprint',
    description: '刷新压缩守卫风格指纹',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'point_edit',
    description: '深度定点修改：给出选中原句与修改指令，只改那一处并吸收进风格档案',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        quote: { type: 'string' },
        instruction: { type: 'string' },
        dir: { type: 'string' },
        file: { type: 'string' },
      },
      required: ['quote', 'instruction'],
    },
  },
  {
    name: 'probe',
    description: '生态位探测：判断任务是否值得 Sculptor 主动介入（长文写作/风格/结构/定点修改）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function wsDir(args, cfg) {
  return ws.resolveWorkspace(cfg, args.workspace || '');
}

async function callTool(name, args, cfg) {
  switch (name) {
    case 'init':
      return {
        text: `工作区已初始化 → ${ws.ensureWorkspace(wsDir(args, cfg), { create: true })}`,
      };
    case 'panel': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      return { text: ws.renderPanel(`${w}/protocol/state.json`) };
    }
    case 'status': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      return { text: ws.statusReport(w) };
    }
    case 'clarify_step': {
      const w = wsDir(args, cfg);
      const r = await clarifyStep(cfg, w, { lastInput: args.lastInput || '' });
      return { text: JSON.stringify(r, null, 2) };
    }
    case 'agent_step': {
      const w = wsDir(args, cfg);
      const r = await agentStep(cfg, w, { lastInput: args.lastInput || '' });
      return { text: JSON.stringify(r, null, 2) };
    }
    case 'interview_step': {
      const w = wsDir(args, cfg);
      const r = await interviewStep(cfg, w, {
        lastInput: args.lastInput || '',
      });
      return { text: JSON.stringify(r, null, 2) };
    }
    case 'audience': {
      const w = wsDir(args, cfg);
      const r = await runAudience(cfg, w, {
        file: args.file || null,
        quick: Boolean(args.quick),
      });
      return { text: renderAudience(r) };
    }
    case 'reader_debate': {
      const w = wsDir(args, cfg);
      const r = await runDebate(cfg, w, {
        file: args.file || null,
        quick: Boolean(args.quick),
      });
      return { text: renderDebate(r) };
    }
    case 'fact_check': {
      const w = wsDir(args, cfg);
      const r = await factCheck(cfg, w, { file: args.file || null });
      return { text: renderFactCheck(r) };
    }
    case 'proofread': {
      const w = wsDir(args, cfg);
      const r = await proofread(cfg, w, { file: args.file || null });
      return { text: renderProofread(r) };
    }
    case 'transform': {
      const w = wsDir(args, cfg);
      const r = await transform(cfg, w, {
        preset: String(args.preset || ''),
        tone: String(args.tone || ''),
        target: args.target !== undefined ? Number(args.target) : 0,
        section: args.section !== undefined ? Number(args.section) : null,
        force: Boolean(args.force),
      });
      return {
        text:
          `已改写 ${r.sections} 节 → ${r.draftFile}\n` +
          r.report
            .map((s) =>
              s.skipped
                ? `${s.index}. ${s.heading}：跳过`
                : `${s.index}. ${s.heading}：${s.oldLen} → ${s.newLen} 字`,
            )
            .join('\n'),
      };
    }
    case 'history': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const list = listHistory(w);
      return {
        text: list.length
          ? `版本快照（${list.length} 份，新→旧）:\n` +
            list
              .map(
                (h, i) =>
                  `${i + 1}. ${h.ts || '?'} [${h.reason}] ${h.chars} 字${h.preview ? ' — ' + h.preview : ''}`,
              )
              .join('\n')
          : '（还没有版本快照）',
      };
    }
    case 'rollback': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const r = rollback(w, { index: Number(args.index || 1) });
      return { text: `已回滚到 [${r.reason}] ${r.ts}（${r.chars} 字）→ draft.md` };
    }
    case 'profile_export': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const r = exportProfile(w, args.to || '');
      return { text: `风格档案已导出 → ${r.file}（样本 ${r.samples}、修改记录 ${r.edits}）` };
    }
    case 'profile_import': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const r = importProfile(w, args.file || '');
      return {
        text: `已导入合并：${r.dimsMerged} 维、样本 +${r.samplesAdded}、修改记录 +${r.editsAdded}`,
      };
    }
    case 'citations': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const action = args.action || 'extract';
      if (action === 'append') {
        const draft = path.join(w, 'draft.md');
        if (!fs.existsSync(draft)) throw new Error('没有 draft.md');
        const style = args.style && citationStyles().includes(args.style) ? args.style : 'gbt7714';
        const entries = readEntriesFile(args.refs || '');
        const list = formatReferences(entries, style);
        snapshot(w, 'citations-append');
        const md = fs.readFileSync(draft, 'utf8').trimEnd();
        fs.writeFileSync(draft, `${md}\n\n## 参考文献\n\n${list.map((x) => `- ${x}`).join('\n')}\n`);
        return { text: `已追加 ${list.length} 条参考文献（${style}）` };
      }
      const file = args.file ? path.resolve(args.file) : path.join(w, 'draft.md');
      if (!fs.existsSync(file)) throw new Error(`找不到文稿: ${file}`);
      const cites = extractCitations(fs.readFileSync(file, 'utf8'));
      return {
        text: cites.length
          ? `文中引文（${cites.length} 处）:\n` + cites.map((c) => `· 《${c.title}》`).join('\n')
          : '（文稿中没有《书名号》引文）',
      };
    }
    case 'rag_search': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const queries = buildSearchQueries(args.text || '', {
        topic: args.topic || '',
      });
      if (!queries.length) return { text: '（没有可检索的高价值查询）' };
      if (cfg.ragEndpoint && cfg.ragApiKey) {
        const r = await searchOnline(cfg, queries);
        if (!r.searched) return { text: r.hint };
        const ing = ingestSearchResults(w, r.results);
        return { text: `直连检索命中并回灌 ${ing.ingested} 组结果（缓存 ${ing.cached} 条）` };
      }
      const r = requestHostSearch(w, queries, { purpose: 'mcp' });
      return {
        text: `已排队 ${r.queued} 条宿主检索请求（${r.requestId}）→ requests.jsonl；检索后调用 rag_ingest 回灌。`,
      };
    }
    case 'rag_ingest': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      let results = args.results;
      if (!results && args.file) {
        results = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'));
        if (!Array.isArray(results)) results = results.results;
      }
      const r = ingestSearchResults(w, results || []);
      return { text: `已回灌 ${r.ingested} 条检索结果（缓存 ${r.cached} 条）` };
    }
    case 'originality': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const file = args.file ? path.resolve(args.file) : path.join(w, 'draft.md');
      if (!fs.existsSync(file)) throw new Error(`找不到文稿: ${file}`);
      const r = originalityScan(fs.readFileSync(file, 'utf8'), w);
      return {
        text: `原创性检查：风险 ${r.risk}；文内重复 ${r.selfDuplicates.length}、自我复用 ${r.libraryOverlaps.length}、模板句 ${r.templateHits.length}`,
      };
    }
    case 'review': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const r = await runReview(cfg, w, {
        file: args.file ? path.resolve(args.file) : null,
        fix: Boolean(args.fix),
        quick: Boolean(args.quick),
      });
      return { text: renderReview(r.report) };
    }
    case 'style_adapter': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const action = args.action || 'status';
      if (action === 'status') {
        const st = adapterStatus(w);
        return {
          text:
            `素材: 旧稿 ${st.samples} · 作品 ${st.pieces} · 修改对 ${st.edits}\n` +
            `适配卡: ${st.hasAdapter ? '✓ 已蒸馏' : '（未蒸馏）'}\n` +
            `数据集: ${st.hasDataset ? '✓ 已生成' : '（未生成）'}`,
        };
      }
      if (action === 'distill') {
        const r = await distillStyleAdapter(cfg, w);
        if (!r.distilled) return { text: '没有可蒸馏的风格素材。' };
        return { text: `风格适配卡已蒸馏（${r.card.mode}）→ ${r.mdFile}\n${loadStyleAdapter(w, 900)}` };
      }
      if (action === 'dataset') {
        const r = buildStyleDataset(w, { outFile: args.outFile || null });
        return { text: `数据集已生成：${r.records} 条 → ${r.file}` };
      }
      if (action === 'lora') {
        const r = await submitFineTune(cfg, w, {
          file: args.outFile || null,
          model: args.model || null,
        });
        return { text: r.submitted ? `微调任务已提交：${r.jobId}` : r.hint };
      }
      throw new Error(`未知 style_adapter 动作: ${action}`);
    }
    case 'quote': {
      return {
        text: `〔Sculptor 引用〕《${String(args.text || '').trim()}》\n修改指令：<在这里写你要怎么改>`,
      };
    }
    case 'style_status': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const p = styleProgress(w);
      return {
        text:
          `风格档案: write 已学 ${p.write.learned}/${p.write.total} 维 · read ${p.read.learned}/${p.read.total} 维\n` +
          (p.write.top[0]
            ? `最近: ${p.write.top.map((t) => `${t.dim}→${t.value}`).join('、')}`
            : '（暂无信号，继续对话/修改会自动采集）'),
      };
    }
    case 'style_memory': {
      const w = wsDir(args, cfg);
      ws.ensureWorkspace(w);
      const shot = buildStyleShot(w, {
        topic: args.topic || '',
        genre: args.genre || '',
      });
      return {
        text: shot ? JSON.stringify(shot, null, 2) : '（没有可检索的风格记忆）',
      };
    }
    case 'outline': {
      const w = wsDir(args, cfg);
      const r = await generateOutline(cfg, w);
      return {
        text:
          `《${r.outline.title}》${r.outline.sections.length} 节\n` +
          r.outline.sections.map((s, i) => `${i + 1}. ${s.heading}（${s.function}）`).join('\n'),
      };
    }
    case 'write_section':
    case 'write_all': {
      const w = wsDir(args, cfg);
      const r = await writeSection(cfg, w, {
        index: name === 'write_section' ? (args.index ?? null) : null,
      });
      return { text: `已写入 ${r.sections} 节 → ${r.draftFile}` };
    }
    case 'restyle': {
      const w = wsDir(args, cfg);
      const r = await restyle(cfg, w, {
        direction: args.direction || '',
        section: args.section !== undefined ? Number(args.section) : null,
        force: Boolean(args.force),
      });
      return {
        text:
          `已按「${r.direction}」重写 ${r.sections} 节 → ${r.draftFile}\n` +
          r.report
            .map((s) =>
              s.skipped
                ? `${s.index}. ${s.heading}：跳过（空节）`
                : `${s.index}. ${s.heading}：${s.oldLen} → ${s.newLen} 字`,
            )
            .join('\n'),
      };
    }
    case 'redteam': {
      const w = wsDir(args, cfg);
      const r = await redteam(cfg, w, { fix: Boolean(args.fix) });
      const rep = r.report;
      return {
        text:
          `通过=${rep.passed} 黑名单=${rep.blacklistHits.length} 重复比喻=${rep.repeatedMetaphors.length} 重复句式=${rep.repeatedPatterns.length} 建议=${rep.suggestions.length}\n` +
          JSON.stringify(rep, null, 2),
      };
    }
    case 'style_eval': {
      const w = wsDir(args, cfg);
      const r = await evaluateStyleFidelity(cfg, w, { file: args.file || null });
      const fb = applyEvalFeedback(w, r);
      return {
        text:
          renderStyleEval(r) +
          (fb.applied ? `\n已把 ${fb.applied} 条漂移证据写回风格档案。` : ''),
      };
    }
    case 'outline_review': {
      const w = wsDir(args, cfg);
      const state = ws.readState(w);
      const r = await reviewOutline(cfg, w, { outline: state.outline || null });
      if (r.revised) {
        state.outline = r.outline;
        ws.writeState(w, state);
      }
      return { text: renderOutlineReview(r.report, { revised: r.revised }) };
    }
    case 'dissect': {
      const w = wsDir(args, cfg);
      const r = await dissect(cfg, w, { file: args.file || null });
      return { text: JSON.stringify(r.report, null, 2) };
    }
    case 'absorb': {
      const w = wsDir(args, cfg);
      const r = ws.absorbEdit(w, args);
      return {
        text: `write ${r.writeUpdated} 维 + read ${r.readUpdated} 维已更新`,
      };
    }
    case 'fingerprint': {
      const w = wsDir(args, cfg);
      const fp = ws.refreshFingerprint(w);
      return {
        text: `风格指纹已刷新: ${fp.highConfidenceDimensions.length} 个高置信度维度`,
      };
    }
    case 'point_edit': {
      const w = wsDir(args, cfg);
      const r = await pointEdit(cfg, w, {
        quote: args.quote || '',
        instruction: args.instruction || '',
        dir: args.dir,
        file: args.file,
      });
      return {
        text: `已定点修改: ${r.file}\n- ${r.quote}\n+ ${r.replacement}\n风格吸收: write ${r.writeUpdated} + read ${r.readUpdated}`,
      };
    }
    case 'probe': {
      return { text: JSON.stringify(probeTask(args.text || ''), null, 2) };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input });
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');
  for await (const line of rl) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'sculptor', version: '0.15.0' },
        },
      });
    } else if (
      msg.method === 'notifications/initialized' ||
      msg.method === 'notifications/cancelled'
    ) {
      // 通知无响应
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      try {
        const result = await callTool(msg.params.name, msg.params.arguments || {}, cfg);
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: result.text }],
            isError: false,
          },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `[sculptor] ${err.message}` }],
            isError: true,
          },
        });
      }
    } else if (msg.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `未知方法: ${msg.method}` },
      });
    }
  }
}
