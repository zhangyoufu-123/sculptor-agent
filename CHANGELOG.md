# Changelog

## 0.6.0 (2026-08-06)

### Added

- **导演模式（Director，自主决策 · 主导对话）**：`sculptor agent`（或 MCP `agent_step`）
  每次收到用户消息自动决定并执行下一步——澄清→大纲→逐节写作→反 AI 审计→读者群像→交付，
  用户不用催"继续"；只在真正的用户决策点停下（主题/立场/素材/立意/论点/大纲确认/风格方向）。
  交付后说风格方向 → 全文按新方向重写并再走一轮审计与群像。MCP 工具 19 → 20。
- **仓库纯净化**：移除旧控制台/Web/并行 TS MCP 残留（`integration/engine-mcp`、
  旧安装器 `scripts/install.sh`）；主仓库重组为 agent 单包（`packages/sculptor-agent` → 根）。
- **install.sh 定位修复**：按脚本自身位置判断本地仓库，任意目录调用都成立。

### Changed

- 版本 0.5.0 → 0.6.0（CLI HELP / MCP serverInfo / package.json 同步）。
- 根 package.json 增加 husky/lint-staged/commitlint，pre-commit = lint-staged + 全量 e2e。

## 0.5.0 (2026-08-06)

### Added

- **skill 内嵌完整引擎**：`skills/sculptor/scripts/engine/` 是 agent 的完整快照
  （bin + src + templates + package.json），`scripts/sculptor.mjs` 为启动器——
  装完 skill 即拥有全部工作流（interview/outline/write/redteam/audience/dissect/
  restyle/style/point-edit/mcp），**不再依赖外部安装的 sculptor CLI**。
- **引擎同步脚本** `scripts/sync-skill-engine.sh`：agent/ 为单一事实源，
  `--check` 模式供 CI 校验漂移。
- **一键安装** `install.sh`：curl | bash 或 git clone；默认目录级安装
  （`<项目>/.codex/skills/sculptor`），可 `--global` / `--cli` / `--mcp-codex`；
  已有安装自动备份（`.bak.<时间戳>`）可回滚；装完自动验证引擎可独立运行。
- **hook 命令**：宿主生命周期事件（session/user/assistant/compact/stop）→
  观察日志 + 压缩守卫（压缩前刷新风格指纹）。
- **checklist 命令**：渲染需求访谈确认清单（不消耗 LLM）。

### Changed

- 版本 0.4.0 → 0.5.0（MCP serverInfo、CLI HELP 同步）。
- `setup` 支持双布局（独立包 / skill 内嵌引擎），自动定位 skill 目录。

## 0.4.0 (2026-08-06)

### Added

- **需求访谈 `sculptor interview`**：多轮一问 + 实时确认清单（✓/…、进度 x/9、剩余项），
  收尾打包"确认清单 + 风格档案进度 + 剩余步骤"；与 clarify 共享同一状态机。
- **读者群像 `sculptor audience`**：8 个"第一读者"（老教师/挑剔编辑/中学生/挑剔评论家/
  焦虑家长/历史爱好者/随性读者/年轻作家）逐段记录第一次阅读的心理反应，交付前强制环节；
  LLM 不可用时确定性兜底，永不缺席。
- **定点引用 `sculptor quote`**：一键生成可粘贴的「〔Sculptor 引用〕《原句》/修改指令」块；
  `point-edit` 支持两行引用块单参数粘贴。
- **风格全程被动采集**：每句话/素材/修改理由即时写入 write/read 档案（带证据）；
  同文体旧稿（≥80 字）自动落盘并做 14 维风格提取（联想/技巧/注意力焦点）；
  `sculptor style [--backfill|--extract]` 让"风格被读到了"全程可见。
- **风格记忆检索（RAG 增强注入）**：写作/大纲/扩写/红队修订前按
  "论题 + 文体 + 本节论点 + 高置信风格维度"检索作者旧稿片段与亲手修改对
  （原文→修改→意图），BM25 中文二元组打分，相关度/时间衰减/重要性加权排序，
  以少样本 + 联想库 + 反例块注入提示词；CLI 新增 `sculptor style --memory <查询>` 预览，
  MCP 新增 `style_memory` 工具（17 → 18 个）。
- **整篇文章蓝图（grilling 式共同理解）**：澄清全程维护蓝图（主题/为什么写/核心张力/
  读者带走什么/结构顺序/论点/素材/情感/结尾），核心信息齐后回显整篇蓝图请用户确认，
  修正意见带进大纲生成；追问设计师被要求"每个问题都是蓝图的下一个拼图"。
- **风格方向与全文重写**：用户说"整篇更克制/更豪迈…"即时记录 `styleDirections` 并标记
  需要重写；CLI/MCP 新增 `restyle`（缺省读取最近方向，全文或指定节重写，保留结构与论点）；
  `sculptor style --export` 导出人类可读档案 `vault/style-profile.md`。MCP 工具 18 → 19。
- MCP 新增 `interview_step / audience / quote / style_status`（13 → 17 个工具）。
- skill 独立形态新增 `checklist / quote` 子命令（零依赖）。

### Changed

- 澄清阶梯末尾补"风格底稿"一问（同文体旧稿，问一次即可，没有就放过）。
- `agent/package.json` 打包包含运行必需的 `templates/` 与 `README.md`。

## 0.3.0 (2026-08-06)

## 0.3.0 (2026-08-06)

### Added

- 完整 Agent CLI（零依赖）：澄清（立意/论点深挖、单问句强制）、带论点挂载的大纲、
  双风格写作（字数门槛/扩写）、确定性红队、感性解剖、定点修改（并发守卫）。
- 生态位探测器 `sculptor probe`：主动触发判断，提议一次、被拒即退让。
- MCP stdio 服务器（13 个工具），供 Codex / Claude Code / OpenCode 调用。
- `sculptor setup`：一键自动接入（检测宿主 → 原生注册 → 项目级 skill → 凭据复用 0600）。
- 引擎 MCP 接入包（integration/engine-mcp）：把原引擎全部深度暴露为 MCP。
- macOS 右键"在 Sculptor 中修改"服务（extras/）。
- 一键安装：`curl -fsSL …/install.sh | bash`；项目级注册，绝不写全局。

### Changed

- 触发纪律升级为"主动感知生态位 + 退让底线"；未答问题一律不默认。
- 澄清硬门禁：主题 + 立场 + 素材≥2 + 核心立意 + 支撑论点≥2。

### Security

- `.env.local` 加入 .gitignore；凭据复用仅限本机已有配置，0600 写入。
