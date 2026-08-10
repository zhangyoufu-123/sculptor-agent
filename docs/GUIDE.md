# Sculptor 使用手册

安装、命令、双形态、协作协议、开发维护。想快速了解产品本身，回 [README](../README.md)。

## 安装

```bash
# 方式一：一行命令，一次装好三个安装点（全局 skill + 当前项目 skill + 开发镜像 ~/sculptor）
curl -fsSL https://raw.githubusercontent.com/zhangyoufu-123/sculptor-agent/main/install.sh | bash -s -- --all

# 方式二：git clone
git clone https://github.com/zhangyoufu-123/sculptor-agent
cd sculptor-agent && ./install.sh --all --project ~/我的写作项目
```

三个安装点各有用途：`~/.codex/skills/sculptor`（全局：所有 Codex 对话可用）、
`<项目>/.codex/skills/sculptor`（项目级：只在当前项目生效）、`~/sculptor`（开发镜像：
选择性同步 agent/skills/scripts 等，保留你自己的 `.git`、`node_modules`、`.env.local`）。
任一安装点更新后，随处一键刷新：

```bash
bash ~/.codex/skills/sculptor/scripts/update.sh [项目目录]   # skill 自带更新器
./install.sh --all --update                                   # 仓库内更新（先 git pull）
```

安装完成后自动注册当前项目（Codex MCP + skill + 凭据，零手动、零全局副作用）；
`--no-setup` 跳过自动注册，`--setup-all` 同时注册 Claude Code / OpenCode。

## 快速使用

skill 内嵌完整 agent 引擎，装完即用，无需单独安装 CLI：

```bash
export SCULPTOR_LLM_API_KEY=sk-xxx    # 必配：默认 DeepSeek 端点
SCULPTOR=.codex/skills/sculptor/scripts/sculptor.mjs
node $SCULPTOR init && node $SCULPTOR agent   # 导演模式：主导全程，自动推进到交付
```

导演模式（自主决策 · 主导对话）：每次收到你的消息，Sculptor 自己决定下一步并执行——
澄清问完就生成大纲、大纲确认就逐节写作、写完就反 AI 审计、审完就请 8 位"第一读者"群像反馈、
最后交付。你不需要催"继续"，只在真正的决策点（主题/立场/素材/立意/论点/大纲确认）回答。
交付后说"整篇更克制一点"这类风格方向 → 全文自动按新方向重写并再走一轮审计与群像。

深度定点修改：选中一句话 → `node $SCULPTOR point-edit "原句" "指令" --dir 项目`
（macOS 可装右键服务，见 `extras/`）。宿主 agent 安装后按 `SKILL.md` 自动调用全部流程。

## 常用命令

### 写作流程

- `clarify`：交互澄清（一次一问）；`clarify --once` 单步。
- `interview`：需求访谈（多轮一问 + 实时确认清单 + 进度）。
- `outline`：生成大纲（素材门槛未过会报错）；`outline-review` 大纲评审。
- `write`：按大纲逐节写作；`write --section N` 只写第 N 节。
- `restyle`：按新风格方向重写全文；`transform` 一键改写矩阵。
- `redteam`：反 AI 审计（可选 LLM 修订）；`redteam --proofread` 加校对。
- `audience` / `debate`：读者群像与交锋。
- `dissect`：感性解剖 5 维度；`fact-check` 事实核查；`proofread` 校对。
- `style-eval`：深度全稿风格保真评估（手动）。

### 风格

- `style`：档案进度；`style --memory 查询` 检索旧稿与修改对；`style --pulses` 风格脉搏。
- `style-vector`：四层复合风格向量；`style-adapter`：持续微调（蒸馏/数据集/LoRA）。
- `persona`：人物风格肖像（侧写），`--refresh` 重新生成并映射回向量。
- `profile export/import`：全局风格档案跨工作区携带。

### 知识与数据

- `knowledge`：个人知识库（list/search/view/add/remove/export/import）。
- `recommend`：荐书联想；`bible`：文章圣经（list/view/save/distill）。
- `library`：个人写作库（分类 + 蒸馏个人写作 skill）。
- `rag status|search|ingest|ingest-assets|needs`：联网检索/回灌/待办查看。
- `emotion`：情绪曲线量化；`citations [--append refs.json] [--auto]`：引文与参考文献。

### 文体与导出

- `genre <名称>`：查看文体结构骨架与行文规范（公文/合同/议论文/学术论文/小说/投标书/申报书…）。
- `export`：导出 docx / md / html / srt / pdf；`--official` 公文国标；`--academic` 学术排版。
- `dictate`：语音口述（whisper 转录）；`ingest`：docx/xlsx/图片提取素材。
- `history` / `rollback`：版本快照与回滚（写作前自动存）。

## 双形态

- **Skill 形态（默认，完整引擎内嵌）**（`skills/sculptor/`）：`scripts/engine/` 是 agent 的
  完整快照（由 `scripts/sync-skill-engine.sh` 同步、CI 校验防漂移），装 skill 即装完整 agent。
- **独立 CLI 形态（可选）**（`agent/`）：`./install.sh --cli` 软链 `sculptor` 到 `~/.local/bin`；
  另提供 MCP stdio 服务器（`node scripts/sculptor.mjs mcp`）——Codex / Claude Code / OpenCode
  通过标准 MCP 调用，对话由宿主主导，Sculptor 只负责写作与风格。只写自己的工作区，绝不碰宿主配置。

## 共存与退让（不与其他 Agent 打架）

- **主权顺序**：用户指令 > 宿主当前动作 > Sculptor。
- **写前校验**：改用户文件前重读；目标原文已被外部改动 → 中止退让，绝不覆盖。
- **地盘隔离**：只用 `.sculptor/` 与用户明确指定的文件。
- **MCP 被动**：宿主不调用就不执行。
- **生态位主动**：任务落到写作生态位时主动提议（`probe`），提议一次、可拒绝；合作不接管。

## 凭据与安全

未配置 `SCULPTOR_LLM_API_KEY` 时自动读取宿主已配置的 API（Codex / Claude Code / OpenCode /
常见 `*_API_KEY`），只显示来源与末 4 位、绝不打印；`sculptor credentials --ask` 交互选择。
密钥只放本地 `.env.local`（已被 `.gitignore` 忽略，权限 0600）；提交前跑
`bash scripts/scan-secrets.sh --all-refs`（CI 已内置）；一旦泄露，立即到 GitHub Settings → Tokens 吊销重建。

## 开发与维护

`agent/` 是唯一事实源；skill 内嵌引擎由同步脚本生成：

```bash
scripts/sync-skill-engine.sh           # agent → skills/sculptor/scripts/engine
scripts/sync-skill-engine.sh --check   # 校验是否漂移（CI 在跑）
cd agent && npm test                   # 全链路离线测试（mock LLM，337 项断言）
```

观察者 hooks 自动把会话事件写入 `.sculptor/protocol/context.jsonl`，压缩恢复时凭
context + state + 风格指纹续写，记忆会丢、风格不丢。

## 分发渠道

1. GitHub 开源仓库：目录即产品，clone 即装。
2. Skill 市场：Codex 个人插件、Claude Code marketplace、OpenCode registry。
3. 一键安装脚本；npm 包仅含 CLI 形态。
4. 宿主生态：WorkBuddy 数字员工（企业场景）、Cursor 规则。
