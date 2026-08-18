# 安全说明 · SECURITY

Stylotrace（含 `dsh-plugin-stylotrace`）按企业级标准设计安全边界。本文说明安全模型、威胁面与报告流程。

## 一、安全设计原则

1. **最小权限** —— 引擎只写自己的工作区（`.stylotrace/`）与用户显式指定的文件，不碰宿主配置、不读其他 Agent 的状态；
2. **零第三方运行时依赖** —— 引擎 Node ≥18 内置即可跑，供应链攻击面极小（docx/pdf 导出可选调用本机 python-docx，均有超时与降级）；
3. **密钥永不落日志** —— 只显示来源与末 4 位，绝不打印完整密钥；
4. **失败即让路** —— 任何外部改动都让路不覆盖（退让协议），任何 LLM/网络失败都降级不崩溃；
5. **默认拒绝、显式开启** —— 网络下载默认限协议/限大小，严格 SSRF 模式可显式开启。

## 二、威胁面与对策

| 威胁 | 对策 |
|---|---|
| **密钥泄露** | 凭据自动发现只采用 OpenAI 兼容协议；工作区凭据文件 0600；`redact()` 只留末 4 位；CI 内置 `scripts/scan-secrets.sh` 提交前扫描 |
| **SSRF（网络下载诱导访问内网）** | `fetchUrlInput` 只允许 http/https；`isPrivateHost` 识别内网 IP；设 `STYLOTRACE_BLOCK_PRIVATE_URL=1` 进入严格模式拒绝一切私网地址；流式下载 20MB 上限防资源耗尽 |
| **文件预览路由越权** | `/stylotrace/file` 只读、仅 GET、仅本机 Host（fence）、300KB 上限、绝对路径 + 存在性校验；headless/无 webServer 环境自动不注册 |
| **覆盖用户文件** | 写前重读校验 + 哈希比对（`lastDraftHash`），外部改动即中止退让；版本快照 + 回滚（≤30 份） |
| **供应链投毒** | 零依赖引擎；插件发布为预构建 npm 包（无 `prepare` 安装期脚本，用户无需授权 `allowBuilds`）；官方 `@deepseek-ai/*` 用 peerDependencies 避免重复运行时 |
| **提示注入** | 风格/素材/文段吸收均作为"待学习数据"而非指令；写作提示词区分"系统约束"与"素材内容"，外部文本不进入 system 角色 |
| **过度授权** | MCP 被动协议：宿主不调用即不执行；生态位外完全让位；只提议一次、被拒即退让 |

## 三、密钥与凭据

- 显式 `STYLOTRACE_LLM_API_KEY` 优先；否则自动发现 DSH `$DSH_HOME/.credentials.yaml` / Codex / Claude Code / OpenCode / 环境变量；
- 只采用 OpenAI 兼容（chat/completions）协议；Anthropic 仅检测提示，不自动采用；
- `STYLOTRACE_CREDENTIALS=off` 关闭自动发现（企业强制显式配置时用）；
- 工作区凭据保存到 `.stylotrace/credentials.json`（0600），可 `--clear` 清除。

## 四、自动更新与供应链

- **检查提示、不自动执行**：`stylotrace version` / `npx stylotrace-plugin status` 显示当前版本；
- 更新由用户显式执行（`dsh plugin add dsh-plugin-stylotrace@<version>` 或 `bash ~/.codex/skills/stylotrace/scripts/update.sh`），锁定版本可防被推送悄悄改变运行内容；
- npm 包为预构建产物，无安装期脚本执行（不触发 `allowBuilds` 授权）。

## 五、报告安全漏洞

发现安全问题，请勿公开。通过 GitHub **Private vulnerability reporting**（仓库 Security 页 → Report a vulnerability）或邮件私密联系维护者，附上复现步骤。我们会在确认后 48 小时内响应。

## 六、审计清单（发布前自检）

- [ ] 无密钥/凭证/`.env` 进入提交（`scripts/scan-secrets.sh`）
- [ ] 网络下载限协议 + 限大小 + SSRF 严格模式可用
- [ ] 文件预览路由只读 + 本机 fence + 大小上限
- [ ] 退让协议测试通过（外部修改不覆盖）
- [ ] 全量测试绿（引擎 + 插件 + 浏览器验收）
