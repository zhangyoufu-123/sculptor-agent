// MCP stdio server：让 Codex / Claude Code / OpenCode 等宿主通过标准 MCP 调用 Sculptor。
// 协议：换行分隔的 JSON-RPC 2.0。宿主自己决定何时调用，Sculptor 不监听宿主任何事件。
import readline from 'node:readline';
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
import { runAudience, renderAudience } from './reader-gallery.js';
import { styleProgress } from './style.js';
import { buildStyleShot } from './style-memory.js';
import { restyle } from './restyle.js';
import { agentStep } from './director.js';

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
          serverInfo: { name: 'sculptor', version: '0.6.0' },
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
