# DeepSeek V4 logprobs 探测结论（B6 前置）

> 脚本：`scripts/experiments/logprobs-probe.mjs`
> 日期：2026-08-13 · 实测端点 `https://api.deepseek.com`

## 结果

1. 请求 `logprobs: true, top_logprobs: 5` 时，API 返回 HTTP 200，**但逐 token 概率只出现在
   `choices[0].logprobs.reasoning_content`（思考链 token），不在 `choices[0].logprobs.content`
   （最终答案 token）**。短 `max_tokens` 下最终 `content` 为空——token 预算被推理链吃掉。
2. 未请求 logprobs 时 `logprobs` 为 `null`。
3. 实测模型解析为 **deepseek-v4-pro**（来自宿主 Codex 活跃 provider，评分 170），而非
   `.env.local` 的 `deepseek-v4-flash`（env 候选评分 130）——引擎会继承宿主活跃模型。

## 结论

**V2「逐 token 词级重排」用当前 DeepSeek API 无法直接落地**：它给的是 `reasoning_content`
（模型内部思考）的概率，不是候选成品文本的概率。可选路径：

- a) 换用**非推理（非 reasoning）**模型变体，看是否返回标准 `logprobs.content`；
- b) 若坚持用 `reasoning_content` logprobs，需明确它度量的是「思考倾向」而非「文风选择」，语义不同；
- c) 短期按 B6 既定策略**文档化降级**：V2 保持路线图状态，V1.5 候选级评分继续作为主机制。

推荐先做 a 的一次性探测；若不可得，采用 c 并在论文 7 节「局限」如实保留「逐 token 重排仍为路线图」。
