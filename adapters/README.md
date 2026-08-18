# Stylotrace 跨宿主接入（Adapters）

Stylotrace 的**决策内核**只有一个：`agent/src` 里的导演状态机（Director）——正常流程走状态机，
用户天马行空时切换自由流程并动态重规划大纲。这个内核与宿主无关。

宿主只是"入口"。我们用一个内核 + 三种形态覆盖所有 CLI / IDE：

| 形态 | 是什么 | 决策接口 | 适用宿主 |
|---|---|---|---|
| **MCP** | `stylotrace mcp`，stdio JSON-RPC | `agent_step`（导演单步自主决策） | 几乎所有现代 Agent/IDE |
| **Skill** | `skills/stylotrace/SKILL.md` + 内嵌引擎 | 指令让宿主调用引擎 | Codex / Claude Code / OpenCode |
| **CLI** | `node …/engine/bin/stylotrace.js agent` | 导演模式 / `--once` 单步 | 任何有终端的宿主 |

> 关键：`agent_step` 与 `stylotrace agent` 是同一个导演决策循环的两个入口。
> 宿主只负责把用户消息转发进去，Stylotrace 自己决定下一步（ask / confirm_outline / working / deliver）。
> 因此无论从哪个宿主接入，"agent 的决策效果"是同一套内核，不打折。

## 接入矩阵

| 宿主 | 推荐接入 | 配置位置 / 命令 |
|---|---|---|
| Codex | Skill + MCP | `~/.codex/skills/stylotrace/`；`~/.codex/config.toml` 的 `[mcp_servers.stylotrace]` |
| Claude Code | Skill + MCP | `claude mcp add stylotrace -- node …/stylotrace.js mcp` 或 `.mcp.json` |
| Claude Desktop | MCP | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | MCP + Rules | `.cursor/mcp.json`；`.cursor/rules/stylotrace.mdc` |
| Windsurf | MCP + Rules | `.windsurf/mcp_config.json`；`.windsurf/rules/stylotrace.md` |
| OpenCode | Skill + MCP | `~/.config/opencode/` 的 skill 与 mcp |
| Hermes | MCP / CLI / Hermes skill | `~/.hermes/` 自备 skills 与 mcp；见 `adapters/hermes/` |
| 其他（Zed、Cline、Roo…） | MCP / CLI | 任何支持 MCP stdio 或终端的宿主 |

## 统一 MCP 命令

所有 MCP 片段都指向同一个引擎入口（先 `--global` 安装到 `~/.codex/skills/stylotrace`）：

```bash
node "$HOME/.codex/skills/stylotrace/scripts/engine/bin/stylotrace.js" mcp
```

各宿主的具体片段在 `adapters/mcp/`，规则适配在 `adapters/rules/`，Hermes 适配在 `adapters/hermes/`。
