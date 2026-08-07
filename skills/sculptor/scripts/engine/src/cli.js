#!/usr/bin/env node
// Sculptor Agent CLI 入口。
import fs from 'node:fs';
import path from 'node:path';
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
import { buildStyleShot } from './style-memory.js';
import { restyle } from './restyle.js';
import { runHook } from './hook.js';
import { renderChecklist } from './interview.js';
import { agentStep, agentInteractive } from './director.js';
import { listLibrary, viewCategory, addPiece, distillAll } from './library.js';
import { extractInput, exportDocx, exportOfficialDocx, docxAvailable } from './io.js';
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

const HELP = `Sculptor Agent v0.9 — 完整写作 Agent（导演模式 · 风格保真闭环 · 读者交锋 · 持续微调 · 事实核查 · 多模态）

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
  sculptor redteam [--fix] [工作区]   反 AI 审计（可选 LLM 修订）
  sculptor redteam --file x.md        直接审计任意文件
  sculptor style-eval [--file x.md] [工作区]  风格保真评估：这篇像不像你（对照你的旧稿/修改记录打分）
  sculptor outline-review [工作区]    大纲评审：评审当前大纲（低分时自动给出修订版，仍需你确认）
  sculptor audience [--file x.md] [--quick] [工作区]  读者群像：8 个"第一读者"的感性反馈
  sculptor debate [--file x.md] [--quick] [工作区]    读者交锋：分歧最大的 3 位读者互看意见后收敛出共识/争议/优先级
  sculptor dissect [--file x.md] [工作区]  感性解剖 5 维度
  sculptor fact-check [--file x.md] [工作区]  事实核查：数字/年代/引文/人名/机构 → material/common/verify 分级
  sculptor quote "<原句>"             生成可粘贴的「Sculptor 引用」块
  sculptor hook <工作区> [payload]    宿主生命周期钩子 → 观察日志 + 压缩守卫
  sculptor checklist <工作区>         渲染需求访谈确认清单（不消耗 LLM）
  sculptor style [--memory 查询] [--export] [--backfill] [--extract] [工作区]
                                     风格档案进度；--memory 预览按论题检索到的旧稿与修改对；--export 导出人类可读档案（vault/style-profile.md）；--backfill 回填对话日志；--extract 提取风格底稿
  sculptor style-adapter [--distill] [--dataset [out.jsonl]] [--lora] [工作区]
                                     风格持续微调：--distill 蒸馏风格适配卡（最高优先级注入）；--dataset 生成偏好对 JSONL；--lora 提交微调（未配置端点时给出本地 LoRA 指引）
  sculptor genre [名称]               文体库：结构骨架 + 行文规范（公文/合同/通知/纪要/报告/议论文/散文/演讲稿/记叙文）
  sculptor library [工作区]           个人写作库：查看分类作品与蒸馏 skill
  sculptor library scan [工作区]      蒸馏每类作品的"个人写作 skill"（vault/skills/personal/）
  sculptor library view <类别> [工作区]  查看某类的蒸馏 skill 与作品清单
  sculptor library add <file> [--category 类别] [--session 标识] [工作区]  归档一篇作品（自动分类）
  sculptor ingest <file...> [工作区]  多模态输入：docx/xlsx/图片/md → 提取成素材
  sculptor export [--docx out.docx] [--md out.md] [工作区]  把 draft.md 导出为 docx/md
  sculptor export --official [--redhead] [--docx out.docx] [工作区]  按 GB/T 9704-2012 公文排版导出 docx
  sculptor absorb <工作区> <edit.json>   吸收定点修改进风格档案
  sculptor fingerprint <工作区>       刷新压缩守卫风格指纹
  sculptor panel [state.json]         渲染玻璃面板
  sculptor status [工作区]            工作区摘要
  sculptor doctor [--ping]            自检（可选连通性测试）
  sculptor mcp                       启动 MCP stdio 服务器（供 Codex/Claude Code/OpenCode 调用）
  sculptor setup [--dry-run] [--dir 项目] [--engine 引擎路径] [--hosts codex,claude,opencode]
                                     自动接入：检测宿主→原生注册→装 skill→复用本机凭据
  sculptor point-edit "<引用/原文>" "<修改指令>" [--dir 项目] [--file 文件]
                                     深度定点修改：只改选中的那一处，吸收进风格档案
  sculptor probe "<任务描述>"         生态位探测：该不该让 Sculptor 主动介入

环境变量（可选，默认指向 DeepSeek）:
  SCULPTOR_LLM_BASE_URL  SCULPTOR_LLM_API_KEY  SCULPTOR_LLM_MODEL
  SCULPTOR_LLM_MAX_TOKENS  SCULPTOR_LLM_TIMEOUT_MS  SCULPTOR_WORKSPACE
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
  console.error(`[sculptor] ${err.message}`);
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
        const w = ws.resolveWorkspace(cfg, workspace);
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
        const w = ws.resolveWorkspace(cfg, workspace);
        if (flags.once) {
          const r = await clarifyOnce(cfg, w, { input: io.input });
          console.log(JSON.stringify(r, null, 2));
        } else {
          await clarifyInteractive(cfg, w);
        }
        break;
      }
      case 'interview': {
        const w = ws.resolveWorkspace(cfg, workspace);
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
      case 'ingest': {
        if (!positional.length) throw new Error('用法: sculptor ingest <file...>');
        const w = ws.resolveWorkspace(cfg, flags.workspace || '');
        ws.ensureWorkspace(w);
        const state = ws.readState(w);
        state.materials = state.materials || [];
        for (const f of positional) {
          const r = extractInput(f, cfg);
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
        if (flags.docx) {
          out = exportDocx(text, path.resolve(String(flags.docx)));
          console.log(`已导出 docx → ${out}`);
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
      case 'redteam': {
        const w = ws.resolveWorkspace(cfg, workspace);
        if (flags.file) {
          const text = fs.readFileSync(flags.file, 'utf8');
          const report = audit(text);
          console.log(JSON.stringify(report, null, 2));
          process.exitCode = report.passed ? 0 : 1;
        } else {
          const r = await redteam(cfg, w, { fix: Boolean(flags.fix) });
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
      case 'probe': {
        const text = flags.text || positional.join(' ');
        if (!text) throw new Error('用法: sculptor probe "<任务描述>"');
        console.log(JSON.stringify(probeTask(text), null, 2));
        break;
      }
      default:
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
