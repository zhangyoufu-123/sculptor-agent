# Sculptor：面向人机深度协作的个性化写作 Agent

**技术报告 · v0.23 · 2026-08-10**

---

## 摘要

通用大语言模型（LLM）已能生成通顺文本，但用于个人写作时普遍存在"千人一面、一眼 AI 腔"的问题。
本文提出 **Sculptor**——一个嵌入 Agent 环境（Codex / Claude Code / OpenCode）的深度协作写作系统。
它的核心主张是：**写作质量的下限由模型决定，上限由"对作者的理解"决定**。

Sculptor 围绕三条主线设计：(1) **风格系统**——把风格定义为"人天然的不规范表达与完美表达之间的
差异弥补"，用四层复合风格向量 + 人物风格肖像（侧写）持续提取作者特征；(2) **个人知识库（PKB）**——
以归纳式确认采集作者读过的书、去过的地方与个人理论，写作时检索注入并轮换，避免"反复引用同一本"；
(3) **主导式多 Agent 协作**——Sculptor 在写作生态位内自主决策（澄清→大纲→写作→复阅→红队→读者群像→交付），
在需要数据时自动排队检索，由宿主/学术 Agent 供给并回灌，数据不足时自动重写缺口节。

系统还实现学术论证链（known→gap→tension→insight→method→evidence→limitation）、
小说角色预演（持久内部状态 + 理想-现实张力驱动的第一人称行为预测）、文章圣经（跨篇一致性）等
文体专属机制。离线全链路测试 337 项断言覆盖澄清到交付；反 AI 审计在真实任务中检出并自动修复
重复比喻、套话与句式复用。

**关键词**：写作 Agent；风格提取；个人知识库；检索增强生成；多 Agent 协作；人机协作

---

## 1 背景与问题

LLM 的通用写作能力已大幅超越模板工具，但个人用户仍难以用它写出"像自己"的文章。观察到的现象包括：

- **风格错配**：系统用一篇散文的风格标签去生成议论文——同一个人在不同文体中呈现不同风格侧面，
  而通用工具不做文体区分；
- **素材伪门槛**：用户在澄清中说过的案例与数据未被结构化传递到写作阶段，导致重复追问或"假大空"；
- **交互死板**：固定模板式追问无法从用户原话生长，用户说"没有更多了"仍被反复询问；
- **数据孤岛**：读过的书、写过的文、检索到的资料彼此隔离，无法共同支撑一篇文章。

这些问题指向同一个根因：**系统不理解"作者"**。本文以"作者建模"为核心构建完整写作工作流。

## 2 相关工作

### 2.1 学术写作 Agent
AgenTex [1] 采用多 Agent 架构按 IMRaD 结构生成论文大纲，并以苏格拉底式提问引导研究者澄清论点；
BuildIntroArgumentChain [2] 将引言规划为"已知问题→缺口→张力→洞见→方法→证据承诺"的论证链。
Sculptor 吸收论证链思想并扩展到全文各节，同时补足"证据承诺→局限"的完备性检查。

### 2.2 角色与叙事模拟
MATE [3] 与 DiriGent [4] 表明，可信的角色行为来自**持久内部状态**（记忆、情绪）与
**理想-现实张力**（agent 期望世界与实际世界的差距）驱动。Sculptor 的角色预演采用同一模型：
为每个角色维护背景/愿望/恐惧/记忆/情绪档案，写作前让 LLM 以角色第一人称预测"会怎么想、怎么说、怎么做"。

### 2.3 检索增强与个性化推荐
PoetRAT [5] 以检索增强模拟诗人的认知工作流，减少诗词生成幻觉；基于 LLM 的书籍推荐 [6]
利用用户阅读历史做语义匹配。Sculptor 的内置资产库采用"联网检索优先、内置库离线兜底"的 RAG 策略，
荐书联想则结合思想库与用户知识库。

### 2.4 记忆与知识管理
MemGPT [7] 提出分层记忆与自我编辑；Alexandria [8] 强调知识条目的来源可引、人可读。
Sculptor 的 PKB 存储为人类可编辑的 Markdown（JSON 头 + 笔记），并记录来源与置信度，
提问去重（asked.jsonl）保证"同一本书只问一次"。

## 3 系统设计

Sculptor 由引擎（零依赖 Node CLI）、Skill 包与 MCP 服务三层组成，嵌入宿主 Agent 环境：

```
宿主对话（Codex / Claude Code / OpenCode）
  │  probe 生态位判定（只在写作任务触发）
  ▼
Skill 包（SKILL.md 协议 + 内嵌引擎）
  ▼
引擎（state.json 状态机）
  ├─ 澄清 Clarify：一次一问、从原话生长、风格/知识/数据同步采集
  ├─ 大纲 Outline：文体驱动蓝图 + 论证链/故事骨架
  ├─ 写作 Write：双风格注入 + 知识库检索 + 角色预演
  ├─ 复阅 Revise：初稿自查（偏题/衔接/素材用足）
  ├─ 红队 Red-team：反 AI 审计 + 自动修订
  ├─ 读者群像 Audience：8 个第一读者感性反馈 + 交锋收敛
  └─ 交付 Deliver：归档 + 圣经沉淀 + 导出
  │
  ├─ 风格系统：write/read 档案 · 四层复合向量 · 侧写 persona
  ├─ 知识系统：PKB · 个人写作库 · 思想库 · 资产库（RAG）
  └─ 协作系统：requests.jsonl 检索队列 · rag_ingest 回灌 · data_needs
```

单一事实源为 `agent/`，Skill 内嵌引擎由同步脚本生成；CI 校验二者不漂移。

## 4 核心方法

### 4.1 风格：差异弥补模型与四层复合向量

