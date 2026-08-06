# Sculptor Engine MCP（方案 1：协议反向接入原引擎）

> 注意：本目录的接入目标是"你已有的 sculptor 引擎仓库"。文中的
> `/Users/wallace/sculptor` 是作者本机示例路径，使用时替换成你自己的仓库路径
> （`bash apply.sh <你的仓库路径>`）。这个接入是可选的——没有引擎仓库时，
> `sculptor setup` 会自动使用自带的轻量引擎。

让"完整 Agent = 原引擎 + 协议层"真正成立：把 `/Users/wallace/sculptor` 里
**已经写好的全部深度**（`SculptorOrchestrator` 状态机、14 维风格提取、风格向量、
读者模拟、反 AI 红队、格式多样性、编辑吸收）以标准 **MCP stdio** 暴露给
Codex / Claude Code / OpenCode。

## 为什么这么做

- skill 是壳：只有指令，没有代码深度。
- bang 里的 agent 包是精简版：方法在提示词里，深度有限。
- **原引擎是完整 agent**：489 个单测、DeepSeek 已修复、风格向量梯度学习都在里面。
- 方案 1 = 在原引擎外面加一层 MCP，让它能被任何宿主调用。承上启下，深度全部复用。

## 工具（10 个）

| 工具 | 复用原引擎 |
| --- | --- |
| `init` | `SculptorOrchestrator` + PCS 快照恢复 |
| `input` | `processInput`（澄清/大纲/写作全由引擎驱动，宿主只传话） |
| `state` | `getState` → 玻璃面板 |
| `draft` | `state.outline` → 正文导出 |
| `projects` | 工作区快照列表 |
| `style_extract` | `extractStyle`（4 遍管线）→ vault 14 维 |
| `redteam` | `findBlacklistedPhrases` + `detectRepeatedFrames` + `checkFormatDiversity` + `detectAverageness` |
| `absorb_edit` | `captureEdit`（风格信号提取） |
| `fingerprint` | 风格指纹刷新（压缩守卫） |
| `dissect` | `generateReaderProfiles` + `simulateReading` + `critiqueStyle` |

## 触发纪律（必须遵守）

- **MCP 服务器是被动工具**：宿主不调用它就不执行任何动作；不观察对话、不自动运行、不主动出现。
- **注册只做项目级**（如 `zhi/.codex/config.toml`），**绝不写全局** `~/.codex/config.toml`——只有该项目内的对话能调用。
- **宿主（skill）只在两种情况下调用工具**：① 用户显式要求写作工作流；② 任务明显是长文写作且需要风格/协作。其他对话、项目、任务一律不调用。
- 每个写作任务用独立工作区，不与其他项目混用状态。

## 接入（一条命令）

```bash
bash apply.sh
```

脚本做四件事：复制 `src/mcp/` 进仓库、给 `sculptor-cli.ts` 注册 `mcp` 子命令、
添加 `npm run sculptor:mcp`、跑 `type-check + test:unit` 验证。

> 本目录里的代码已经用原项目 tsc 严格类型检查通过（`tsconfig.check.json`）。

## 使用

```bash
cd /Users/wallace/sculptor
export DEEPSEEK_API_KEY=sk-xxx   # 或项目根放 .env.local
npm run sculptor:mcp
```

Codex 注册（**只写项目级配置**，例如 zhi 项目的 `.codex/config.toml`，先备份）：

```toml
[mcp_servers.sculptor-engine]
command = "/Users/wallace/sculptor/node_modules/.bin/tsx"
args = ["--tsconfig", "/Users/wallace/sculptor/tsconfig.json", "/Users/wallace/sculptor/src/mcp/server.ts"]
```

只有属于该项目的对话会加载这个 MCP；其他对话/项目完全不受影响。

## 工作区协议（与 skill 兼容）

每次 `input`/`style_extract` 后自动落盘：

- `.sculptor/pcs-<projectId>.json` — 引擎快照（可恢复会话）
- `.sculptor/protocol/state.json` — 玻璃面板
- `.sculptor/vault/write-style.json` — 风格档案（14 维）
- `.sculptor/vault/style-fingerprint.json` — 压缩守卫指纹
- `.sculptor/vault/edits.jsonl` — 修改记录

只写工作区，不碰宿主配置。
