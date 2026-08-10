# Changelog

## 2026-08-10（比赛成果 · 研究论文）

- **新增 [docs/competition/RESEARCH-PAPER.md](docs/competition/RESEARCH-PAPER.md)**：
  正式研究论文《SCULPTOR：以"作者建模"为中心的深度协作写作 Agent》——
  形式化"风格 = 个体表达对完美表达的结构化偏离"的差异弥补模型、四层风格表征、
  双风格分离原则、PKB 三纪律、认知写作流程实例化；并给出对照/消融/用户盲评
  三个实验的完整设计（待采集数据后补充结果章节）。

## 2026-08-10（发布版 0.23.0 · 比赛材料）

- **版本对齐**：package.json / MCP serverInfo / CLI help 统一到 0.23.0。
- **比赛材料**：新增 [docs/competition/PRODUCT-README.md](docs/competition/PRODUCT-README.md)
  （面向评审/用户的产品 README）与 [docs/competition/COMPETITION.md](docs/competition/COMPETITION.md)
  （论文式技术报告：摘要/相关工作/系统设计/核心方法/评估/参考文献）；
  根 README 增加产品总览与比赛文档入口。

## 0.23.0 (2026-08-10)

### Added（全盘优化：圣经 · 复阅循环 · 迁移 · 护栏 · 场景扩展）

- **文章圣经**：长文/小说交付自动沉淀跨篇一致性文档（世界观/角色/时间线/伏笔/文风/连贯性），
  `sculptor bible list|view|save|distill`；续写时读取注入。
- **复阅-修订循环**（Flower & Hayes）：初稿完成后、红队前全文复查（偏题/衔接/素材用足/字数），
  P0 自动局部修订一轮（长文 ≥3 节、最多 1 轮、静默）。
- **多轮数据补给上限**：回灌重写后仍缺素材 → 再排队一轮（最多 2 轮），满上限交付带警告。
- **知识库迁移**：`sculptor knowledge export|import`（按标题去重合并、含提问记录、隐私提示）。
- **风格过拟合护栏**：侧写注入提示"习惯而非牢笼，可突破"；提示词动态预算裁剪
  （超预算优先保风格适配卡，裁侧写/统一素材）。
- **修辞同一性**：侧写新增"与读者建立共鸣的方式"维度，并映射回风格向量。
- **情绪曲线量化**：`sculptor emotion` 按节输出强度与主导情绪（平静/喜悦/哀伤/愤怒/张力）。
- **场景扩展**：文体库新增投标书/申报书；改写矩阵新增 `classical`（古文风）、`desensitize`（脱敏）。
- **联网内容分级**：网络来源书目入知识库默认置信度 0.5（⚠待核实），注入标注"联网资料·待核实"。
- **测试**：`agent/test/v23.test.mjs`（19 项）；全套 337 项断言全绿。

## 0.22.0 (2026-08-10)

### Added（人物风格肖像 · 内置库 RAG 化 · 去硬编码）

- **人物风格肖像（侧写）**：从个人知识库 + 个人写作库 + 修改记录 + 风格档案 + 复合向量，
  生成可查询的写作人格肖像（`vault/persona.md`：叙述视角/词汇/句式/情感/价值观/套路与盲区/引用习惯）；
  侧写注入大纲与写作（最高优先级），并映射回风格向量（`kind: persona`）。
  `sculptor persona`（查询）/ `--refresh`（重新生成并映射）。
- **内置库 RAG 化（不硬编码、联网优先）**：思想库（荐书）与资产库（文法/诗词/论证）改为
  **联网检索优先、内置 JSON 离线兜底**——未命中自动排队宿主代检（thought-search / asset-search），
  `sculptor rag ingest-assets <results.json>` 回灌 `vault/asset-cache.json`；
  回灌结果中的《书名》自动入个人知识库（source: web-rag，数据互通）；
  `unifiedBrief`/荐书联想缓存优先、内置库兜底；联网荐书可直接展示（`webRecommendation`）。
