# Stylotrace 项目交接摘要（v0.68 · 上下文检查点）

> 用途：换模型 / 换对话 / 换机器时，把本文件（或本文件摘要）交给新会话即可无缝续作。

## 当前状态

- 仓库：`/Users/wallace/Documents/Codex/2026-08-04/bang/stylotrace`
- 版本：**v0.68**，最新提交 `bef66bf`（已推送 `b84656b..bef66bf main -> main`）；工作区有少量待提交改动，详见"工作区状态"节
- 测试基线：agent 24 套 + web 11 套全绿
  - agent 全量：`cd agent && npm test`（约 2–3 分钟，含 e2e 真实 LLM 调用）
  - web 全量：`cd web && npm test`
  - 单测：`node test/<name>.test.mjs`（modulator / stats / token-decode / embedding / author-sheet 等）
- 技能安装点（均已同步 v0.68）：`~/.codex/skills/stylotrace`、`/Users/wallace/Documents/Codex/2026-08-06/zhi/.codex/skills/stylotrace`、`/Users/wallace/stylotrace`

## 工作区状态（2026-08-13 核实）

- 分支 `main`，与 `origin/main` 同步于提交 `bef66bf`。
- **存在未提交改动**（交接前需处理，见下）：
  - `README.md`：版本号 v0.60 → v0.68，"最近的关键升级"改为改迹调制/回避库/姿态层/L3/外层调制器路线
  - `agent/package.json`、`web/package.json`、`skills/stylotrace/scripts/engine/package.json`：版本号 0.64.0 → 0.68.0
  - `agent/src/credentials.js` 与 `skills/stylotrace/scripts/engine/src/credentials.js`：DeepSeek 默认端点改为 `https://api.deepseek.com/v1`、默认模型 `deepseek-v4-flash`，并支持 `DEEPSEEK_BASE_URL / DEEPSEEK_MODEL` 覆盖（避免 .env.local 的模型被硬编码默认值吞掉）
  - `docs/UPGRADE-PLAN.md`：标注 Phase 1 已完成、命名改为改迹调制、十二维
  - `docs/HANDOVER-v0.68.md`：本交接文档（未跟踪）
- 建议：交接前把上述改动作为 v0.68 的收尾提交（如 `chore(v0.68): 版本号与 DeepSeek 凭据覆盖修复`），提交后重跑 agent/web 测试并重同步三个技能安装点。

## GitHub 迁移与网络状态（2026-08-13 更新）

- **两个 Git 仓库（迁移范围候选）**：
  1. 开发工作区：`/Users/wallace/Documents/Codex/2026-08-04/bang/stylotrace`，remote = `zhangyoufu-123/stylotrace`，当前 HEAD `88acd1d`（DeepSeek V4 logprobs 探测，已推送），工作区干净
  2. 发布/镜像仓库：`/Users/wallace/stylotrace`，remote = `zhangyoufu-123/stylotrace-harness`，本地 **13 个提交未推送**（含 v0.68 打包布局、logprobs 结果同步），工作区干净
- **gh 凭据**：`gh auth status` 显示 token 已失效（zhangyoufu-123），`gh api` 连不上 api.github.com
- **网络**：git 全局配置仍指向代理 `http://127.0.0.1:7897`，但代理进程已关；绕过代理直连 github.com 超时。**当前本机到 GitHub 完全不通**，推送与 gh 操作均不可用；DeepSeek API 直连正常
- **迁移待办**（用户确认范围后执行）：
  - 确认是否两个仓库都迁到 org（建议：dev → `org/stylotrace` 为主，harness → `org/stylotrace-harness`）
  - 恢复本机到 GitHub 的网络（重开代理/VPN，或改用可直连的路由并 `git config --unset http.proxy https.proxy`）
  - org/空仓库建好后：`git remote set-url origin https://github.com/<org>/<repo>.git` + `git push -u origin main`
  - 同步更新 README.md、install.sh、agent/package.json 里的 `zhangyoufu-123/stylotrace` 旧 URL

## 论文状态（科创大赛参赛论文）

- **源文件**：`docs/competition/科技论文-Stylotrace.md`（68,561 字节，约 545 行，8 章 + 附录 A/B + 致谢 + 参考文献）
- **成品 docx**：`docs/competition/科技论文-Stylotrace.docx`（945 KB，27 页，生成于 2026-08-13 10:59，晚于 md 10:56，内容为最新）
  - 生成命令：`python3 scripts/gen-paper-docx.py`（OMML 规范公式 69 处，8 张图片已嵌入，图 8 = 学习曲线）
  - 两者均已纳入 git 提交（`bef66bf`）
