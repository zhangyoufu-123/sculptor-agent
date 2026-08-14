# Stylotrace Agent（完整 Agent 形态）

零依赖 Node CLI：独立运行完整写作工作流，也提供 **MCP stdio 服务器** 供 Codex / Claude Code / OpenCode 等宿主调用。
核心承诺：**只写自己的工作区（.stylotrace/），不碰任何宿主配置**——与常见 agent 无冲突。

## 安装（真实安装，默认零侵入）

```bash
cd stylotrace
./scripts/install-agent.sh                 # CLI → ~/.local/bin/stylotrace
./scripts/install-agent.sh --mcp-codex     # 打印 Codex 的 MCP 配置（不写文件）
./scripts/install-agent.sh --mcp-codex --write-codex   # 显式写入（先备份）
```

配置环境变量（默认指向 DeepSeek）：

```bash
export STYLOTRACE_LLM_API_KEY=sk-xxx
export STYLOTRACE_LLM_BASE_URL=https://api.deepseek.com/v1   # 可选
export STYLOTRACE_LLM_MODEL=deepseek-v4-flash                 # 可选
export STYLOTRACE_TARGET_WORDS=1000                           # 可选：目标字数（默认 1000）
```

## 独立运行（CLI）

```bash
stylotrace init                 # 初始化 .stylotrace/ 工作区
stylotrace interview            # 需求访谈：多轮一问 + 实时确认清单 + 进度（推荐入口）
stylotrace clarify              # 轻量交互澄清（一次一问、带建议、可随时"你决定"结束）
stylotrace outline              # 生成大纲（素材门槛未过会拒绝）
stylotrace write                # 逐节写作 → draft.md（双风格注入 + 反 AI 硬规则）
stylotrace redteam --fix        # 反 AI 审计 + LLM 修订
stylotrace audience             # 读者群像：8 个"第一读者"的感性反馈（交付前强制）
stylotrace dissect              # 感性解剖 5 维度
stylotrace quote "选中的原句"    # 生成可粘贴的「Stylotrace 引用」块
stylotrace style                # 查看风格档案进度（证明风格被读到了）
stylotrace panel / status       # 玻璃面板 / 工作区摘要
stylotrace doctor --ping        # 自检 + LLM 连通
stylotrace point-edit "原句" "修改指令" --dir 项目   # 深度定点修改：只改选中的那一句
```

### 需求访谈（Interview）——与普通 AI 对话的本质区别

`stylotrace interview` 把澄清阶段变成**用户看得见的结构化多轮对话**：
每轮只问一个问题（带建议与选项），回答后立刻更新一张确认清单：

```text
Stylotrace 需求访谈 · 确认清单
✓ 主题（已确认）
✓ 立场/目的（已确认）
… 读者与场合 — 待确认
… 具体素材（≥2 条）（1/2）— 待确认
…
进度: 4/9（* 可选维度，用户连续两次说"你决定"可跳过）
```

进度和剩余项实时可见，最后一轮还会补问风格底稿（"你以前写过类似这样的文章吗？
发我一段同文体旧稿"），并在收尾时打包输出确认清单 + 风格档案进度 + 剩余步骤。
宿主（MCP）可调用 `interview_step` 拿到同样的结构化结果。

### 定点引用（Quote）——选中即改

在 md 文档里选中一句话 → 右键 → 复制 → 粘贴到 Stylotrace 对话：

```text
〔Stylotrace 引用〕《选中的原句》
修改指令：这句太文艺，收一点
```

`stylotrace quote "原句"` 可一键生成这个块；macOS 用户可装
`extras/Stylotrace 引用服务.workflow`（右键菜单服务），选中文字 → 右键 → 在 Stylotrace 中修改。
point-edit 会精确定位原文、只改那一处、并把修改吸收进风格档案。

### 读者群像（Audience）——交付前的感性把关

