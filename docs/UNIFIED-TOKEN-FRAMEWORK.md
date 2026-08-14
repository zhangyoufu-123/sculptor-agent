# 统一 Token 对比框架：现状审计与升级路线（v0.58 评估）

> 目标：把所有个性化元素（风格向量、阻抗、缺陷、知识库）统一进**一个解码机制**。
> 本文回答两个问题：① 现在项目里有没有这个系统？② 能不能升级成完整方案？

---

## 一、审计结论（先说实话）

**当前项目拥有这个框架的"可测量半边 + 文本注入执行层"，但没有"生成时 token 解码层"。**

- 有：风格签名（L1 二元组向量 / L2 14+7 维 / L3 困惑度签名 / L4 偏好对）、
  知识库 RAG、缺陷检测（反 AI 审计 + 假思考六层细读）、节奏/脉搏曲线、双风格分离、
  本地 LoRA 训练脚本（`scripts/finetune/style_lora.py`）、作者识别与续写选择实验
  （AUTHOR-ID / AUTHOR-PREDICT，续写命中 93.3%）。
- 没有：`log p_base(w|c)` 与 `log p_personal(w|c)` 的 token 分布访问、逐 token 评分、
  融合 softmax 采样、随时间变化的阻抗注入。生成仍走"风格以文本形式进 Prompt"
  的常规通道。

一句话：**现在是"测量器 + 提示注入器"，不是"解码调制器"**。但所有测量资产
恰好是统一框架各信号的"观测值"，升级是**把已测到的信号从 Prompt 移到评分函数**，
不是从零造系统。

---

## 二、框架信号 ↔ 现有资产 ↔ 缺口对照

| 框架信号 | 现有资产 | 缺口 |
| --- | --- | --- |
| `log p_base(w\|c)` 基础分布 | DeepSeek/OpenAI 兼容 API（llm.js） | 默认不请求 logprobs；R1 系不支持；`deepseek-v4-flash` 待验证 |
| `log p_personal(w\|c)` 个人分布 | L1 二元组向量、L4 偏好对、双风格档案、style_lora.py | 没有逐 token 个人分布；LoRA 未接入生成 |
| `S_knowledge(w)` 知识信号 | 个人知识库 + RAG（unifiedBrief 文本注入） | 知识只进 Prompt，不进评分 |
| `S_defect(w)` 缺陷信号 | 反 AI 审计黑名单/重复比喻/句式、假思考六层（LLM 细读） | 检测是事后，未转为逐 token 偏置 |
| `S_impedance(w,t)` 阻抗调制 | rhythmCurve / style-pulse（节级曲线） | 无时间维度的解码期调制 |
| 融合解码 | — | 无（V1 用候选对比，V2 用 logits） |

---

## 三、统一评分函数（理论升级核心）

把 THEORY.md 的"风格 = 条件选择偏差"从"可测量签名"升级为"解码期评分"：

$$S(w \mid c, t) = \beta_1 \log p_{\text{base}}(w \mid c) + \beta_2 \log p_{\text{personal}}(w \mid c) + \lambda_K S_{\text{knowledge}}(w, c) + \lambda_D S_{\text{defect}}(w) + R(t) \cdot S_{\text{impedance}}(w, t)$$

$$P(w \mid c, t) = \operatorname{softmax}\bigl(S(w \mid c, t) / \tau\bigr)$$

各信号定义（全部由现有资产直接供给）：

1. **基础分布** `p_base`：通用模型的条件分布。API 支持 logprobs 时取
   `top_logprobs` 近似；不支持时用本地小模型（Qwen2.5-0.5B/1.5B）作替代评分器。
2. **个人分布** `p_personal`：作者"会怎么选"。V1 用 L1 二元组向量 + L4 偏好对做
   候选打分；V2 用 style_lora.py 训练的小模型（Panza 式 <100 样本）输出真实 next-token
   分布。**知识不进 p_personal**——"如何写"与"写什么"严格分离（这正是论文卖点）。
3. **知识信号** `S_knowledge(w,c)`：知识库/检索结果与当前上下文的匹配度——
   作者明确经历的事实（人名/地名/数字/事件）加权；通用检索知识只作弱正偏。
4. **缺陷信号** `S_defect(w)`：作者的系统性回避——AI 连接词/套话/重复比喻/金句收尾
   词表负偏置（来自 redteam.js 黑名单 + fake-thinking 六层判据），逐 token 可追溯。
