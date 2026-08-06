# Changelog

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