设"完美表达"为规范、平滑的文本分布，人类写作是个体对它的系统性偏离。Sculptor 将偏离分解为四层：

- **L1 连续向量**：作者语料相对通用基线的方向差，EMA 增量更新；
- **L2 动态维度**：从素材与修改意图中衍生的主题关联（如"克制收敛"偏好轴）；
- **L3 困惑度签名**：作者文本的信息熵模式（人类文本 surprisal 显著高于 AI 腔）；
- **L4 偏好对**：`（原文, 修改, 意图）`三元组，直接编码用户编辑行为。

在此基础上，**人物风格肖像（persona）** 从知识库、旧作、修改记录中侧写作者的
叙述视角/词汇偏好/句式/情感表达/价值观/套路与盲区/引用习惯，并映射回风格向量。
写作注入顺序：风格适配卡（最高优先级）→ 侧写 → 统一素材，且带过拟合护栏
（"习惯而非牢笼，必要时可突破"）。

### 4.2 个人知识库：归纳式采集与轮换注入

PKB 遵循三条铁律：
1. **归纳式确认**：用户提出构想时，AI 提议"如果《X》是你读过的作品，告诉我一声"，同意才记录；
2. **提问去重**：同一作品只问一次（asked.jsonl），拒绝也算已问；
3. **灵活调用**：BM25 检索注入，未用条目 +0.2、用过按次数递减（封顶 -0.45），避免反复引用同一本。

知识库与写作库、检索缓存互通：网络检索回灌的书目自动入知识库（标注来源与置信度）；
荐书联想在思想库未命中时自动联网检索。

### 4.3 实时取数与主导式协作

Sculptor 在三个时机自动排队检索：澄清（clarify-data）、大纲缺素材节（outline-gap）、
写作"素材不足"标注（write-gap）。宿主或学术/数据分析 Agent 通过 `rag needs` / MCP `data_needs`
查看待办，检索后 `rag ingest` 回灌进素材；若回灌晚于写作且稿中仍有缺口节，导演状态机自动重写
这些节并重新审计（最多 2 轮数据补给）。

### 4.4 文体专属机制

- **学术论证链**：known→gap→tension→insight→method→evidence→limitation，大纲与每节按链推进；
  完备性扫描逐节检查 claim/evidence/warrant（结论节另查 limitation）。
- **角色预演**：持久角色档案 + 理想-现实张力，LLM 以第一人称预测情绪/言语/行为，注入本节写作；
  情绪记忆回写档案保证整篇连续；无 LLM 时确定性兜底。
- **文章圣经**：交付时沉淀世界观/角色/时间线/伏笔/文风约定，系列文续写自动注入。
- **复阅-修订**（Flower & Hayes 认知写作模型 [9]）：初稿后全文复查一轮，P0 问题自动修订。

## 5 评估

### 5.1 全链路自动化测试

337 项断言覆盖：澄清→大纲→写作→复阅→红队→群像→交付、风格向量四层、知识库收录/去重/轮换、
实时取数排队/回灌/自动重写、MCP 工具、凭证安全。所有 LLM 调用使用离线 mock，确定性、可复现。

### 5.2 真实任务反 AI 审计

在真实写作任务（北大红楼游记）中，红队审计检出并自动修复：跨节重复比喻
（"像有人跟在后面"→"像旧朝宫人踏过回廊"）、"不是…而是…"句式复用；终审黑名单 0、硬失败 0。
人类化指标：句长标准差 14.4、段落变异系数 0.45、句首去重率 81%、词汇二元 TTR 0.78，均在真人区间。

### 5.3 鲁棒性

任何 LLM/网络环节失败均确定性降级：澄清退回单问题阶梯、角色预演退回规则预测、
读者群像退回确定性兜底、检索走宿主代检而非中断。引擎同步 CI 与密钥扫描防漂移与泄露。

## 6 局限与未来工作

- **跨会话知识统一**：PKB 已支持 export/import，但尚未做跨工作区的自动同步；
- **双人合写**：两份风格侧写的融合尚未实现；
- **平台适配**：小红书/公众号/知乎的排版与钩子未做成正式文体；
- **联网内容质量**：网络回灌来源已标注"待核实"，但缺少自动置信度评估；
- **成本控制**：角色预演每节增加一次 LLM 调用，需按文体与篇幅进一步限流。

## 7 结论

Sculptor 验证了"作者建模"对写作质量的决定性作用：把风格、知识、数据、协作串成一条
以作者为中心的流水线，AI 才能从"会写"走向"写得像你"。337 项断言与真实任务审计表明，
系统在稳定性、可复现性与人类化指标上达到可交付水平。

---

## 参考文献

[1] Duy Tan University. AgenTex: A Multi-Agent AI System for Scientific Research Support, 2026.

[2] BuildIntroArgumentChain: Plan an Introduction as an Argument Chain. Hugging Face Dataset/Skill, 2026.

[3] MATE: A Deterministic Affective Middleware for LLM-Based Companions with Emergent Character and Persistent Internal State, 2026.

[4] CGL@ETHZ. Steering Narrative Agents through a Dynamic Cognitive Framework for Guided Emergent Storytelling (DiriGent). AIIDE, 2025.

[5] PoetRAT: A Poetry Retrieval Augmented Thoughts Framework for Chinese Classical Poetry Generation. Applied Soft Computing, 2026.

[6] Building a Personal Ebook Librarian with Local LLMs for Better Recommendations, 2026.

[7] MemGPT: Towards LLMs as Operating Systems, 2023.

[8] Alexandria: The Personal Knowledge Base that Lets You Manage Your Knowledge Like Code, 2024.

[9] Flower, L., & Hayes, J. R. A Cognitive Process Theory of Writing. College Composition and Communication, 1981.