- **灵活化**：保留确定性兜底（LLM 不可用时流程不崩），但默认路径是"知识库/检索/侧写"，不再只靠写死的列表。
- **测试**：`agent/test/persona-rag.test.mjs`（18 项）；全套 318 项断言全绿。

## 0.21.0 (2026-08-10)

### Added（学术论证链 · 荐书联想 · 角色预演 · 统一素材体系）

- **学术实质能力（不依赖外部学术 agent）**：学术论证链 known→gap→tension→insight→method→
  evidence→limitation（参考 AgenTex / BuildIntroArgumentChain）；澄清可补问缺口/方法/局限；
  大纲与写作按论证链位置推进；学术表达规范注入（限定词/让步反驳/证据纪律）；
  `sculptor academic` 查看论证链 + 成稿完备性扫描（claim/evidence/warrant，结论节加 limitation）。
- **荐书联想**：内置思想库（28 部经典书/理论，`templates/thought-library.json`），按用户主题
  匹配相近作品，用简明语言说明"理论是什么、为什么可以用"；只问一次、可拒绝；
  确认后收入个人知识库；已收录的不重复推荐、相近条目互链。`sculptor recommend`。
- **角色预演（小说/推理）**：持久角色档案（背景/愿望/恐惧/秘密/说话方式/情绪/记忆，
  `vault/characters/`）；写作前按"理想-现实张力"让 LLM 以角色第一人称预测
  心里话/会说的话/具体动作/情绪/下一步（参考 MATE/DiriGent）；预演注入本节写作；
  情绪记忆回写保持连续；无 LLM 确定性兜底。`sculptor character list|add|view|remove|simulate`。
- **统一素材体系**：`unifiedBrief` = 个人知识库 + 检索回灌来源 + 内置写作资产
  （文法连接/诗词典故/论证骨架，`templates/asset-library.json`，确定性防幻觉）；
  大纲/写作联合注入、限量轮换；各库数据互通。
- **测试**：`agent/test/asset-academic-character.test.mjs`（22 项）；全套 300 项断言全绿。

## 0.20.0 (2026-08-09)

### Added（数据回灌闭环 + 自动参考文献）

- **回灌后自动续写**：检索结果回灌晚于最后一次写作、且稿中仍有"【素材不足：还需要××】"的节时，
  导演在交付态自动重写缺口节（用新素材），再重新反 AI 审计后才交付——用户/宿主回灌后
  只需再调用一次 `agent_step`（或说"继续"），无需手动重跑。
- **自动参考文献草稿**：学术论文交付时，从检索回灌来源（rag-cache）自动生成 `references.md`
  （GB/T 7714 / APA），并在交付消息提示；`sculptor citations --auto` 可手动触发。
- **时序记录**：`state.ragIngestedAt`（回灌）与 `state.lastWriteAt`（写作）用于精确判断
  "数据晚于写作"这一自动续写条件；退让协议不变（外部改过的稿仍不覆盖，仅报告）。
- **测试**：RAG 单测新增自动参考文献与回灌时间戳（19 项）；e2e 新增"回灌→自动重写缺口节
  →重新审计"全闭环（共 234 项断言）。

## 0.19.0 (2026-08-09)

### Added（主导式协作 + 实时取数 + 场景全打通）

- **主导式协作协议**：写作生态位内 Sculptor 自主决策（agent_step 状态机），宿主与
  学术/数据分析 agent 作为执行与数据供给方；生态位外完全让位。`probe` 输出细分入口
  （academic/official/creative/style/outline/point-edit）与启动建议（agent/point-edit/none）。
- **实时取数三通道**：澄清（clarify-data）、大纲缺素材节（outline-gap）、写作"素材不足"
  标注（write-gap）自动排队检索；`sculptor rag needs` / MCP `data_needs` 查看待办，
  `rag ingest` 回灌进素材并标记完成；请求去重、不阻塞流程。
