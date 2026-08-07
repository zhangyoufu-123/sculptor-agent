# Sculptor Agent

深度协作写作 Agent：可装入 **Codex / Claude Code / OpenCode / Cursor** 的跨平台 skill 包，承上启下——观察主对话、动态澄清、建立大纲、按你的双风格写作、红队审计，产出交给下游 Agent（剪辑、发布、PPT）。

> Agent 还是 Skill？——**Skill 优先，Agent 级协议**。分发靠 skill 包（目录即产品），深度靠协议（state.json / requests.jsonl / 风格金库）。

## 快速开始（一键安装）

```bash
# 方式一：一行命令（curl | bash，目录级安装到当前项目）
curl -fsSL https://raw.githubusercontent.com/sculptor-agent/sculptor-agent/main/install.sh | bash

# 方式二：git clone
git clone https://github.com/sculptor-agent/sculptor-agent
cd sculptor-agent && ./install.sh --project ~/我的写作项目
```

skill 内嵌**完整 agent 引擎**，装完即用，无需单独安装 CLI。在你的写作项目里：

```bash
export SCULPTOR_LLM_API_KEY=sk-xxx    # 必配：默认 DeepSeek 端点
SCULPTOR=.codex/skills/sculptor/scripts/sculptor.mjs
node $SCULPTOR init && node $SCULPTOR agent         # 导演模式：主导全程，自动推进到交付
```

导演模式（**自主决策 · 主导对话**）：每次收到你的消息，Sculptor 自己决定下一步并执行——
澄清问完就生成大纲、大纲确认就逐节写作、写完就反 AI 审计、审完就请 8 位"第一读者"群像反馈、
最后交付；你不需要催"继续"，只在真正的决策点（主题/立场/素材/立意/论点/大纲确认）回答。
交付后说"整篇更克制一点"这类风格方向 → 全文自动按新方向重写并再走一轮审计与群像。
深度定点修改：选中一句话 → `node $SCULPTOR point-edit "原句" "指令" --dir 项目`（macOS 可装右键服务，见 extras/）。
宿主 agent（Codex / Claude Code / OpenCode）安装后可直接按 `SKILL.md` 自动调用全部流程。
公式化内容（公文/合同/通知/纪要/报告）：对话里说"写一份关于××的通知/合同"即自动按文体范式产出；
`node $SCULPTOR genre 合同` 可查看每种文体的结构规范；党政机关公文 15 文种
（请示/批复/函/通报/公告/通告/意见/决定/决议/命令/公报/议案…）按 GB/T 9704-2012 排版导出：
`node $SCULPTOR export --official [--redhead]` → A4 公文 docx（红头可选）。
风格保真评估：交付前自动对照你的旧稿与亲手修改记录给成稿打"像不像你"的分数，低分自动针对性修订；
`node $SCULPTOR style-eval` 手动运行。大纲评审：生成后自动按六条标准评审并自动微调（仍由你确认）。
读者交锋：8 位"第一读者"反馈后，分歧最大的 3 位互看意见、收敛出共识/争议/优先级
（`node $SCULPTOR debate`）。事实核查：把数字/年代/引文/人名/机构分级为
material/common/verify，交付前必看（`node $SCULPTOR fact-check`）。
风格持续微调：`node $SCULPTOR style-adapter --distill` 蒸馏风格适配卡（写作时最高优先级注入）、
`--dataset` 生成偏好对 JSONL、`--lora` 提交微调（或本地 `scripts/finetune/style_lora.py`，
Panza 式 <100 样本 + LoRA）。
个人写作库：交付后作品自动分类归档并蒸馏出"这类文体你的写法"，同类文章越写越像你；
`node $SCULPTOR library` 查看分类，`node $SCULPTOR library view 议论文` 查看蒸馏 skill。
多模态：对话里直接给 docx/xlsx/图片 文件路径即可自动提取素材；`node $SCULPTOR export` 把成稿导出为 docx。

## 双形态

- **Skill 形态（默认，完整引擎内嵌）**（本包 `skills/sculptor/`）：`scripts/engine/` 是
  agent 的完整快照（由 `scripts/sync-skill-engine.sh` 同步、CI 校验防漂移），
  `node scripts/sculptor.mjs <cmd>` 直接运行全部工作流——**装 skill 即装完整 agent，
  不依赖外部 CLI**。宿主 agent 按 SKILL.md 自动调用，或手动跑命令。
- **独立 CLI 形态（可选）**（[agent/](agent/README.md)）：`./install.sh --cli` 软链
  `sculptor` 到 `~/.local/bin`，方便命令行直用；同一引擎，另提供 **MCP stdio 服务器**
  （`node scripts/sculptor.mjs mcp`）——Codex、Claude Code、OpenCode 通过标准 MCP 调用，
  对话由宿主主导，Sculptor 只负责写作与风格。**只写自己的工作区，绝不碰宿主配置。**

## 共存与退让（不与其他 agent 打架）

