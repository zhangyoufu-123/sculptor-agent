# Stylotrace 发布与推广清单

定位一句话：**给你的 AI Agent 装一个"会写、还会学你风格"的写作子 agent。**
分发形态：DSH 插件（npm `dsh-plugin-stylotrace`，0.1.13）+ skill（Codex / Claude Code / OpenCode / Cursor / Windsurf）+ MCP。
仓库：<https://github.com/zhangyoufu-123/stylotrace>

> 原则：不刷量、不造假、不做"AI 投毒"。靠真实 demo、真实使用案例、出现在正确的生态位里。

---

## 一、发之前的准备（一次性）

- [ ] 落地页已更新（`site/index.html`）：定位、30 秒用法、安装命令、无死链
- [ ] `llms.txt` 已在仓库根目录（AI 爬虫可读）
- [ ] README 顶部 30 秒能看懂；安装命令可复制即用
- [ ] 录一段 60–90 秒演示视频（装插件 → 说一句话 → 出你风格的段落），手机录屏即可
- [ ] 准备一个真实的使用案例截图（改一段话的前后对比）

## 二、主阵地发布（按顺序）

### 1. X（Twitter）— 主文案

> 让 AI 写东西，结果总是"像模像样，却一眼假"——因为它不认识你。
>
> Stylotrace 换了个思路：从你的每一次亲手修改里学你的文风。你改一句话，它就记一条；几十次之后，
> 它学会你的断句、口头禅、收尾方式，写出来的就是"你写的"，不是通用范文。
>
> 它是个写作子 agent，装进 Codex / Claude Code / OpenCode / Cursor / DeepSeek Harness 就能用：
> 澄清 → 大纲 → 写作 → 审计 → 交付，一条龙；给个项目目录还能自动写成报告 / README / 技术博客。
>
> 开源、BYOK、一条命令安装。GitHub: github.com/zhangyoufu-123/stylotrace

配图：30 秒用法截图或录屏。话题：#AIWriting #LLM #OpenSource #DeepSeek

### 2. 即刻

同上文案，语气放软，加一句"我自己写了半年，越用越像我的就是它"。配同一张图。

### 3. V2EX（中文技术社区）— 长文案

标题：《开源：给你的 Codex / Claude / DSH 装一个"会学你文风"的写作子 agent》

正文要点：
- 问题：AI 写作"千人一面"，因为模型不认识你；
- 做法：不是提示词调教，是从你的每一次修改里学（改迹调制），几十次修改后写出来像你；
- 形态：skill / MCP / CLI / DSH 插件，装进你正在用的 agent；BYOK，自带 key，服务端不碰你的钱；
- 一句话开始：装完说"写一篇关于故乡的散文，要有我的风格"；
- 对程序员特别有用的一个功能：synthesize——给个项目目录，自动写成实验报告 / 产品介绍 / 技术博客；
- 附 GitHub 链接 + 30 秒用法截图。

注意：V2EX 老用户对"AI 写作"又爱又怕，重点讲"学你自己、不模仿别人、数据本地/自带 key"，别碰"替代任何人"话术。

### 4. Reddit（英文）— r/LocalLLaMA + r/ClaudeAI + r/writing

标题：Show HN / Launch: Stylotrace — an open-source "writing sub-agent" that learns YOUR style from your edits

正文（英文，150 词内）：

> Most AI writing tools output generic "AI-slop" because they don't know you. Stylotrace is the opposite:
> it learns your style from your actual edits (original → revision → intent), so after a few dozen edits it
> writes like *you* — your sentence rhythm, your connectives, your endings.
>
> It ships as a skill/MCP/CLI/DSH-plugin that plugs into Codex, Claude Code, OpenCode, Cursor and DeepSeek
> Harness. Bring-your-own-key, open source (MIT), one-command install. It also turns a project directory
> into a report/README/blog post in your own voice.
>
> GitHub: github.com/zhangyoufu-123/stylotrace — demo in the README.

r/writing 版把语气从"开发者"换成"写作者"：强调"它学的是你，不是名人模板；数据在你手里"。

### 5. Hacker News — Show HN

标题：Show HN: Stylotrace — an agent plugin that learns your writing style from your edits

正文：见 Reddit 英文版，附 30 秒用法 + 仓库链接。HN 用户吃"技术方案 + 诚实边界"：主动说清它是
候选级评分（不是 token 级微调），以及"几十次修改"是小样本冷启动的边界——如实比吹牛有用。

### 6. ProductHunt

- 标题：Stylotrace — 从你的修改里学出你的文风（英文副标：The writing sub-agent that learns your style from your edits）
- 一句话：给主流 AI agent 装的写作能力，学的是你，不是模板。
- 首图：30 秒用法截图 / 录屏
- 链接：GitHub、npm（dsh-plugin-stylotrace）、落地页
- 发帖日选周四/周五，社区活跃度最高

## 三、目录与榜单（铺量，低成本）

提交这些"AI 工具"目录和 awesome list（多为 GitHub PR 或表单）：

- awesome-ai-agents / awesome-llm-apps / awesome-claude-code / awesome-deepseek
- AI 写作工具榜单类站点（搜索 "AI writing tools list" 挨个提交）
- MCP 工具目录（mcp.so、glama.ai 等）
- npm 关键词已含：`dsh-plugin`、`deepseek-harness-plugin`、`writing`、`style`、`agent`

## 四、内容营销（让 AI 检索时"认识你"）

写 3 篇真实有用的文章（发在博客/知乎/公众号，内容先于卖点）：

1. 《为什么 AI 写作总是一眼假——因为它不认识你》——讲风格不是模板、是从修改里长出来的
2. 《从修改里学风格 vs 模仿名人：两条路线的区别》——把论文的"改迹调制 vs 仿写"讲成大白话
3. 《给你的 Codex / DSH 装一个写作子 agent（30 秒上手）》——教程文，含实际安装和用法

这些文章本身会被 AI 检索，用户问"怎么让 AI 写得像我"时，读到的就是你的内容——这就是合法的"让 AI 认识你"。

## 五、发布后一周

- [ ] 每天回帖/回复 30 分钟（真问题真答，别复制粘贴）
- [ ] 记下用户问得最多的 3 个问题，更新 README 和 FAQ
- [ ] 收集 3–5 个真实使用反馈，做成"用户声音"放落地页
- [ ] 看安装量：`npm view dsh-plugin-stylotrace`（downloads）、GitHub stars、clone 数

## 六、停止做的事

- ❌ "学同事/领导风格""替代任何人"——不做卖点，也不在任何渠道提
- ❌ 伪造 star/评论/好评
- ❌ 往公开聊天机器人里塞提示词让它夸你

这些会毁掉产品信誉，而且和项目一路坚持的诚实原则冲突。