- **学术论文闭环**：素材缺口检测（论文/报告/新闻稿必须有可查证的文献/数据）、
  交付时自动检测《引文》并提示生成 GB/T 7714 参考文献；导出走 `export --academic`。
- **MCP 新增 data_needs**（37 个工具）；导演 working 消息携带已排队检索提示。
- **测试**：`agent/test/rag.test.mjs`（16 项实时取数单测）；e2e 增加学术澄清自动排队
  → rag needs → ingest 回灌 → 待办完成全闭环（共 231 项断言）。

## 0.18.0 (2026-08-09)

### Added（个人知识库 PKB：把"读过什么 + 经历"沉淀成用户的独有资产）

- **归纳式采集**：澄清时用户提到《书名》→ 只问一次"如果《X》是你读过/喜欢的作品，告诉我一声"；
  答"读过/喜欢"自动收录，答"没读过"记已问过不再追问（`asked.jsonl` 去重）。
- **地点与构想**："去过/参观过 ×" 收录为 `place`；主题明确且库中无相关时，每会话最多一次
  泛问"这个话题你读过什么书、或去过相关的地方吗？"。
- **人可读存储**：`vault/knowledge/<id>.md`（JSON 头 + Markdown 笔记，0600），
  可阅读、可编辑、可带走；CLI 管理 `sculptor knowledge list|search|view|add|remove`。
- **轮换注入**：大纲与每节写作按主题 BM25 检索注入 `【作者知识库·辅助参考】`，
  未用条目 +0.2 / 用过的按次数递减（封顶 -0.45），绝不反复引用同一本。
- **测试**：`agent/test/knowledge.test.mjs`（25 项：收录/去重/匹配/轮换/提问去重/归纳一问）；
  `npm test` = knowledge + e2e 全链路。
- 设计参考：MemGPT 分层记忆 / Alexandria 来源可引 / memories-off 代码化管理 / read-aware 引导访谈
  → `skills/sculptor/references/knowledge.md`

## 2026-08-09（产品方向收敛）

- **放弃应用路线**：删除独立 Web 应用（sculptor-app）与桌面 IDE（agent-studio）及全部应用产物/文档；
  本仓库（引擎 / CLI / skill / MCP）即产品，专注把 agent 做深做透并开源分发。

## 2026-08-07（仓库结构）

- **Web 前端从本仓库移除**：拆分为独立应用仓库 `sculptor-app`（`../sculptor-app`，面向非技术用户，
  自带引擎快照、零依赖、可 Docker 部署）。本仓库只保留引擎 / CLI / skill / MCP，不再含任何 Web 代码。
  引擎同步：`bash ../sculptor-app/scripts/sync-engine.sh`（单一事实源仍是本仓库 `agent/`）。

## 0.17.0 (2026-08-07)

### Added（四层复合风格向量：把"风格 = 不规范表达与完美表达的差异"从理论落成实时向量）

- **L1 连续向量**：作者语料 embedding（默认稀疏字符二元组，零依赖；`SCULPTOR_EMBED_BASE_URL/API_KEY/MODEL`
  可升级真实 embedding）相对基线语料的方向差，EMA 增量更新（`SCULPTOR_STYLE_EMA` 调跟手度，
  `SCULPTOR_BASELINE_TEXT` 提供通用基线）。
- **L2 动态稀疏维度**：基础 write/read 高置信轴 + 意象子维（联想库/注意力焦点）+ 偏好轴（修改意图归类）
  + 素材维（反复实词自动衍生）。权重 × 新鲜度衰减，限量注入提示词。
- **L3 困惑度签名**：确定性代理指标（少见二元组占比 + 低重复率 + 句长方差）累计作者 min/mean/max；
  红队审计对照本文——surprisal 明显低于作者基线 → 标记"比本人更顺"的 AI 平滑痕迹（软提示，不计硬失败）。
  `SCULPTOR_PERPLEXITY_ENDPOINT` 可换真实端点。
