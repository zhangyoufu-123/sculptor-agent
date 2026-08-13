# 外层调制器（Outer Modulator）· v0.64

> 路线判断：未来的个性化 AI 不是"每个用户微调一个大模型"，而是"每个用户一个轻量的
> 外层调制器，在推理时实时调制通用模型的行为"。相比 LoRA，它更轻、更快、更适合
> 小语料场景——不改变基座参数，在评分/采样空间注入；且每一个偏置都可解释、可追溯。

## 一、核心公式

$$S(x \mid c, t) = w_0 + \sum_i w_i\, f_i(x, c, t) + w_{\mathrm{personal}}\, \log p_{\mathrm{personal}}(x)$$

- `f_i`：八维可解释特征函数（见下表），把"作者会怎么选"分解成可测量的选择维度；
- `w_i`：**调制器权重 = 每个用户独有的外层参数**，由作者自己的偏好对学习而来，
  表示作者在该维度上的"坚定度/回避度"；
- `p_personal`：字符级 n-gram 个人模型，提供"作者下一步更可能怎么写"的条件信号。

推理时对每个候选文本求 `S`，选优——通用模型负责"生成候选"，调制器负责"选出
更像作者的那一个"，并把每一处选择的原因写进得分分解。

## 二、八维特征函数族（全部确定性、可解释、可追溯）

| 特征 | 含义 | 实现 |
| --- | --- | --- |
| personal | 作者条件分布（n-gram 个人模型） | `personalLogProb` |
| surface | 表层：句长波动/短句占比/TTR/意象密度 | `surfaceFeature` |
| discourse | 中层：设问/非排比重复/对话性 | `discourseFeature` |
| stance | 深层：红线词命中（用户定死不许改） | `stanceFeature` |
| knowledge | 内容：个人知识库术语重合 | `knowledgeScore` |
| defect | 缺陷：AI 腔连接词/套话负偏置 | `defectScore` |
| impedance | 阻抗：随写作进度 t 的节奏调制 | `impedanceScore` |
| vector | 元层：作者 L1 风格向量方向余弦 | `vectorFeature` |

知识（`knowledge`）与风格（其余七维）严格分离：知识走内容通道，风格走选择通道。

## 三、纯净数据收集（动态、只收作者亲手确认过的信号）

| 来源 | 可信权重 | 说明 |
| --- | --- | --- |
| `vault/style-samples/*.md` | 1.0 | 作者主动提供的旧稿 |
| `vault/edits.jsonl` 的 changed | 0.7 | 作者亲手判定"要这个" |
| `vault/edits.jsonl` 的 original | — | 作者亲手判定"不要这个"（负例） |
| `vault/library/*.md` | 0.4 | 作者归档作品 |
| `draft.md` | 0.4 | 迭代确认过的当前成稿 |

**排除项**：检索回灌内容、LLM 生成且未经确认的文本、知识库条目本身——它们不是
"作者如何写"的证据，只走内容通道。

## 四、小数据权重学习（签名 → 模型的关键一步）

**输入**：至少 2 个编辑对 `(original → changed)`，几十个即可稳定。

**目标**：作者改后的文本得分高于原文（pairwise ranking）。

**算法**：z-score 归一化 → hinge 损失 `max(0, margin − (S_changed − S_original))`
→ SGD（lr=0.05，L2=0.02，权重裁剪 ±15，300 轮，确定性零起点）。

**在线重训**：`collectModulatorData` 输出数据签名（文件集合 + 编辑对数）；
签名变化 → 缓存失效 → 自动重训并写回 `vault/modulator-weights.json`，无需重启。

**可解释性**：权重表直接回答"这位作者在哪些维度上坚定、在哪些维度上回避"。
例如某作者编辑对学出的权重 `defect=0.11, surface=0.06, impedance=0.07`——
说明 TA 的修改主要体现为"去掉 AI 腔、句长更错落、后期节奏更短"。

## 五、推理注入

- `token-decode.js` 升级为 **V1.5**：每节并行生成 n 个候选 → `modulate()` 八维评分
  → 选优 → 得分分解（八维特征 + 权重 + 训练标记）；
- 无编辑对/语料不足 → 自动降级为经验默认权重（等价 v0.62 行为），不阻塞不报错；
- 写作、定点修改、风格重写等所有走 `decodeSection` 的路径自动获得调制能力。

## 六、验证

- `agent/test/modulator.test.mjs`：数据收集、权重学习（改后 > 原文）、九维分解、
  特征区分度、数据不足降级、数据变化在线重训；
- `agent/test/embedding.test.mjs`：神经原型落盘/缓存/签名重算、第 9 维 embedding 特征、
  知识库语义混合检索、调制器增量在线更新；
- `agent/test/author-sheet.test.mjs`：作者写作清单五问、红线强制保留、第 10 维 fineRead；
- agent 全量 23 套 + web 11 套回归全绿；
- CLI：`sculptor modulator [--train] [--export] [工作区]` 查看状态/强制重训/导出权重。

## 七、与论文理论的关系

这是"统一 Token 对比解码框架"从 V1（固定权重候选对比）到 V2（逐 token logprobs）
之间的 **V1.5 里程碑**：权重不再手调，而是从作者的偏好对中学出来——外层调制器
成为一个**真正的、属于每个用户的轻量模型**，而不是一组经验系数。v0.65 加入可选
embedding 神经原型（第 9 维）、知识库 BM25+语义混合检索与增量在线更新；v0.66 加入
L3 作者写作清单 fineRead（第 10 维）——深层立场/红线/触发直接参与生成评分；
V2/V3（logprobs 重排、本地 DExperts/激活转向）仍按 STYLE-SYSTEM.md 路线推进。

## 八、局限与下一步

- 增量在线更新已落地（v0.65，`applyEditIncremental`）；仍待做批量与增量策略的自动权衡；
- embedding 神经编码为可选（需配置 API）；L3 作者写作清单已落地（v0.66），
  姿态层六层细读的结构化判据入特征待接入；
- 权重学习的消融（默认权重 vs 学习权重 vs 逐模块关闭）与第三方盲评尚未完成；
- 逐 token 级调制（V2 logprobs）需要模型接口支持，是下一步主攻方向。