- **主权顺序**：用户指令 > 宿主当前动作 > Sculptor。宿主在做任何事时，Sculptor 不插入、不抢话。
- **写前校验**：改用户文件前重读文件；目标原文已被外部改动 → 中止退让，绝不覆盖（point-edit / write 均已实现并发守卫）。
- **地盘隔离**：只用 `.sculptor/` 与用户明确指定的文件，不碰其他 agent 的配置/存储/锁文件。
- **MCP 被动**：不观察、不自动运行、不主动出现；宿主不调用就不执行。

## 生态位与主动合作（退让不等于边缘化）

- **主动感知**：任务落到写作生态位（长文/风格/结构/定点修改）时，宿主用 `sculptor probe "<任务>"` 判断，主动提议 Sculptor 介入——不必等用户点名。
- **提议一次、可拒绝**：一句话说清能做什么，被拒即完全退让，不纠缠。
- **合作不接管**：Sculptor 只负责写作工作流与风格，对话仍由宿主主导；缺信息时反向请宿主代问。

安装完整 Agent（可选 CLI / MCP）：

```bash
./install.sh --project ~/项目                # skill（含引擎）→ 项目 .codex/skills/sculptor
./install.sh --global                        # 或全局 → ~/.codex/skills/sculptor
./install.sh --cli                           # 额外软链独立 CLI
./install.sh --mcp-codex                     # 打印 Codex 的 MCP 注册片段（不写文件）
```

## 独特资产

- **需求访谈（Interview）**：多轮一问、带建议与选项，回答后实时刷新确认清单与进度，
  收尾打包"需求 + 风格档案 + 剩余步骤"，让"AI 在认真理解我"这件事可见。
- **风格向量引擎**：3D 向量（个人数据集 512 维 / 写作偏离 128 维 / 注意力焦点）+ 14 维度画像 + 从每次修改中在线学习。详见 [skills/sculptor/references/style-vectors.md](skills/sculptor/references/style-vectors.md)。
- **双风格模型**：人想写的（write-style）≠ 人想听的（read-style），分开采集、分开注入。
- **读者群像（Audience）**：交付前模拟 8 个第一读者（老教师/挑剔编辑/中学生/挑剔评论家/
  焦虑家长/历史爱好者/随性读者/年轻作家）第一次阅读的心理反应——在哪里停下来、哪里走神、
  哪句记住了、最想对作者说什么。详见 [agent/README.md](agent/README.md)。
- **文体库（Genre）**：公文/合同/通知/会议纪要/报告等公式化内容的"结构骨架 + 行文规范"，
  自动识别文体并按范式产出；与个人写作库叠加，公式化内容既规范又像你。
- **个人写作库（Library）**：作品自动分类归档 + 蒸馏成个人写作 skill（限量注入，不污染上下文），
  用户可随时查看自己的作品与整理出的 skill；Web 端将以 session 为单元组织。
- **多模态 IO**：docx/xlsx/图片输入自动提取为素材；成稿一键导出 docx（python-docx）。
- **感性解剖**：5 维度（立场导向 / 局限边界 / 困惑混乱 / 多视角代入 / 风格兑现度），把文本隐藏的感性结构照亮给作者。详见 [skills/sculptor/references/sensibility.md](skills/sculptor/references/sensibility.md)。
- **反 AI 痕迹硬规则**：零容忍黑名单、重复比喻/句式禁令、人类化统计指标。详见 [skills/sculptor/references/anti-ai.md](skills/sculptor/references/anti-ai.md)。
- **压缩守卫**：上下文压缩前把风格指纹写回 vault，记忆会丢、风格不丢。

## 引擎同步与维护（给开发者）

`agent/` 是唯一事实源；skill 内嵌引擎由同步脚本生成：

```bash
scripts/sync-skill-engine.sh           # agent → skills/sculptor/scripts/engine
scripts/sync-skill-engine.sh --check   # 校验是否漂移（CI 在跑）
node agent/test/e2e.mjs                # 全链路离线测试（mock LLM，88 项断言）
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
- "我贴一段我的旧稿" → 自动落盘 + 14 维风格提取，后续写作全程带着你的风格
- "写完了，读者第一次读会怎么想？" → 读者群像：8 个第一读者的即时心理反馈
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
3. **一键安装**：`curl -fsSL <url>/install.sh | bash`（npm 包仅含 CLI 形态，skill/安装器走仓库）。
4. **宿主生态**：WorkBuddy 数字员工（企业场景）、Cursor 规则。
5. **增值层**（后续）：风格金库模板市场、团队风格分析、感性解剖报告订阅。

## 路线图

- P0：跨平台 skill 包 + 协议层 + 安装器 ✅
- P1（当前）：玻璃面板渲染、定点修改吸收、压缩守卫、观察者日志 ✅
- P1 收尾：Observer 接入宿主 hooks ✅（已修复为 app 安全：默认注释，CLI 用 --hermes）
- P2：完整 Agent 运行时 + MCP 协作 ✅（agent/，74 项离线 e2e 全绿）
- P3（本轮）：需求访谈 + 读者群像 + 引用块 + 全程风格采集 ✅（agent/ 17 个 MCP 工具）
- P4：多 Agent 交付协议、风格市场、团队风格分析

## License

MIT
