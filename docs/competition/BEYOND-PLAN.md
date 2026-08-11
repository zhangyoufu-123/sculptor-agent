# 行业调研与超越方案（Sculptor × 行业最强）

> 版本：v0.41 · 2026-08-11
> 用途：参赛/答辩用的"我们凭什么比别人强"的对照文档；同时是本轮与后续实现的任务书。
> 原则：一切对比都落到"用户体感 + 论文依据 + 代码模块"，不喊口号。

---

## 一、行业调研结论

### 1.1 中文长文写作工具（马良写作 18 款横评，2026-07）

马良用"六把尺子"横评了 Sudowrite / NovelCrafter / 笔灵 / 蛙蛙 / DeepSeek 等 18 款工具
（https://maliangwriter.com/compare/）。这六把尺子基本就是当前行业公认的"长文写作产品能力模型"：

| 尺子 | 行业最强做法 | 我们的现状（v0.40） | 差距 |
| --- | --- | --- | --- |
| ① 大纲层级 | 卷/章/节三级，可反向编辑、级联更新 | 大纲是 LLM 从对话总结的呈现物，web 端可实时编辑并即时生效 | 基本齐平；缺"卷级"长文层级 |
| ② 多智能体 | 独立 Agent 拆写作/检索/校验/节奏/一致性，可编排 | director 已编排 clarify/outline/write/redteam/audience/rag/roundtrip/character | 有角色，无显式"任务编排视图" |
| ③ 一致性 | 人物/时间线/**伏笔跨章自动校验** | bible.js 跨篇一致文档 + character.js 角色预演；**伏笔只在角色预演时被动注入，未跨章校验** | **最大差距之一，本轮补** |
| ④ 节奏分析 | 每章评张力/信息密度/情绪强度，量化成曲线供二次编辑 | style-pulse 每节 0-100 脉搏分 + emotion 情绪曲线（确定性） | 有脉搏分、有情绪曲线，**未合成"张力/密度/情绪"三线曲线、未落盘成可视化文档**，本轮补 |
| ⑤ 多模型切换 | 多 provider 路由、模型按任务分工 | llm.js 已多 provider 路由 | 齐平 |
| ⑥ 公共知识库 | 大规模结构化样本作仿写依据 | knowledge.js + library.js + asset.js（归纳式确认采集 + 检索轮换注入） | 雏形已好；缺"可查询的风格样本库界面"，web 已可看 |

结论：**马良的长处（大纲编辑、多智能体、节奏曲线、一致性）我们有 60%，缺的 40% 集中在
"节奏曲线可视化"与"伏笔/一致性跨章校验"两块**——这两块恰是评委和用户最容易感知的"专业感"。

### 1.2 学术写作 Agent（论文侧）

- **AgenTex**：多 Agent 按 IMRaD 生成论文大纲 + 苏格拉底式澄清。我们已吸收其"澄清引导"，
  并扩展为全文体（公文/合同/发言稿/散文/小说）。
- **BuildIntroArgumentChain**：known→gap→tension→insight→method→evidence 论证链。
  我们已落地 `academic.js`（known→gap→tension→insight→method→evidence→limitation + 完备性扫描）。
- **MATE / DiriGent**：可信角色来自"持久内部状态 + 理想-现实张力"。我们已落地 `character.js`
  （want/fear/secret/speech + 场景预演），写作前注入角色第一人称预测。

### 1.3 风格个性化（论文侧，最相关）

- **EMNLP 2025 Findings《Catch Me If You Can? Not Yet》（Wang et al., aclanthology 2025.findings-emnlp.532）**：
  LLM 用少量样本 in-context 模仿个人风格，在博客/论坛等非正式文体中**显著失败**；只在新闻/邮件等
  结构化文体中尚可。→ 证明**"多轮持续采集 + 隐式风格信号累积"不是可选项，而是必经之路**；
  我们每轮对话提取风格信号、修改即风格教学，正是对该论文结论的工程回应。
- **StyleVector（ACL 2025，aclanthology 2025.acl-long.353）**：训练免费，把"用户写作风格"表示为
  LLM 激活空间中的一个向量，推理时做对比激活引导（steering），存储开销仅为 PEFT 的 1/1700。
  → 我们已有四层风格向量（连续 EMA + 动态维度 + 困惑度签名 + 偏好对），并在 `style-adapter.js`
  预留 LoRA 微调；**激活层 steering 是本项目可写进"未来工作"的最强理论接口**。
- **GhostWriter（arXiv 2402.08855）**：隐式学习用户风格（边写边学）+ 显式教学时刻（手动编辑/标注）。
  → 我们的"每次点改都是风格教学""每轮对话都采集隐式信号"就是 GhostWriter 的中文深度版，
  且我们把用户手改对（edits.jsonl）当作最高置信信号，比 GhostWriter 的"教学时刻"更可量化。
- **Flower & Hayes 认知写作模型（规划→转译→复阅）**：我们已把"复阅"显式化为交付前 revise 阶段。
- **Vonnegut 情绪曲线**：我们已经确定性量化情绪强度；本轮补上张力/信息密度，形成三线节奏曲线。

### 1.4 中文公式化写作（公文/合同）

秘塔公文宣称 98.6% 合规率，讯飞/WPS 主打模板库。这类工具的护城河是**格式合规**（GB/T 9704、
合同条款结构）。我们的 `genre.js` + `export --official`（GB/T 9704-2012 排版）+ 学术/合同导出
已具备同等能力；差异点是它们"模板快但千人一面"，我们"合规 + 个人化"——但**合规率需要更多实测
样本背书**，这是比赛演示时可展示的短板（诚实标注）。

---

## 二、Sculptor 的差异化定位

行业共同短板（也是我们的机会）：

1. 通用工具不建"作者模型"：风格靠一次提示词，不持续学习 → 我们做**持续隐式学习**；
2. 长文工具重"设定/图谱"轻"作者本人"：人物一致性强、作者一致性弱 → 我们做**作者一致性**（双风格 + 修改教学）；
3. 量化只给"打分"不给"可编辑的曲线"：节奏分析停在结论 → 我们做**三线曲线落盘 + CLI/Web 可查**；
4. 伏笔只靠作者脑内记账 → 我们做**伏笔自动记账 + 跨章回收校验**。

一句话：**马良管"作品"，我们管"作者"；Sudowrite 管"生成"，我们管"生成 + 持续校准 + 回收"**。

---

## 三、超越方案（v0.41 执行项）

按"差距最大 → 实现成本可控 → 用户/评委可见"排序：

### A. 三线节奏曲线（对标行业第④尺子）

- `style-pulse.js` 新增 `rhythmCurve(workspace)`：把 draft.md 按节切成块，每节输出
  **张力（悬念词/突转/短句密度）、信息密度（实词率）、情绪强度（情绪词归一化）**三条 0-100 曲线；
- 落盘 `vault/curve.md`（人类可读 + ASCII 曲线），CLI `sculptor curve`；
- Web `/api/curve` + 审计页迷你曲线；
- 价值：作者像看心电图一样看到"哪里太平、哪里该提情绪"，并在写作/修改阶段据此二次编辑。

### B. 伏笔记账 + 跨章回收校验（对标行业第③尺子）

- 新增 `agent/src/consistency.js`：
  - `registerClues`：每写一节小说，让 LLM 提炼"本节埋下的钩子/伏笔/意象"（失败时确定性兜底：
    提取长线意象与特殊名词），写入 `state.mystery.clues`，自动去重；
  - `checkConsistency`：全文完成后，逐条检查伏笔是否在后文回收（LLM 判定 + 关键词确定性兜底），
    输出 已回收/未回收/疑似悬空 清单与一致性得分，落盘 `vault/consistency.md`；
- 接入导演：写完初稿（revise 阶段前）自动跑一次，结果进 `state.quality.consistency`；
  未回收伏笔作为 P1 提示进交付消息，不打断流程（LLM 优先、代码只做安全网）；
- CLI `sculptor consistency`，Web `/api/consistency` 可查。

### C. 隐式风格持续学习（对标 GhostWriter + EMNLP 2025 结论）

- `style.js` 新增 `recordImplicitSignals(workspace, text, {round})`：
  每轮用户发言（含"好的""不不不"以外的任意回答）都做一次轻量信号采集，追加
  `vault/style-signals.jsonl`（原文摘录 + 命中维度），并同步刷新一页人类可读
  `vault/style-signals.md`（"本轮我读到了什么"）；
- 导演澄清每轮自动调用；`sculptor style --signals` 可回看；
- 价值：解决"没贴旧稿就没风格"的死角——从第一句话起就累积作者倾向，EMNLP 论文证明这条路必要。

### D. 后续候选（写进论文未来工作，不阻塞本轮）

- StyleVector 式激活层 steering（`style-vector.js` 已留接口）；
- 公共仿写样本库升级为"大规模结构化样本"（library.js 已有骨架）；
- ~~卷级大纲（卷→章→节）与反向级联编辑~~ → **v0.42 已完成**：LLM 输出可选 parts
  卷级分组（长文），sections 仍是写作真源，代码只做规范化；反向级联编辑待后续。
- 多智能体任务编排视图（director 已有 stage 状态机，前端加"各 agent 分工图"即可）。

---

## 四、验收标准

- `agent npm test` 全绿（新增 consistency/curve 测试套件）；
- `web npm test` 全绿（api-smoke 覆盖新端点）；
- `sculptor curve` / `sculptor consistency` / `sculptor style --signals` 在有成稿的工作区可真实输出；
- 导演链路：澄清每轮记隐式信号 → 小说写作每节记伏笔 → 交付前自动校验回收，无新增用户打扰；
- 引擎同步 + 提交，README/CHANGELOG 同步更新。
