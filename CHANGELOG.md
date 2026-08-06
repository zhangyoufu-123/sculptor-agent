# Changelog

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
