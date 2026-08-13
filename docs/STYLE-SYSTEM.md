# 完整风格体系：从人类风格形成到深层读取，再到解码期控制（v0.63 设计）

> 目标：把"小语料快速抓风格"从"表层指纹"升级为"表层—中层—深层—元层"的完整风格体系，
> 并用解码期控制（DExperts / 对比解码 / 激活转向）把风格变成可调、可追溯的生成时偏置。
> 本设计全部锚定真实文献；每层给出：理论依据 / 信号来源 / 读取方法 / 语料需求 / 泛化性 / 对应现有资产。

---

## 一、风格形成的理论基础：风格是"稳定的选择模式"

**Halliday（1985，系统功能语言学）**：语言是意义资源，话语是对系统网络的一次次"选择"
（meaning implies choice）——风格不是修辞装饰，而是作者在可替代表达之间**稳定地偏向某一侧**。
这为"风格 = 条件选择偏差 S_a(c) = P_a(w|c) − P_0(w|c)"提供了语言学根基。

**Flower & Hayes（1981，写作认知过程）**：写作 = 规划 → 转译 → 复阅。风格选择发生在每个阶段，
其中"复阅/修改"是作者最高密度、最有意识的选择——这为"修改监督（L4）"提供了认知依据：
**"他要的"永远比"他随口说的"更真实**。

**Biber（1988/1995，多维分析 MD）**：表层语言特征（词性/句法/功能词频率）会共现成潜在的功能维度
（如"卷入 vs 信息型生产""叙述 vs 非叙述""抽象 vs 非抽象"）——**表层可以通向深层**，
但必须通过"特征共现 → 潜在维度"的统计桥梁，而不是孤立的几个指标。

**结论**：完整风格体系 = 沿着"每次可观测的选择 → 稳定选择倾向"组织，从最表层（用词）到最深
（立场与价值），层与层之间由"选择倾向的一致性"连接。

---

## 二、四层风格体系

| 层 | 名称 | 理论依据 | 信号来源 | 读取方法 | 语料需求 | 跨主题泛化 | 现有资产 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | 表层·词汇句法层 | Burrows Delta（2002）、Argamon（2008）：高频词/功能词指纹 | 用词偏好、句长节奏、标点、口语度、词汇丰富度 | 统计度量（确定性） | 小（数千字可估） | 弱（易被主题污染） | feats8、L1 二元组、n-gram 个人模型 |
| L2 | 中层·话语修辞层 | Biber MD：特征共现成功能维度 | 意象密度与类型、修辞装置（排比/设问/隐喻）、叙事视角、时间处理、对话比例 | 规则词表 + LLM 细读 | 中（跨文体样本） | 中 | 意象/情绪词表、fake-thinking 六层、rhythmCurve |
| L3 | 深层·认知立场层 | Biber 抽象维度；Author Writing Sheet（arXiv:2502.13028） | 论证结构（主张-前提-推理-来源）、立场/价值取向、情感曲线、读者意识、知识偏好 | LLM 推断 + 交互确认（作者写作清单式访谈） | 高（小语料不可统计） | 强（思想层） | 思想脉络、外溢种子、coreThesis、read-style |
| L4 | 元层·选择偏好层 | Flower & Hayes 复阅；GhostWriter（2024）教学时刻 | 亲手修改、确认、拒绝、红线 | 交互累积（最高密度） | 极少（几十次选择即可） | 最强 | edits.jsonl、overflow-log、annotations、红线清单 |

**四层之间的关键设计**：L1 提供"可测量指纹"，L2 提供"话语习惯"，L3 提供"为什么这样写"，
L4 提供"用户真正要什么"。生成时**分层注入、按层加权**：
表层信号（L1/L2）决定措辞与节奏，深层信号（L3）决定结构与立场，元层（L4）决定"边界"（红线不可越）。

---

## 三、深层风格读取：作者写作清单（Author Writing Sheet）

小语料下，深层风格**不能靠统计读取，必须靠交互确认**。借鉴
"Whose story is it? Personalizing story generation by inferring author styles"
（arXiv:2502.13028，2025）——用结构化"作者写作清单"从旧作推断风格，达到 78% 的捕捉胜率。
SCULPTOR 已有雏形（外溢优先、思想脉络），本轮把它系统化为 L3 读取协议：

1. **主张与立场**：这篇你要让它"相信/感觉到"什么？（已有 stance/theme）
2. **论证与推理**：你心里有没有一条现成推理线/一本书可顺着想？（已有 thinking/borrow）
3. **读者意识**：你最怕读者怎么想？你希望谁看到、谁沉默？（read-style）
4. **红线与边界**：哪句话/哪个情节/哪个词定死了不许改？（constraints/overflow）
5. **触发与参照**：是哪部作品/哪个画面让你现在想写？（trigger/reference）

每条确认都同时写入三层：L3（立场/结构）、L2（若有修辞要求）、L4（红线/偏好）。

---

## 四、注入与解码期控制（外围算法层，可微调）

风格体系的价值只有在生成时被"施加"才成立。外围层 = 一组特征函数 f_i + 一组权重 w_i，
**权重就是外围模型的参数，可以用作者的偏好对/反馈学习**：

$$\log P_{\mathrm{final}}(w \mid c, t) = \log P_{\mathrm{base}}(w \mid c) + \sum_i w_i\, f_i(w, c, t)$$

各方法锚点与落地：