- **L4 偏好对**：point-edit / 修改建议 = (原文, 改后, 意图) 最高权重风格证据，落 preferencePairs 并同步偏好轴。
- **混合检索**：风格记忆检索升级为 BM25 + 向量余弦加权（相关度 0.42 / 向量 0.26 / 时间衰减 0.18 / 重要性 0.14），
  无旧稿时也能注入实时向量维度与人类化签名。
- **全链路每轮刷新**：澄清/大纲/写作/改写/定点修改/风格方向/修改建议 7 个触点自动刷新
  `vault/style-vector.json`；新 CLI `sculptor style-vector [--refresh]` 查看/重算。
- 压缩守卫 `refreshFingerprint` 纳入风格向量摘要（动态维度 + 困惑度签名 + 偏好对计数），
  压缩时风格不被遗忘。

### Changed

- 版本 0.16.0 → 0.17.0（CLI HELP / package.json / 文档同步）。

### Added（一键安装与三处自更新）

- `install.sh` 升级为**一次命令装/更新三个安装点**：`--all` = 全局 skill
  （`~/.codex/skills/sculptor`）+ 当前项目 skill + 开发镜像（默认 `~/sculptor`）；
  `--update` 先 `git pull` 再同步；`--dry-run` 全流程预览。
- 镜像同步是**选择性同步**（agent/skills/scripts/examples/extras/.github/.claude-plugin/
  .codex-plugin + 根文档），保留你的 `.git`、`node_modules`、`.env.local`，不整树 --delete。
- skill 内置自更新器 `skills/sculptor/scripts/update.sh`：安装后任意位置一条命令
  `bash ~/.codex/skills/sculptor/scripts/update.sh [项目目录]` 即可刷新三处。

### Added（篇幅预算：根治长文注水）

- 新增 `budget.js`：目标字数 → 节数（每节 ~360 字）/ 每节字数 / 素材下限（每 ~350 字 1 条）/
  论点下限（议论文/报告每 ~900 字 1 个）/ 事项下限（公文系每 ~600 字 1 条）。
- 澄清新增**目标字数必问维度**（中/阿数字解析：`三千字`/`3000字`/`大约一千字`），
  未确认按文体猜测（学术 4000 / 小说 3000 / 演讲稿 1200…），写作前必须对齐。
- 素材/论点门槛随篇幅动态放大：1000 字 → 素材 ≥3；3000 字 → 素材 ≥9、约 8 节。
- 大纲生成注入【篇幅预算】：按目标字数拆节，每节必须分配用户素材，缺素材的节要标"需补充"。
- 大纲评审新增硬检查：节数低于预算 → high；每节 >550 字 → mid；无素材的节 → high；素材闲置 → mid。
- 扩写纪律：优先写透本节分配素材，素材写尽仍不足 → 标注缺口让用户补，禁止空转套话凑字数。

### Added（结构性 AI 痕迹检测：从《差生》长稿审计提炼）

- `audit()` 新增 `structuralSignals`：章节开头单句定场（≥60% 章 ≤8 字开头）、章节结尾金句收束、
  三连排比（连续 6 句同句首 ≥3）、同语反复（"A是A，B是B" ≥3）、重复动作模板（"数…，数到…" ≥3）、
  内心话"不出口"收束（≥3）、单字句意象重复（"白的。"句尾 ≥3）、对话口头禅（同句 ≥5）。
  命中即进 suggestions 与 `--fix` 修订清单（结构性痕迹一起改，不只改单句）。
- 修复重复比喻漏检：喻体归一化剥离"在/着/正"等衬字——"像赶火车"与"像在赶火车"现在算同一喻体。
- 红队日志与 MCP 输出带 `structuralSignals` 计数。

## 0.16.0 (2026-08-07)

### Added（动态规划：文体驱动的澄清蓝图，不再一套 9 项框死所有写作）

