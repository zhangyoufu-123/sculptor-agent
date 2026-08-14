# 压缩守卫协议（Compaction Guard）

## 何时触发

宿主上下文即将压缩/轮转前（Codex 自动压缩、Claude Code 会话续接、上下文接近上限时），Stylotrace 必须把风格与工作流状态显式落盘。

## 落盘清单

写入 `vault/` 与 `protocol/`：

1. `vault/style-fingerprint.json`：14 维中 confidence>0.6 的值 + 证据短语；3D 向量 top 联想 / 技巧 / 注意力目标；本会话风格增量（新增样本摘要 + 修改吸收记录）。
2. `protocol/state.json`：当前阶段、已确认字段、素材清单、待办、最近一次定点修改。
3. `vault/write-style.json` / `vault/read-style.json`：增量合并后的最新版。

## 压缩后恢复

新上下文里 sculptor 技能再次触发时：

1. 读 `protocol/state.json` → 恢复工作流位置。
2. 读 `vault/style-fingerprint.json` + `write/read-style.json` → 恢复风格。
3. 读 `vault/project-memory/` → 恢复素材。
4. 向用户报告一句："已恢复到第 X 阶段，你的风格档案已续上。"

## 原则

- 宁可丢对话细节，不可丢风格指纹（persona collapse：摘要会剥掉"怎么说"）。
- 落盘必须是"怎么说"的摘要，不只是"说了什么"。

## 落地方式

1. 安装时接入宿主 hooks（以 Codex 为例）：

```bash
./scripts/install.sh hooks            # 写入注释版（安全默认，app 与 CLI 都不受影响）
./scripts/install.sh hooks --hermes   # CLI 用户启用字符串格式 hooks
./scripts/install.sh hooks --dry-run  # 预览
```

2. 手动刷新指纹（任意宿主、任意时机）：

```bash
node scripts/sculptor.mjs fingerprint .sculptor/vault
```

3. 无 hooks 宿主的手动流程：把本会话风格增量与工作流状态写入 vault/ 与 protocol/ 后，运行上面的 fingerprint。

启用后 `PreCompact` 与 `Stop` 事件会自动触发指纹刷新，观察日志自动写入 context.jsonl。
hook 脚本容错：工作区不存在或事件不认识时安全退出，不干扰宿主。
注意：ChatGPT 桌面 app 要求 hooks 为 struct 格式，字符串格式会导致整个配置解析失败——
因此默认只写注释版，仅 Hermes CLI 用 `--hermes` 启用。
