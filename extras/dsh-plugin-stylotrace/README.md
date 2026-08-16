# 🖋️ dsh-plugin-stylotrace

> **越写越像你。** Stylotrace 是 DSH 生态第一个写作 Agent:先读懂你的文风,再陪你写好——从你的旧稿、每一句话、每一次亲手修改里学习个人风格,带着这份"你的签名"跑完 澄清 → 大纲 → 逐节写作 → 红队审计 → 读者群像 → 交付。

[![MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-plugin-stylotrace?style=flat-square&color=0891b2)](https://www.npmjs.com/package/dsh-plugin-stylotrace)
[![Agent](https://img.shields.io/badge/Agent-Writing-7C3AED?style=flat-square)](https://github.com/zhangyoufu-123/stylotrace)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2?style=flat-square)](https://github.com/topics/dsh-plugin)

## 30 秒了解

- 🧠 **学会你,不是模仿别人** —— 四层风格向量 + 外层调制器(从你的亲手修改学每个用户独有的权重),几十次修改即可学到稳定方向,1 条编辑对即可冷启动;
- 📦 **做了东西不想写报告?交给它** —— `synthesize` 从项目(README/docs/代码/提交记录/对话上下文)自动提炼成**实验报告 / 产品介绍 / 技术综述 / README / 技术博客**,无需逐项交代要求;
- 🎭 **知道你想写什么,也知道你想听什么** —— 双风格建模:"人想写的"(write-style)与"人想听的"(read-style)两套档案分开采集、分开注入;
- 🛡️ **反 AI 痕迹上探到姿态层** —— 黑名单/重复比喻/句式之外,还能抓住"表演式思考"(金句排比、路标转折、点题顿悟);
- 👥 **8 位"第一读者"群像 + 交锋** —— 交付前模拟真实读者的第一反应,共识直接改、争议你拍板;
- ✂️ **选中即改进(Web)** —— 在 DSH 页面任意文本上选中一句,浮动「Stylotrace 改进」,发送后精修该句并吸收进你的风格档案;
- 📄 **作品一眼可见(Web)** —— 自动提炼生成的报告/文章渲染为作品 chip,可复制路径。

## 安装(一条命令)

```sh
dsh plugin --profile web add dsh-plugin-stylotrace
```

安装后**重启** `dsh --profile web`,40 个写作工具以 `mcp__stylotrace__*` 出现在模型面前。

> 支持任意 profile:把 `web` 换成 `headless` 或其他自定义 profile 即可。

### 推荐:同时装技能包(让模型"懂流程")

```sh
npx stylotrace-plugin install --all      # DSH / ~/.agents / Codex / Claude Code / OpenCode
npx stylotrace-plugin doctor             # 自检:MCP 握手 + 工具面清单
```

技能包给模型完整工作流认知,MCP 桥给模型 40 个原子工具。**两者都装,体验最完整。**

---

## 你会得到什么

### 40 个 MCP 工具(全部可被 DSH Agent 直接调用)

| 阶段 | 工具 |
|---|---|
| 生态位判断 | `probe` / `agent_step` / `interview_step` / `clarify_step` |
| 项目自动提炼 | `synthesize`(项目 → 实验报告/产品介绍/综述/README/博客) |
| 大纲与结构 | `outline` / `outline_review` / `review` / `dissect` |
| 写作 | `write_section` / `write_all` / `restyle` / `transform` / `point_edit` / `quote` |
| 质量门 | `redteam` / `proofread` / `fact_check` / `originality` / `style_eval` / `fake-thinking` |
| 读者在场 | `audience` / `reader_debate` |
| 风格学习 | `absorb` / `fingerprint` / `style_status` / `style_memory` / `style_adapter` |
| 资料与引用 | `rag_search` / `rag_ingest` / `data_needs` / `citations` |
| 文档与历史 | `doc_translate` / `doc_restyle` / `history` / `rollback` / `profile_export` / `profile_import` |
| 工作区 | `init` / `panel` / `status` |

### 程序员场景:`synthesize` 项目自动提炼

**"我做出了东西,但不想自己写报告。"** 这正是 Stylotrace 为程序员生态新增的核心能力:

```
你说(或直接给个项目目录):把这个项目写成一份产品介绍
  ↓ 不需要逐项交代要求——agent 自动收集:
  ↓   README / docs / package.json / 最近 git 提交 / 对话上下文 / 你的风格档案
  ↓ LLM 提炼"作者真正想表达什么"(目标/价值/方法/成果),不确定事实标【待核实】
  ↓ 按你的写作风格成稿 → 落盘 workspace/synthesized/*.md(可导出 docx/html)
```

支持文体:实验报告 `report` / 产品介绍 `product` / 技术综述 `review` / README / 技术博客 `blog` / 通用文章 `article`。LLM 不可用时**确定性兜底**,绝不崩溃。

### 为什么"风格学习"是硬能力,不是提示词

- **四层风格表征**:连续向量 + 动态维度 + 语言新鲜度 + 亲手修改记录(`原文→改后→意图`);
- **外层调制器**:从你的编辑对里学出**每个用户独有的十二维权重**,推理时对候选文本评分选优,并输出"为什么选它"的得分分解;
- **双风格建模**:"人想写的"和"人想听的"是两套分布,分开采集、分开注入;
- **反 AI 痕迹上探到姿态层**:统计指标之外,抓住"表演式思考";
- **8 位"第一读者"群像 + 交锋**:把"读者感受"变成可执行的反馈流。

### 量化证据

风格向量可视化实测:Stylotrace 作者 ↔ 史铁生 **1.11**、↔ ChatGPT **1.46**、↔ 模板公文 **1.98**;两个通用模型互距仅 **0.65**——AI 腔互相趋同,人类各有面目。风格注入真实改变写法(同题三风格对照:句长σ 3.7/8.3/5.0)。词级文体计量作者识别 46%→**76%**。

---

## 配置

MCP 桥默认配置即可用;需要自定义时,在 profile 的 `cordis.patch.yml` 里按 `id: stylotrace` 覆盖:

```yaml
- update:
    - id: stylotrace
      config:
        env:
          STYLOTRACE_LLM_API_KEY: sk-xxx        # 引擎调用 LLM 的密钥(BYOK)
          STYLOTRACE_LLM_MODEL: deepseek-v4-flash
        toolCallTimeoutMs: 300000
        failOnStartupError: true
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `env` | `{}` | 传给引擎的环境变量(`STYLOTRACE_LLM_API_KEY` / `_BASE_URL` / `_MODEL` / `TARGET_WORDS`) |
| `toolCallTimeoutMs` | 300000 | 单次工具调用超时(写作步骤耗时较长) |
| `failOnStartupError` | `false` | 启动连接失败是否拒绝插件激活 |
| `reconnect` | 指数退避 | MCP 断线重连策略 |

**凭据说明**:引擎自动发现宿主凭据(**DeepSeek Harness `$DSH_HOME/.credentials.yaml`** / Codex / Claude Code / OpenCode / 环境变量),绝不打印密钥;也可显式设 `STYLOTRACE_LLM_API_KEY`。

---

## 多终端 / 多 CLI / 多 IDE

纯 DSH 机制,与终端无关,适用任意 profile(web / headless / 自定义);技能包同时覆盖:

| 宿主 | 安装命令 |
|---|---|
| DSH(用户级) | `stylotrace-plugin install --dsh` |
| DSH(项目级) | `stylotrace-plugin install --dsh-project --project <项目>` |
| ~/.agents(共享) | `stylotrace-plugin install --agents` |
| Codex | `stylotrace-plugin install --codex [--global]` |
| Claude Code | `stylotrace-plugin install --claude` |
| OpenCode | `stylotrace-plugin install --opencode` |

引擎自带跨宿主协作协议:生态位外完全让位、只写自己的工作区 `.stylotrace/`、外部改动绝不覆盖、写文件前重读校验——与任何 Agent 宿主零冲突。

---

## 面向未来:DSH 开放 curated 上传时的形态

标准 `dsh.bundle` manifest(npm 包)+ 完整技能包(SKILL.md + 零依赖 Node 引擎 + references + protocol)+ 零构建依赖 + MIT 开源——已按"可直接被平台收录"的结构组织,来源 commit 记录在 `VENDORED.md`。

## 开发与验证

```sh
npm run vendor    # 从 stylotrace 仓库重新 vendor 技能包(记录来源 commit)
npm test          # 冒烟 + MCP 桥接 + 真实浏览器验收(headless Chrome,8 项)
npm publish       # 发布到 npm(构建产物已就绪)
```

内部文档:[AUDIT.md](AUDIT.md)(审核与验收报告)· [ECOSYSTEM.md](ECOSYSTEM.md)(生态对标)· [PR-awesome.md](PR-awesome.md)(收录文案)

## 许可证

MIT。Stylotrace 本体同样 MIT,见仓库 LICENSE。