- **genreBlueprint(name)**：每类文体定义自己的澄清维度——公文系问"事由/主送/依据/事项要点"
  （不问立意/论点/情感）；合同问"当事人/标的/条款要点"；小说（新增文体，含欧亨利式
  反转/伏笔骨架）问"情节架构/反转落点"；论文才要"支撑论点×N"；散文/演讲稿/记叙文
  默认蓝图去掉"论点"，保留主题/立场/读者/素材/立意/情感/结尾/风格底稿。
- **澄清状态机动态化**：`missingNeed` / 核心门槛 / 蓝图确认 / 访谈清单全部按当前文体蓝图
  计算；提问提示词注入【本蓝图字段】，LLM 只问蓝图里有的维度；
  `classifyAnswer`/`applyAnswer` 支持新字段（items/recipient/basis/plot）。
- **大纲门槛动态化**：gate() 按文体判断——散文不再强制"支撑论点×2"，
  议论文/学术/报告才要求；公文要求事项/依据。
- **访谈清单动态渲染**：`interview` 的确认清单随文体变化（通知 → 事项/主送，无论点）。
- 新增文体「小说」（欧亨利式：开场→冲突→伏笔→反转→余味）。

### Changed

- 版本 0.15.0 → 0.16.0（CLI HELP / MCP serverInfo / package.json / 插件清单同步）；
  e2e 202 项全绿。

## 0.15.0 (2026-08-07)

### Added

- **对话级双风格提炼**：澄清收尾自动把用户全部发言（素材/感受/修改意见）做 LLM 综合，
  提炼"人想写的（write）"与"人想听的（read）"双风格 + 联想库 + 惯用手法 +
  write-read 差异（如"想写克制低气压，读者需要最后一点亮的余味"），合并进档案并带
  "对话整体提炼"证据——**用户没贴旧稿也能在进入大纲前建立高层次风格档案**
  （《再见》测试暴露的根因：深层提取只对旧稿样本跑，对话里的物象/暗喻/收束偏好被浪费）。
- **深度审阅 Review（核心闭环）**：`sculptor review [--fix]` 聚合红队审计 + 校对 +
  事实核查 + 原创性 + 风格保真 + 读者群像/交锋，输出 **P0 硬伤 / P1 建议 / P2 争议 /
  读者亮点**；`--fix` 自动修复 P0（红队修订 + 风格低分按建议重写）并复检。
  支持 `--file`（外部文稿，修复写回目标文件）与 `--quick`。MCP 工具 35 → 36（`review`）。

### Changed

- 版本 0.14.0 → 0.15.0（CLI HELP / MCP serverInfo / package.json / 插件清单同步）。

## 0.14.0 (2026-08-07)

### Added

- **凭据自动发现** `credentials.js`：未显式配置 `SCULPTOR_LLM_API_KEY` 时，自动读取宿主
  已配置的可用 API——Codex `~/.codex/config.toml`（model_providers 的 `base_url` +
  `experimental_bearer_token`/`env_key`）、Claude Code settings.json（env 块）、
  OpenCode 配置、常见 `*_API_KEY` 环境变量。显式 `SCULPTOR_LLM_*` 永远优先；
  只自动采用 OpenAI 兼容协议（Anthropic 仅检测提示）；密钥绝不打印（只显示来源与末 4 位）。
  `SCULPTOR_CREDENTIALS=auto|ask|off` 控制模式（默认 auto）。
- **CLI `credentials`**：列出/采用候选（`--use N`）、交互选择或手动输入（`--ask`，
  保存到 `.sculptor/credentials.json`，0600）、`--clear` 清除；`doctor` 显示凭据来源（脱敏）。

### Changed

- 版本 0.13.0 → 0.14.0（CLI HELP / MCP serverInfo / package.json / 插件清单同步）；
  e2e 全绿（含凭据脱敏/Codex 解析/显式优先/0600 存取断言）。
- **装完即用增强**：`agent` / `interview` / `clarify` 自动初始化工作区（无需先 `init`）；
  `install.sh` 安装完成后**自动注册本项目**（Codex 项目级 MCP + skill + 凭据，零手动、
  零全局副作用）；`--no-setup` 跳过、`--setup-all` 同时注册 Claude Code/OpenCode。
  新开对话直接说需求即启动。