5. **阻抗调制** `S_impedance(w,t)`：随写作进度 t 变化。初期能量充足，只做轻调制；
   后期 R(t) 升高：惩罚平滑连接词、奖励短句与具体名词——把 rhythmCurve 从"事后曲线"
   变成"生成时节奏"。

**可解释性承诺**：每个被采样的 token 都能回答"为什么选它"——基础模型推、个人模型偏、
知识撑、缺陷压、阻抗调，五路得分可直接输出成报告（这是传统提示工程给不了的）。

---

## 四、工程升级路线（不依赖"大模型给 logits"也能落地）

### V1 · 候选对比解码（v0.62 已落地）

生成不是一次采样，而是：并行生成 N 个候选（N=2，同一上文、不同温度）→ 五路评分选优
→ 得分分解落盘。实现：`agent/src/personal-model.js`（本地字符级 n-gram 个人模型，
作者语料训练，能预测"作者更可能怎么写"）+ `agent/src/token-decode.js`（五路评分
S = 2.0·p_personal + 0.5·S_knowledge + 1.0·S_defect + 0.8·R(t)·S_impedance）；
写作节级接入（writeSection，`STYLOTRACE_DECODE_N` 可调，无个人语料自动降级直接生成）。
单元测试（token-decode.test）验证：个人模型偏好作者风格文本、AI 腔缺陷分更低、
对比选优选出更像作者的候选、得分分解可追溯。

剩余：五路权重消融标定、候选数自适应；V2 logprobs（显式 β₁）、V3 本地 LoRA 全词表融合。

### V2 · 词级 logprobs 调制（API 支持时）

- llm.js 增加 `logprobs`/`top_logprobs` 请求与解析（OpenAI 系可用；DeepSeek
  `deepseek-v4-flash` 需实测）；
- 对每个生成位置取 top-k 候选，套统一评分函数重排后从重排分布采样；
- `β₂` 权重随个人语料量自适应（语料越足，个人分布占比越高）。

### V3 · 本地作者模型混合解码（最终形态）

- style_lora.py 产出的小模型做 `p_personal` 主评分；大模型只当 `p_base`；
- 若本地跑 vLLM：用 logits processor 直接融合全词表分布（真·token 级）；
- 部署形态即用户此前讨论的"随 agent 装一个极小模型"——算法集成优先，
  不要求用户安装重依赖（V1/V2 甚至不需要本地模型，纯规则 + 向量即可）。

---

## 五、理论叙事升级（论文/答辩用）

现有 THEORY.md 的"四层表征"升级为"**签名 → 注入 → 解码**"三段论：

1. **签名**：四层表征回答"这个人是谁"（已实现）；
2. **注入**：双风格/知识/缺陷以文本与档案进入流程（已实现）；
3. **解码**：五路信号进入统一评分函数，逐 token 生效（V1→V3 实现）。

与传统方法的分界一句话：**提示工程"告诉模型怎么选"，LoRA"改模型整体倾向"，
RAG"把知识写进上文"；统一框架"在每一个词的选择上直接重排概率，且每一处重排都可解释"。

诚实边界（评审必问，主动写）：
- V1 是**段级/句级对比**，不是严格意义的逐 token；逐 token 要等 V2 logprobs 或
  V3 本地 logits；
- `p_personal` 在 V1 仍是代理（向量 + 偏好对），不是真实条件分布；
- 五路权重（β/λ/R）需要消融标定，不能拍脑袋；已有消融框架（experiment.js）可复用。

---

## 六、建议落地顺序

1. **理论文档升级**：把本文第三节公式并入 THEORY.md 与参赛论文，新增"解码层"章节；
2. **V1 实现**：`agent/src/token-decode.js`（候选生成 + 五路评分 + 得分分解报告），
   先在写作节级接入（writeSection 后多候选选择），再扩到澄清/翻译；
3. **评分器抽离**：defect 词表、KB 匹配、L1 向量、阻抗曲线各自输出可并行的 score；
4. **消融**：跑"只开风格 / 只开缺陷 / 只开知识 / 全开"四组对照，量化各信号贡献；
5. **V2/V3 按 API 能力推进**（logprobs 实测 / 本地 vLLM）。
