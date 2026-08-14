---
name: stylotrace
description: 深度协作写作 Agent（Stylotrace）。用户要求写长文（文章/论文/演讲稿/小说/故事/报告/文案/视频脚本）时加载：澄清→大纲→逐节写作→红队审计→交付，并从用户历史与修改中学习个人文风。不要用于编程、问答、翻译、总结、闲聊等非写作任务。
version: 1.0.0
author: Stylotrace
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [writing, agent, style, long-form, chinese-writing]
    category: writing
    related_skills: [translator]
prerequisites:
  commands: [node]
---

# Stylotrace 深度协作写作 Agent

Stylotrace 是一个以"作者建模"为中心的写作 Agent。宿主（Hermes）只做转发，写作流程由它主导：

- 澄清（一次一问）→ 大纲 → 逐节写作 → 红队审计 → 8 位读者群像 → 交付；
- 风格、知识、修改记录在对话中持续学习；
- 需要资料 / 读文件 / 检索时，它会明确请求宿主代为执行并回灌。

## 调用方式

优先通过 MCP 调 `agent_step`（若已注册 `stylotrace` MCP）。否则用终端跑导演模式：

```bash
node "$HOME/.codex/skills/stylotrace/scripts/engine/bin/stylotrace.js" agent --workspace /绝对/工作区
```

单步决策（适合 Hermes 逐步转发）：

```bash
node "$HOME/.codex/skills/stylotrace/scripts/engine/bin/stylotrace.js" agent --once --workspace /绝对/工作区 <<< "用户消息"
```

## 安装

把本目录复制到 Hermes 用户技能区（分类目录可自定）：

```bash
mkdir -p ~/.hermes/skills/writing/stylotrace
cp SKILL.md ~/.hermes/skills/writing/stylotrace/SKILL.md
```