## 0.13.0 (2026-08-07)

### Added

- **联网 RAG** `rag.js`：事实核查 verify 项自动生成检索查询；配置
  `SCULPTOR_RAG_ENDPOINT/SCULPTOR_RAG_API_KEY` 时直连 `POST /search {queries}` 并回灌，
  否则把 web-search 请求写入 `protocol/requests.jsonl`（宿主代检，`sculptor rag ingest`
  或 MCP `rag_ingest` 回灌缓存与素材）。缓存 `vault/rag-cache.json`；
  CLI `rag status/search/ingest`，MCP `rag_search/rag_ingest`。
- **静默内部质量门（真实触发、不刷屏）**：导演交付前自动执行——风格保真评估（低分自动
  微调最多 2 轮）、原创性检查（文内重复句/与个人库自我复用/模板句）、校对扫描、事实核查 +
  RAG 检索请求；全部写入 `state.quality` 与 context 日志，交付消息不再罗列评估过程。
- **内置原创性检查** `originality.js`：`sculptor originality [--file]` 手动查看；
  交付前静默自动执行，MCP `originality`。

### Changed

- 版本 0.12.0 → 0.13.0（CLI HELP / MCP serverInfo / package.json 同步）；
  MCP 工具 32 → 35；e2e 180 项全绿。

## 0.12.0 (2026-08-07)

### Added（P1 四项：改写矩阵 / 版本快照 / 全局档案 / 引文管理）

- **一键改写矩阵** `transform.js`：expand 扩写 / condense 缩写（`--target` 指定字数）/
  continue 续写 / polish 润色 / imitate 仿写 / tone:formal|casual|warm|authoritative
  改语气。复用 restyle 的分节改写 + 退让协议（独立实现，不耦合既有模块），改写前后自动快照。
- **版本快照 + 回滚** `history.js`：write / restyle / redteam --fix / transform 前自动
  快照到 `vault/history/`（内容相同跳过，最多 30 份）；`sculptor history` / `rollback [N]`
  （回滚前先存当前版本）。修复 redteam-fix 与 rollback 后草稿哈希不同步、导致误判"外部修改"的问题。
- **全局风格档案** `profile.js`：`sculptor profile export/import` —— 导出 write/read 档案、
  旧稿样本、修改记录、适配卡为 bundle；导入合并语义保守（本地高置信维度不覆盖、证据并集、
  样本/修改按内容去重、本地适配卡不覆盖）。
- **引文管理**：`sculptor citations [--file]` 提取文中《引文》清单；
  `--append refs.json [--style gbt7714|apa]` 先快照再追加参考文献附录。
- MCP 工具 26 → 32（transform / history / rollback / profile_export / profile_import / citations）；
  e2e 170 项全绿。

### Changed

- 版本 0.11.0 → 0.12.0（CLI HELP / MCP serverInfo / package.json 同步）。

## 0.11.0 (2026-08-07)

### Added（补齐 P0：语音口述 / 格式与导出 / 校对纠错）

- **语音口述**：`sculptor dictate <音频...> [--to-draft]` —— whisper/whisper.cpp 转录为素材
  （`SCULPTOR_WHISPER_CMD` 可指定命令；默认自动检测；`--to-draft` 整理成口述草稿）；
  未配置转录器时明确降级提示。外部进程带超时，绝不阻塞主流程。
- **文体库 +4**：学术论文（摘要/关键词/引言/方法/结果/结论/参考文献）、新闻稿（5W1H 导语、
  倒金字塔）、邮件（主题/称呼/正文/落款）、视频脚本（【画面】【旁白】【字幕】分列）；
  个人写作库自动分类同步支持。
- **参考文献生成**：`sculptor cite "<条目>" --style gbt7714|apa` —— 期刊/图书/网页/
  报纸/学位论文/报告，GB/T 7714-2015 与 APA 7 确定性格式化。