| 方法 | 文献 | 形态 | SCULPTOR 对应 |
| --- | --- | --- | --- |
| 专家/反专家对比 | DExperts（Liu et al., ACL 2021, 2105.03023） | 专家小模型 logits − 反专家 logits | V3：个人 LoRA 为专家、通用为反专家 |
| 对比解码 | Contrastive Decoding（Li et al., ICLR 2023, 2210.15097） | 强模型 vs 弱模型对比 + 合理性约束 | V2：logprobs 下 p_base vs 退化前缀 |
| 前缀自适应解码 | PREADD（Yang & Klein, Findings ACL 2023, 2307.03214） | 无需外部模型，前缀对比 | V2 备选：作者前缀 vs 通用前缀 |
| 激活层干预 | ITI（Li et al., NeurIPS 2023, 2306.03341）；Steering Vectors（Turner et al. 2023）；StyleVector（ACL 2025） | 推理时改激活/加风格向量 | V3+：风格向量激活转向 |
| 权重学习 | 偏好对/奖励优化（DPO 思想） | 用"作者要的 vs 不要的"学 w_i | 近期：用 edits.jsonl 学 λ/β/R |

**V1（已落地，v0.62）**：候选对比解码——每节并行生成 2 候选，五路评分
S = 2.0·p_personal + 0.5·S_knowledge + 1.0·S_defect + 0.8·R(t)·S_impedance，选优 + 得分分解。

**已落地（v0.64–0.66，外层调制器 + 神经风格编码 + L3 作者写作清单）**：
1. **权重学习**：`agent/src/modulator.js` 把 edits.jsonl 的（原文，改后）当偏好对，
   用 pairwise hinge + SGD 学十维权重 w_i——签名正式升级为可学习模型（见 MODULATOR.md）；
2. **十维特征入评分**：表层/话语/立场红线/知识/缺陷/阻抗/风格向量方向 + 个人 n-gram +
   可选 embedding 神经原型 + L3 作者清单 fineRead，全部进 `modulate()` 评分；
3. **在线重训 + 增量更新**：数据签名变化自动失效重训，新编辑对局部 SGD 增量更新，
   权重落 `vault/modulator-weights.json`；
4. **神经风格编码（v0.65）**：`embedding.js` 作者稠密原型 + 知识库 BM25+语义混合检索，
   未配置全部静默降级；
5. **L3 深层读取协议（v0.66）**：`author-sheet.js` 作者写作清单五问（主张/论证/读者/
   红线/触发）自动归纳，红线拆句强制保留，作为 fineRead 特征参与生成评分；
6. **降级保底**：编辑对不足时回退经验默认权重，不阻塞写作。

**下一步**：
1. **姿态层细读判据入评分**：把 LLM 六层细读的结构化输出（声音/过渡/修辞判据）加入 f_i；
2. **红线硬约束**：红线命中直接硬约束（score −∞ 或拒绝生成），立场约束软引导；
3. **批量与增量策略自动权衡**、作者识别显著性检验。

**V2/V3（路线图）**：logprobs 对比（DExperts/CD/PREADD 的 API 近似）→ 本地个人 LoRA
（style_lora.py 已有）做专家模型 → 激活转向（StyleVector 方向）。

---

## 五、验证协议（防止"自证"）

借 "Evaluating Style-Personalized Text Generation"（arXiv:2508.06374, 2025）的三类判别任务
加现有实验，构成完整验证：

1. **域判别（domain discrimination）**：同一题材下，个性化 vs 非个性化文本能否被判别；
2. **作者归属（authorship attribution）**：多作者 × 多篇跨文体，签名归属准确率**显著超过 TF-IDF 基线**（当前 81.7% vs 82.2% 未超过——这是必须攻克的硬指标）；
3. **个性化 vs 非个性化判别**：LLM-judge / 盲评，二项检验；
4. **作者续写选择**：给定前文预测作者下一步（现有 author-predict，需扩大到跨主题混淆集 + 显著性）；
5. **指标集成为主**（2508.06374 结论：集成优于单一指标）。

---

## 六、落地顺序

1. **L2 特征模块**（意象/修辞/视角 → 评分器扩展，token-decode 增加 f 函数）；
2. **权重学习**（edits.jsonl → λ/β/R 拟合，新增脚本 + 单测）；
3. **作者写作清单协议**（L3 澄清问题系统化，接外溢优先）；
4. **验证升级**（多作者 × 跨题材语料 + 显著性 + 盲评）；
5. V2 logprobs → V3 本地 DExperts/激活转向。

---

## 参考文献（本设计依据）

[1] Halliday, M.A.K. An Introduction to Functional Grammar. Edward Arnold, 1985.
[2] Flower, L., Hayes, J.R. A Cognitive Process Theory of Writing. CCC 32(4), 1981.
[3] Biber, D. Variation across Speech and Writing. Cambridge UP, 1988.
[4] Burrows, J. Delta: A Measure of Stylistic Difference. Literary & Linguistic Computing, 2002.
[5] Argamon, S. Interpreting Burrows's Delta. Literary & Linguistic Computing, 2008.
[6] Liu, A., et al. DExperts: Decoding-Time Controlled Text Generation with Experts and Anti-Experts. ACL 2021.
[7] Li, X., et al. Contrastive Decoding: Open-ended Text Generation as Optimization. ICLR 2023.
[8] Yang, K., Klein, D. PREADD: Prefix-Adaptive Decoding. Findings of ACL 2023.
[9] Li, K., et al. Inference-Time Intervention (ITI). NeurIPS 2023.
[10] Turner, A., et al. Steering Language Models with Activation Engineering. 2023.
[11] Zhang, H., et al. Personalized Text Generation with Contrastive Activation Steering (StyleVector). ACL 2025.
[12] Chakrabarty, T., et al. GhostWriter. 2024.
[13] 匿名团队. Whose story is it? Personalizing story generation by inferring author styles. arXiv:2502.13028, 2025.
[14] 匿名团队. Evaluating Style-Personalized Text Generation: Challenges and Directions. arXiv:2508.06374, 2025.
