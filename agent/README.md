# Sculptor Agent（完整 Agent 形态）

零依赖 Node CLI：独立运行完整写作工作流，也提供 **MCP stdio 服务器** 供 Codex / Claude Code / OpenCode 等宿主调用。
核心承诺：**只写自己的工作区（.sculptor/），不碰任何宿主配置**——与常见 agent 无冲突。

## 安装（真实安装，默认零侵入）

```bash
cd sculptor-agent
./scripts/install-agent.sh                 # CLI → ~/.local/bin/sculptor
./scripts/install-agent.sh --mcp-codex     # 打印 Codex 的 MCP 配置（不写文件）
./scripts/install-agent.sh --mcp-codex --write-codex   # 显式写入（先备份）
```

配置环境变量（默认指向 DeepSeek）：

```bash
export SCULPTOR_LLM_API_KEY=sk-xxx
export SCULPTOR_LLM_BASE_URL=https://api.deepseek.com/v1   # 可选
export SCULPTOR_LLM_MODEL=deepseek-v4-flash                 # 可选
export SCULPTOR_TARGET_WORDS=1000                           # 可选：目标字数（默认 1000）
```

## 独立运行（CLI）

```bash
sculptor init                 # 初始化 .sculptor/ 工作区
sculptor clarify              # 交互澄清（一次一问、带建议、可随时"你决定"结束）
sculptor outline              # 生成大纲（素材门槛未过会拒绝）
sculptor write                # 逐节写作 → draft.md（双风格注入 + 反 AI 硬规则）
sculptor redteam --fix        # 反 AI 审计 + LLM 修订
sculptor dissect              # 感性解剖 5 维度
sculptor panel / status       # 玻璃面板 / 工作区摘要
sculptor doctor --ping        # 自检 + LLM 连通
sculptor point-edit "原句" "修改指令" --dir 项目   # 深度定点修改：只改选中的那一句
```

## 自动接入（零手动配置）

```bash
sculptor setup                 # 检测本机宿主 → 原生注册 → 装 skill → 复用本机凭据
sculptor setup --dry-run       # 先看计划，不写任何文件
```

setup 会：

1. **检测本机宿主**：Codex / Claude Code / OpenCode（走各宿主原生命令：`claude mcp add`、`opencode mcp add`、Codex 项目级配置）；
2. **自动接入原引擎**：若检测到 sculptor 引擎仓库，自动复制 MCP 代码并注册 `npm run sculptor:mcp`；
3. **安装 skill** 到项目 `.codex/skills/`（项目级，只有本项目对话可用）；
4. **自动发现凭据**：从环境变量 / 项目 `.env.local` / `~/.codex/config.toml` 复用 DEEPSEEK 配置，写入引擎 `.env.local`（权限 0600，报告中明确说明来源）；
5. 幂等：重复运行自动跳过已存在项。

设计遵循开源 agent 惯例（caveman/TLDR：检测全部宿主逐个走原生安装路径；Claude Code / OpenCode 的 `mcp add` CLI）。**默认只做项目级接入**，不污染其他对话与项目。

## 与其他 Agent 配合（MCP）

```bash
sculptor mcp                   # 启动 stdio MCP 服务器
```

Codex 配置片段（`~/.codex/config.toml`）：

```toml
[mcp_servers.sculptor]
command = "/path/to/sculptor"
args = ["mcp"]
```

Claude Code 项目 `.mcp.json`：

```json
{ "mcpServers": { "sculptor": { "command": "/path/to/sculptor", "args": ["mcp"] } } }
```

宿主 agent 通过 11 个 MCP 工具调用 Sculptor：`init / panel / status / clarify_step / outline /
write_section / write_all / redteam / dissect / absorb / fingerprint`。对话仍由宿主主导，
Sculptor 只负责写作工作流与风格——这就是"承上启下"的协作模型。

## 可靠性设计

- LLM 客户端：超时、指数退避重试、空响应重试（推理模型 token 用尽场景）。
- 素材门槛：主题/立场/素材不足时拒绝生成大纲，不硬写。
- 字数硬约束：大纲按节分配字数；每节写后核对，不足 60% 自动扩写（扩写加细节，不注水）。
- 反"假大空"：写作提示词强制具体的人/事/画面/细节/引文，禁止口号堆砌。
- 反 AI 红队：黑名单、重复比喻、重复句式、句长/段落/句首/TTR 统计，全部确定性检查。
- 失败可恢复：每个阶段写入 state.json，随时 `sculptor status` 查看进度。
- 无冲突保证：所有写入都在工作区内；宿主配置文件只在显式 `--write` 且备份后才会被改。

## 测试

```bash
npm test    # 等价于 node test/e2e.mjs
```

离线全链路：模拟 LLM 跑通 澄清→大纲→写作→红队→修订→解剖 + MCP 握手，27 项断言。