- **多格式导出**：`--html`（纯 Node 零依赖）、`--pdf`（reportlab 内置中文 CID 字体）、
  `--srt`（视频脚本台词转字幕，4 字/秒估算）、`--academic`（学术 docx：宋体小四/黑体标题/
  1.5 倍行距）。
- **校对纠错**：`sculptor proofread [--file]` —— 错别字/易混词/叠字/标点/引号配对
  （确定性、毫秒级）+ 语病/搭配（LLM，apiKey 守卫）；`redteam --proofread` 同跑；
  导演交付时确定性校对并提示"N 处需核对"。
- **顺手修复**：`extractInput` 对图片/音频返回 Promise，ingest/clarify 之前未 await
  会静默失败——已改为异步并 await；`dictate` 不再把音频文件误当工作区。

### Changed

- 版本 0.10.0 → 0.11.0（CLI HELP / MCP serverInfo / package.json 同步）；
  MCP 工具 25 → 26；e2e 154 项全绿。

## 0.10.0 (2026-08-07)

### Changed（去臃肿：评估拆进每一轮，不做交付前大考）

- **新增风格脉搏（Style Pulse）**：`style-pulse.js` —— 澄清每轮、大纲生成后、每节写作后
  的轻量风格采集与即时反馈（确定性、零 LLM、几十毫秒）；每节写作的脉搏建议自动注入
  **下一节**提示词，问题不带进下一节。记录落 `vault/style-pulses.jsonl` + `state.stylePulses`；
  `sculptor style --pulses` 可查看。
- **用户修改建议 = 评估反馈**：`applyCorrectionFeedback` —— "这句太文艺了/太啰嗦/更口语/
  结尾收一点"直接收紧/修正档案维度（含负置信微调）并记 correction 脉搏；导演收到这类建议后
  自动按它重写全文（不再只回"要改哪一处？"）。大纲修改意见同样吸收。
- **导演交付链去重**：移除交付前全稿 style-eval 自动环节（每节写作已即时评估）；交付消息
  不再罗列评估过程；风格适配卡改为"素材有变化才重蒸馏"；`SCULPTOR_QUICK=1` 快速模式
  （读者 3 人、跳过交锋与适配卡重蒸馏）。
- 深度全稿评估保留为手动命令 `sculptor style-eval`（不自动跑）。

### Changed

- 版本 0.9.0 → 0.10.0（CLI HELP / MCP serverInfo / package.json 同步）；e2e 141 项全绿。

## 0.9.0 (2026-08-07)

### Added

- **读者交锋辩论（MAJ-EVAL 式多智能体评审）**：8 位"第一读者"反应后，选分歧最大的
  3 位进入交锋——互看最尖锐意见 → 收敛出共识（直接改）/ 争议（作者拍板）/
  优先级（按对读者的伤害排序）；LLM 失败时确定性主题聚类兜底。
  CLI `sculptor debate`，MCP 工具 `reader_debate`；导演交付链自动执行。
- **风格持续微调基建（Panza 式：<100 样本 + PeFT + RAG）**：
  `style-adapter.js` —— ① `--distill` 把旧稿/个人写作库/亲手修改对压缩成风格适配卡
  （写作/大纲/重写时最高优先级限量注入）；② `--dataset` 生成 Reverse Instructions 式
  偏好对 JSONL（point-edit 修改对即偏好对）；③ `--lora` 走 OpenAI 兼容微调接口
  （上传 /files → 创建 /fine_tuning/jobs），未配置端点时给出本地 LoRA 指引；
  新增 `scripts/finetune/style_lora.py`（torch+transformers+peft 本地训练）。
  CLI `sculptor style-adapter`，MCP 工具 `style_adapter`；导演交付时自动蒸馏适配卡。