`stylotrace audience` 屏蔽作者视角，模拟 8 个"第一读者"（老教师/挑剔编辑/中学生/
挑剔评论家/焦虑家长/历史爱好者/随性读者/年轻作家）第一次读草稿的心理活动：
在哪里停下来、哪里走神、哪句记住了、最想对作者说什么。LLM 不可用时退化为
确定性反馈，保证这个环节永不缺席。

## 自动接入（零手动配置）

```bash
stylotrace setup                 # 检测本机宿主 → 原生注册 → 装 skill → 复用本机凭据
stylotrace setup --dry-run       # 先看计划，不写任何文件
```

setup 会：

1. **检测本机宿主**：Codex / Claude Code / OpenCode（走各宿主原生命令：`claude mcp add`、`opencode mcp add`、Codex 项目级配置）；
2. **自动接入原引擎**：若检测到 stylotrace 引擎仓库，自动复制 MCP 代码并注册 `npm run stylotrace:mcp`；
3. **安装 skill** 到项目 `.codex/skills/`（项目级，只有本项目对话可用）；
4. **自动发现凭据**：从环境变量 / 项目 `.env.local` / `~/.codex/config.toml` 复用 DEEPSEEK 配置，写入引擎 `.env.local`（权限 0600，报告中明确说明来源）；
5. 幂等：重复运行自动跳过已存在项。

设计遵循开源 agent 惯例（caveman/TLDR：检测全部宿主逐个走原生安装路径；Claude Code / OpenCode 的 `mcp add` CLI）。**默认只做项目级接入**，不污染其他对话与项目。

## 与其他 Agent 配合（MCP）

```bash
stylotrace mcp                   # 启动 stdio MCP 服务器
```

Codex 配置片段（`~/.codex/config.toml`）：

```toml
[mcp_servers.stylotrace]
command = "/path/to/stylotrace"
args = ["mcp"]
```

Claude Code 项目 `.mcp.json`：

```json
{ "mcpServers": { "stylotrace": { "command": "/path/to/stylotrace", "args": ["mcp"] } } }
```

宿主 agent 通过 17 个 MCP 工具调用 Stylotrace：`init / panel / status / clarify_step /
interview_step / outline / write_section / write_all / redteam / audience / dissect /
absorb / fingerprint / point_edit / quote / style_status / probe`。对话仍由宿主主导，
Stylotrace 只负责写作工作流与风格——这就是"承上启下"的协作模型。

### 风格可见性（Style）

用户的每一句话、每一条素材、每一次手动修改都会被动采集进
`vault/write-style.json`（语言层）与 `vault/read-style.json`（结构层），
每条信号都带证据。`stylotrace style` 随时可以查看"风格被读到了什么"：

```text
风格档案进度:
  write（语言层）: 已学 5/14 维
  read（结构层）: 已学 2/7 维
语言层最近信号:
  · imageryTendency → 善用比喻意象（置信 40%，依据: 比喻词）
  · sentencePreference → 短句为主（置信 40%，依据: 对话/素材句长偏短）
```

## 可靠性设计

- LLM 客户端：超时、指数退避重试、空响应重试（推理模型 token 用尽场景）。
- 素材门槛：主题/立场/素材不足时拒绝生成大纲，不硬写。
- 字数硬约束：大纲按节分配字数；每节写后核对，不足 60% 自动扩写（扩写加细节，不注水）。
- 反"假大空"：写作提示词强制具体的人/事/画面/细节/引文，禁止口号堆砌。
- 反 AI 红队：黑名单、重复比喻、重复句式、句长/段落/句首/TTR 统计，全部确定性检查。
- 失败可恢复：每个阶段写入 state.json，随时 `stylotrace status` 查看进度。
- 无冲突保证：所有写入都在工作区内；宿主配置文件只在显式 `--write` 且备份后才会被改。

## 测试

```bash
npm test    # 等价于 node test/e2e.mjs
```

离线全链路：模拟 LLM 跑通 访谈→澄清→大纲→写作→红队→修订→解剖→读者群像 + MCP 握手，
74 项断言（含 interview/audience/quote/style 提取/两行引用块/17 个 MCP 工具）。