- **章节结构**：摘要 → 1 引言（问题/研究空白/RQ/贡献）→ 2 相关工作（5 节）→ 3 方法（含 3.1.1 改迹调制 C1、3.1.2 样本复杂度、3.2 四层签名、3.4 澄清协议 C2、3.6 姿态层、3.7 翻译、3.8-3.12 工程形态/大纲/知识库/互操作）→ 4 实验设置（语料/指标/统计口径/盲评/测试规范/可复现性）→ 5 结果（契约测试/文本统计/风格距离/注入对照/作者识别 81.7%/外溢互操作/改迹现状）→ 6 讨论（含四类质疑回应、过程改进、行业补强）→ 7 局限 → 8 结论与展望 → 附录
- **论文关键数字**（已按诚实原则界定）：学习曲线边距 0.286→0.498（n=5→30）；风格距离 0.96 vs ChatGPT 1.24 / DeepSeek 1.10；作者识别融合 81.7%（TF-IDF 基线 82.2%，如实报告未超过）；续写选择 72.2%（随机 50%）
- **支撑材料**（同目录，均已提交）：`learning-curve.json/.png`（图 8）、`style-vectors-*.png`（图 4-7）、`style-space.png`、`architecture.png`、`clarify-flow.png`、`rag-loop.png`、`formula-*.png`、`AUTHOR-ID.md`、`AUTHOR-PREDICT.md`、`STYLE-MATH.md`
- **本地保留、不入库**（.gitignore 明确排除，属比赛过程档案/个人材料）：`查新报告.md`、`PROCESS.md`、`COMPETITION.md`、`BEYOND-PLAN.md`、`PRODUCT-README.md`、`RESEARCH-PAPER.md`

## 目录与文件存放位置

```
stylotrace/
├── README.md                 # 项目说明（v0.68，未提交改动）
├── CHANGELOG.md              # 完整版本历史（到 v0.68）
├── install.sh                # 安装脚本（agent/技能/CLI）
├── Dockerfile / render.yaml / DEPLOY-RENDER.md / DEPLOY-ZEABUR.md
├── .env.local                # 本地密钥（gitignore，勿提交）：DEEPSEEK_BASE_URL/DEEPSEEK_MODEL
├── agent/                    # 引擎核心（Node ESM）
│   ├── src/                  # 61 个模块：modulator/token-decode/personal-model/embedding/
│   │                         #   avoidance/author-sheet/stats/fake-thinking/knowledge/cli 等
│   ├── test/                 # 24 套测试（stats/author-sheet/embedding/fake-thinking/e2e 等）
│   └── package.json
├── web/                      # 单会话 Web 演示版：server.mjs + public/ + test/（11 套 QA）
├── skills/stylotrace/          # 技能包（与 agent/src 同步的 scripts/engine/src）
├── scripts/                  # gen-paper-docx.py / style-vectors.py / style-mds.py /
│   │                         #   author-id.py / author-predict.py / formula-render.py /
│   │                         #   paper-drive.mjs / overflow-summary.mjs / sync-skill-engine.sh
│   └── experiments/          # rsa-learning-curve.mjs + plot-learning-curve.py（图 8）
├── docs/                     # 设计文档：MODULATOR/STYLE-SYSTEM/UPGRADE-PLAN/THEORY/
│   │                         #   INTEROP/UX-PLAN/问询系统升级-v1 等 + HANDOVER-v0.68.md
│   └── competition/          # 论文 md/docx、图、数据、AUTHOR-ID/PREDICT、查新报告（本地）
├── examples/ extras/ site/ .github/ .claude-plugin/ .codex-plugin/
└── web-data/sessions/        # Web 运行期会话数据（gitignore，23 个本地会话目录）
```

## 模型配置（两层，勿混淆）

1. **Codex 对话模型**：由用户在 Codex 界面（模型选择器/设置）选择，Agent 无法自行切换。官方 OpenAI 文档只覆盖 OpenAI 模型；DeepSeek 是否出现在选择器取决于本机环境配置。
2. **Stylotrace 引擎调用的模型**：由 `agent/src/config.js` 读取 `STYLOTRACE_LLM_BASE_URL / STYLOTRACE_LLM_API_KEY / STYLOTRACE_LLM_MODEL`（`.env.local` 里为 `DEEPSEEK_BASE_URL / DEEPSEEK_MODEL`），当前默认 **deepseek-v4-flash**。想切 `deepseek-v4-pro` 改环境变量即可，改完用 e2e/experiment 测试直接验证。
3. 本环境协作工具支持子代理模型覆盖：`deepseek-v4-flash` / `deepseek-v4-pro`（如需 DeepSeek v4 Pro 继续干活，可经子代理运行）。