- **事实核查**：`fact-check.js` —— 确定性扫描数字/年代/引文/人名/机构（零 LLM），
  LLM 复核分级 material（来自素材）/ common（低风险）/ verify（交付前必须核对）；
  记录落 `vault/fact-check.jsonl`。CLI `sculptor fact-check`，MCP 工具 `fact_check`；
  导演交付时确定性扫描并在交付消息里提示"N 处需核对"。
- **风格评估集成评分**：LLM 判断 + 确定性统计按 0.82/0.18 加权（参考 arxiv 2508.06374：
  集成指标优于单一指标）。

### Changed

- 版本 0.8.0 → 0.9.0（CLI HELP / MCP serverInfo / package.json 同步）；
  MCP 工具 22 → 25；导演交付链：… → 风格保真评估 → 读者群像 → **读者交锋** →
  交付（含事实核查提示 + 风格适配卡自动蒸馏）。

## 0.8.0 (2026-08-07)

### Added

- **风格保真评估闭环（Style Fidelity Eval）**：交付前自动对照作者本人的旧稿样本 +
  亲手修改对给草稿打"像不像你"的分数（参考 EMNLP 2025《Catch Me If You Can? Not Yet》
  与 WritingPreferenceBench 的偏好对比思路）。LLM 逐句对照打分（14 维），失败时确定性
  统计兜底（词汇重叠/句长分布/反 AI 黑名单），评估历史落 `vault/style-eval.jsonl`；
  低分时把漂移证据写回风格档案（只加 evidence、不覆盖维度值）。导演交付链自动执行，
  低分自动针对性重写一轮。CLI `sculptor style-eval`，MCP 工具 `style_eval`。
- **大纲评审-修订回路（CogWriter / WriteHERE 式规划→评审→重规划）**：大纲生成后按
  立意贯穿/论点-功能匹配/逻辑递进/素材利用/篇幅分配/文体规范评审，低分且有 LLM 修订版
  时自动替换（用户仍需最终确认）；评审记录入 `state.outlineReviews`。
  CLI `sculptor outline-review`，MCP 工具 `outline_review`。
- **公文国标升级**：文体库补全党政机关公文 15 文种（请示/批复/函/通报/公告/通告/意见/
  决定/决议/命令/公报/议案 + 原通知/纪要/报告/公文）；`sculptor genre` 展示
  GB/T 9704-2012 排版规范；`sculptor export --official [--redhead]` 按国标导出
  A4 公文 docx（37/35/28/26 页边距、2号小标宋标题、3号仿宋正文、黑体/楷体层级标题、
  右空四字落款、一字线页码、红头可选）。

### Changed

- 版本 0.7.0 → 0.8.0（CLI HELP / MCP serverInfo / package.json 同步）；
  MCP 工具 20 → 22；导演交付链：红队通过 → 风格保真评估 → 读者群像 → 交付。

## 0.7.0 (2026-08-07)

### Added

- **文体库（公式化内容）**：公文/合同/通知/会议纪要/报告/议论文/散文/演讲稿/记叙文——
  每种有结构骨架与行文规范（`sculptor genre <名称>` 查看）；对话中识别文体
  （"写一份关于××的通知/合同"）并在大纲/写作/重写阶段按范式产出。
- **个人写作库**：作品自动分类归档 `vault/library/<类别>/`（议论文/散文/公文/合同…），
  蒸馏成"这类文体你个人的写法"（`vault/skills/personal/<类别>.md`），写作时限量注入
  （不污染上下文）；`sculptor library / scan / view / add` 供查看与维护。
- **多模态输入输出**：对话中给文件路径自动提取（docx 用 python-docx、xlsx 用内置
  zipfile 解析、图片走视觉模型 SCULPTOR_VISION_MODEL）；`sculptor ingest` 提取素材、
  `sculptor export` 导出 docx（导演交付自动导出 draft.docx）。
- 导演交付后自动：归档作品 → 蒸馏个人 skill → 导出 docx。

### Changed

- 版本 0.6.0 → 0.7.0（CLI HELP / MCP serverInfo / package.json 同步）。

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
