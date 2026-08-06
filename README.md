# Sculptor Agent

深度协作写作 Agent：可装入 **Codex / Claude Code / OpenCode / Cursor** 的跨平台 skill 包，承上启下——观察主对话、动态澄清、建立大纲、按你的双风格写作、红队审计，产出交给下游 Agent（剪辑、发布、PPT）。

> Agent 还是 Skill？——**Skill 优先，Agent 级协议**。分发靠 skill 包（目录即产品），深度靠协议（state.json / requests.jsonl / 风格金库）。

## 快速开始（一键安装）

```bash
# 方式一：一行命令（curl | bash）
curl -fsSL https://raw.githubusercontent.com/sculptor-agent/sculptor-agent/main/install.sh | bash

# 方式二：git clone
git clone https://github.com/sculptor-agent/sculptor-agent
cd sculptor-agent && ./install.sh --setup-dir ~/我的写作项目
```

装好后在你的写作项目里：

```bash
sculptor setup          # 自动接入：检测宿主→原生注册→装 skill→复用本机凭据（目录级）
export SCULPTOR_LLM_API_KEY=sk-xxx   # 或让 setup 自动发现
sculptor init && sculptor clarify
```

深度定点修改：在 md 文档里选中一句话 → `sculptor point-edit "原句" "指令" --dir 项目`（macOS 可装右键服务，见 extras/）。

## 双形态

- **Skill 形态**（本包 `skills/sculptor/`）：宿主 agent 按 SKILL.md 指导完成写作工作流，零安装、零依赖。
- **完整 Agent 形态**（[agent/](agent/README.md)）：独立 Node CLI `sculptor`，自带澄清/大纲/写作/红队/解剖全工作流 + LLM 连接，并提供 **MCP stdio 服务器**——Codex、Claude Code、OpenCode 通过标准 MCP 调用它，对话仍由宿主主导，Sculptor 只负责写作与风格。**只写自己的工作区，绝不碰宿主配置。**

## 共存与退让（不与其他 agent 打架）

- **主权顺序**：用户指令 > 宿主当前动作 > Sculptor。宿主在做任何事时，Sculptor 不插入、不抢话。
- **写前校验**：改用户文件前重读文件；目标原文已被外部改动 → 中止退让，绝不覆盖（point-edit / write 均已实现并发守卫）。
- **地盘隔离**：只用 `.sculptor/` 与用户明确指定的文件，不碰其他 agent 的配置/存储/锁文件。
- **MCP 被动**：不观察、不自动运行、不主动出现；宿主不调用就不执行。

## 生态位与主动合作（退让不等于边缘化）

- **主动感知**：任务落到写作生态位（长文/风格/结构/定点修改）时，宿主用 `sculptor probe "<任务>"` 判断，主动提议 Sculptor 介入——不必等用户点名。
- **提议一次、可拒绝**：一句话说清能做什么，被拒即完全退让，不纠缠。
- **合作不接管**：Sculptor 只负责写作工作流与风格，对话仍由宿主主导；缺信息时反向请宿主代问。

安装完整 Agent：

```bash
./scripts/install-agent.sh                  # CLI → ~/.local/bin/sculptor
./scripts/install-agent.sh --mcp-codex      # 打印 Codex 的 MCP 注册片段（不写文件）
```

## 独特资产

- **风格向量引擎**：3D 向量（个人数据集 512 维 / 写作偏离 128 维 / 注意力焦点）+ 14 维度画像 + 从每次修改中在线学习。详见 [skills/sculptor/references/style-vectors.md](skills/sculptor/references/style-vectors.md)。
- **双风格模型**：人想写的（write-style）≠ 人想听的（read-style），分开采集、分开注入。
- **感性解剖**：5 维度（立场导向 / 局限边界 / 困惑混乱 / 多视角代入 / 风格兑现度），把文本隐藏的感性结构照亮给作者。详见 [skills/sculptor/references/sensibility.md](skills/sculptor/references/sensibility.md)。
- **反 AI 痕迹硬规则**：零容忍黑名单、重复比喻/句式禁令、人类化统计指标。详见 [skills/sculptor/references/anti-ai.md](skills/sculptor/references/anti-ai.md)。
- **压缩守卫**：上下文压缩前把风格指纹写回 vault，记忆会丢、风格不丢。

## 安装

```bash
git clone <repo-url> sculptor-agent
cd sculptor-agent
./scripts/install.sh --all
```

在项目里初始化工作区：

```bash
./scripts/install.sh init .        # 生成 .sculptor/ 工作区
./scripts/install.sh hooks         # 可选：把观察者 hooks 接入 Codex config.toml
```

skill 是自包含的（SKILL.md + references + scripts + hooks + 模板都在一个目录里），
装到任何宿主都是一整份，路径不会断。

## 工具链（零依赖 Node CLI）

`skills/sculptor/scripts/sculptor.mjs`，四个常用子命令：

```bash
node scripts/sculptor.mjs panel .sculptor/protocol/state.json   # 玻璃面板：白话进度
node scripts/sculptor.mjs absorb .sculptor/vault edit.json      # 定点修改 → 吸收进风格档案
node scripts/sculptor.mjs fingerprint .sculptor/vault           # 压缩守卫：刷新风格指纹
node scripts/sculptor.mjs status .sculptor                      # 工作区摘要
```

观察者 hooks 自动把会话事件写入 `.sculptor/protocol/context.jsonl`，
压缩恢复时凭 context + state + 风格指纹续写，风格不丢。

## 使用示例

- "帮我写一篇演讲稿，要有我的风格" → 观察 → 动态澄清 → 大纲 → 双风格写作 → 红队 → 交付
- "把这段改成更像我的语气" → 定点修改协议，改完吸收进风格档案
- "分析这篇文章的立场和情感结构" → 感性解剖报告

## 架构

```
Observer（观察） → Orchestrator（编排） → Requester（反求） → Producer（生产）
      │                    │                    │                  │
  读对话上下文      澄清/大纲/写作/红队      反向让宿主提问/      双风格成稿
  提取素材与风格       状态机                  读图/转录          交下游 Agent
```

## 分发渠道

1. **GitHub 开源仓库**：目录即产品，clone 即装。
2. **Skill 市场**：Codex 个人插件、Claude Code marketplace、OpenCode registry、agentskillsindex。
3. **一键安装**：`curl -fsSL <url>/install.sh | bash` 或 npm 包。
4. **宿主生态**：WorkBuddy 数字员工（企业场景）、Cursor 规则。
5. **增值层**（后续）：风格金库模板市场、团队风格分析、感性解剖报告订阅。

## 路线图

- P0：跨平台 skill 包 + 协议层 + 安装器 ✅
- P1（当前）：玻璃面板渲染、定点修改吸收、压缩守卫、观察者日志 ✅
- P1 收尾：Observer 接入宿主 hooks ✅（已修复为 app 安全：默认注释，CLI 用 --hermes）
- P2（本轮）：完整 Agent 运行时 + MCP 协作 ✅（agent/，27 项离线 e2e 全绿）
- P3：多 Agent 交付协议、风格市场、团队风格分析

## License

MIT