## 核心理论主线：改迹调制（revision-trace modulation）

把作者每次 point-edit 的（原文→改后→意图，含 ctxBefore/ctxAfter 上下文窗口）当作隐式偏好对，训练外层调制器权重——"修改即标注"。

- **外层调制器**（`agent/src/modulator.js`，十二维特征）：`personal / surface / discourse / stance / knowledge / defect / impedance / vector / embedding / fineread / posture / avoidance`
- 权重由 pairwise hinge + SGD 学习（`trainModulatorWeights`），数据签名变化自动重训（`getModulator`），新编辑对增量更新（`applyEditIncremental`）
- 可解释层：`contributionBreakdown` + `humanRationale`（贡献分解 + 人话理由），`decodeSection` 返回值带 `rationale`
- 训练使用上下文窗口（`ctxJoin`，v0.68）
- **全部特征软性加权，作者保留否决权，无拒绝式硬约束**（用户明确要求）

### 十二维来源

- personal：`personal-model.js`（字符级 n-gram）
- embedding：`embedding.js`（可选 OpenAI 兼容 /embeddings，未配置静默降级；`style-vector.js` 已统一走它）
- fineread：`author-sheet.js`（L3 作者写作清单五问：主张/论证/读者/红线/触发；红线拆句强制保留；签名缓存）
- posture：`fake-thinking.js` 的 `deterministicFakeThinking`（金句排比/路标转折/点题顿悟 → 健康度）
- avoidance：`avoidance.js`（个人回避库，聚合"作者亲手删掉的词"，第 12 维，v0.68 新增）
- stance：`state.constraints`（红线命中）
- 其余：语义规则/统计

### 评分接入

`agent/src/token-decode.js` 的 `decodeSection(cfg, workspace, {messages, temperature, maxTokens, t, generate})` —— 写作每节并行生成 n 候选（`STYLOTRACE_DECODE_N` 可调，个人语料 <200 字符自动降级直接生成），十二维评分选优，返回 `{text, mode, reason, n, breakdown}`（breakdown 含每候选各维得分与 rationale）。`write.js` 的 `writeSection` 已接入。

## 已批准升级方案（docs/UPGRADE-PLAN.md，用户已拍板）

### Phase 1 已全部完成并合入（v0.68）

- A1 命名校准：论文核心从"统一 Token 对比解码"→ **改迹调制**，全文/摘要/贡献重排；贡献一改为"改迹调制：从修改中学习"
- A2 RSA 形式化：编辑对为"带上下文窗口的局部偏好对"，损失 = pairwise hinge + L2
- A3 样本复杂度实验：`scripts/experiments/rsa-learning-curve.mjs` + `plot-learning-curve.py` → `docs/competition/learning-curve.json/.png`。结果：留出得分边距 0.286→0.498、权重稳定性余弦 0.968→0.999 随 n=5→30 单调改善，n≈15–20 进入平台。论文新增 3.1.2 与图 8
- A5 论文结构重排：摘要第一句"一个从作者每一次亲手修改中学习个性化风格的创作伙伴"
- B1 个人回避库（第 12 维）
- B2 上下文窗口编辑对（`workspace.absorbEdit` 与 point-edit 记录 ctxBefore/ctxAfter ±160）
- B7 可解释层（贡献分解 + 人话理由，写入得分分解）
- C1 embedding 统一（`style-vector.js` 删除 embedDense 重复实现）
- C4 doctor 检查（新增神经风格编码/调制器/作者清单项）
- D1 盲评统计：`agent/src/stats.js`（精确二项 `exactBinomialP`、Wilson CI、Cohen's h、`parseBlindCsv`）；CLI `stylotrace experiment blind-stats <answers.csv>`（表头 pairIndex,choice,correct，choice A/B/'' 或 none）；新增 `test/stats.test.mjs`

### Phase 2 清单（未开工，下一步候选）

