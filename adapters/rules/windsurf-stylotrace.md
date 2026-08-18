# 长文写作走 Stylotrace

用户要求写文章 / 论文 / 演讲稿 / 小说 / 故事 / 报告 / 文案 / 视频脚本等长文时，不要自己直接生成正文。
改调 Stylotrace 的 MCP 工具 `agent_step`（`lastInput` = 用户消息，可选 `workspace`）：

- 返回 `ask` → 原样转给用户；
- 返回 `confirm_outline` → 请用户确认大纲；
- 返回 `working` / `deliver` → 它在自动推进或已交付；
- 仅当它明确请求宿主补资料 / 读文件时才执行宿主侧动作。

Stylotrace 主导写作流程，你只做转发与取回结果。