1. B3 意图分流训练（按 intent 分组，事实/格式修改不进风格统计）
2. B4 状态向量化（调制器输入 t 从标量 → {进度, 情感浓度, 张力, 距结尾}，风格"时间导数"）
3. B5 增量收敛控制（批量 vs 增量自动权衡）
4. C2 decodeSection 四段式重写（生成→特征→评分→解释解耦，保持返回值契约）
5. C3 导演决策日志（director-log.jsonl）
6. D2 作者识别重定位（主实验"续写选择 + 盲评"，置换检验）
7. D4 语料脱敏流程
8. E1/E2 Web 可视化（调制器权重表、作者清单交互面板）
9. C5 技能同步脚本化、C6 测试快集/深集拆分

### Phase 3（挂起）

B6 V2 logprobs 探测（先探测 API 是否支持再决定，不支持就文档化降级）、A4 姿态层一致性实验、D3 多语言初测、E3/E4。

## 用户核心偏好与约束（重要，勿违背）

1. **诚实优先**：回答产品/论文真实水平要直说，不吹牛；论文中已如实界定"候选级评分非逐 token""作者识别 81.7% < TF-IDF 82.2%""无第三方盲评/显著性"
2. **软性引导，无硬约束**：所有特征（含红线/姿态层判据）只参与加权排序与审计报告，不拒绝生成；STYLE-SYSTEM 已明确移除"红线硬约束"计划
3. **命名自然，不造生硬缩写**："改迹调制（revision-trace modulation）"已采纳；不要再发明 ACCM 之类缩写
4. **暂不做商业化**：先完善功能
5. **Web 端目标**：实时大纲可视化、各会话互不影响、人机交互优秀、无登录（已删除）
6. **论文要拿科创最高奖**：突出真实创新（改迹调制/姿态层诊断/澄清协议+外溢优先），承认局限；"编辑即标注"是第一贡献
7. **真实人名不要出现在论文实验里**（已匿名化）
8. **数学公式规范**（OMML 已修过，`gen-paper-docx.py` 支持 `$...$` 行内公式）

## 关键文件地图

- 论文源：`docs/competition/科技论文-Stylotrace.md`；生成 docx：`python3 scripts/gen-paper-docx.py` → `docs/competition/科技论文-Stylotrace.docx`（27 页，OMML 69 处，图 8 已嵌入）
- 设计文档：`docs/MODULATOR.md`、`docs/STYLE-SYSTEM.md`、`docs/UPGRADE-PLAN.md`、`docs/问询系统升级-v1.md`
- 引擎核心：`agent/src/{modulator,token-decode,personal-model,embedding,avoidance,author-sheet,stats,fake-thinking,knowledge}.js`
- CLI：`agent/src/cli.js`（`stylotrace modulator [--train] [--export]`、`stylotrace author-sheet [--refresh]`、`stylotrace experiment blind-stats`；doctor 新增检查）
- 技能引擎须与 agent/src 同步：`skills/stylotrace/scripts/engine/src/`（改动 agent/src 后需同步；`diff -rq agent/src skills/stylotrace/scripts/engine/src` 检查）

## 实验数据（论文中用的关键数字）

- 学习曲线（图 8）：n=5→30，留出边距 0.286→0.498，权重稳定 0.968→0.999
- 风格距离：Stylotrace 与匿名真人样本平均 0.96（ChatGPT 1.24 / DeepSeek 1.10）
- 作者识别 n=180：融合 81.7%（TF-IDF 基线 82.2%，**未超过，如实报告**）
- 续写选择 n=72：融合 72.2%（随机 50%）
- 契约测试：agent 24 套 + web 11 套（300+ 断言）

## 测试注意

- 全量 agent 测试约 2–3 分钟；`author-sheet.test.mjs` 第 3 步已注入 mock LLM（勿改回真实调用，否则每个测试 10 秒）
- e2e 会真实调用 DeepSeek（有密钥），doctor 检查含 LLM 连通
- 新增/修改 agent/src 后要同步 `skills/stylotrace/scripts/engine/src/`，否则技能安装点落后

## 下一步建议

1. 若用户切换模型：区分 Codex 对话模型（用户侧 UI 选择）与 Stylotrace 引擎模型（改 `STYLOTRACE_LLM_MODEL=deepseek-v4-pro` 并跑测试验证）
2. Phase 2 建议从 B3 意图分流训练 或 E1/E2 Web 可视化 开始
3. 盲评样本收集依赖用户找人（工具已就绪：`stylotrace experiment run` → blind.json → blind-stats）
