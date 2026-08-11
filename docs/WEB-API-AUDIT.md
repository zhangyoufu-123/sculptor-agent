# Web 端人机交互接口自检报告

> 版本：v0.48.1 · 2026-08-11
> 方法：静态盘点（app.js 全部 API 调用 vs server.mjs 全部路由，路径+HTTP 方法比对）
> + 动态验证（web 7 套 QA，api-smoke 15 组真实 HTTP 处理器）。

---

## 结论

- **零断链**：前端 30 个 API 调用路径全部存在对应后端路由。
- **零方法不匹配**：29 个唯一调用点的 HTTP 方法（GET/POST/DELETE）与后端完全一致。
- **发现 1 处死元素**：`modePill`（"离线演示"静态标签）HTML 有、JS 零引用，
  版本角标过期（v0.29）→ 已清理并更新为 v0.48。
- `/api/rag/needs` 未在前端直连——这是**供给协议端点**（宿主/学术/数据分析 agent
  用 `sculptor rag needs` 或 MCP `data_needs` 查看待办）；Web 端通过
  `/api/context` 的 `rag.pendingRequests` 展示待办数，检索闭环走
  `/api/rag/search` + `/api/rag/ingest`，无功能缺口。

## 接口清单（29 个唯一调用点，全部接通）

| 前端调用 | 方法 | 后端路由 | 用途 |
| --- | --- | --- | --- |
| /api/start | POST | ✓ | 新建会话，进入澄清 |
| /api/step | POST | ✓ | 导演单步（转发用户消息） |
| /api/session | GET/PATCH/DELETE | ✓ | 会话详情/改名/删除 |
| /api/sessions | GET | ✓ | 会话列表 |
| /api/context | GET | ✓ | 伴随面板（清单/思想/脉搏/进度） |
| /api/transcript | GET | ✓ | 对话记录 |
| /api/outline | POST | ✓ | 实时大纲保存/编辑 |
| /api/draft | GET | ✓ | 读取草稿 |
| /api/save-draft | POST | ✓ | 手写区保存 |
| /api/point-edit | POST | ✓ | 选区点改（吸收风格） |
| /api/rewrite | POST | ✓ | 3 候选改写 |
| /api/rollback | POST | ✓ | 版本回滚 |
| /api/history | GET | ✓ | 版本快照列表 |
| /api/report | GET | ✓ | 审计报告（人类化指标） |
| /api/curve | GET | ✓ | 节奏曲线 |
| /api/consistency | GET | ✓ | 伏笔回收 |
| /api/roundtrip | POST | ✓ | 回译校验 |
| /api/style | GET | ✓ | 风格档案/向量/肖像 |
| /api/knowledge | GET/DELETE | ✓ | 个人知识库 |
| /api/works | GET | ✓ | 作品库 |
| /api/work | GET | ✓ | 单篇作品 |
| /api/works/compare | GET | ✓ | 作品指标对比 |
| /api/overview | GET | ✓ | 首页统计 |
| /api/upload | POST | ✓ | 多模态上传 |
| /api/rag/search | POST | ✓ | 联网检索 |
| /api/rag/ingest | POST | ✓ | 资料回灌 |
| /api/export | GET | ✓ | md/docx/pptx/html/srt/pdf 导出 |
| /api/roundtrip | POST | ✓ | （见上，回译） |

## 交互覆盖矩阵（视图 → 数据源 → 状态）

| 交互入口 | 后端支撑 | 状态 |
| --- | --- | --- |
| 首页开始写作/示例选题 | /api/start + /api/overview | ✓ |
| 澄清问答（一次一问/选项/清单/建议） | /api/step + /api/context | ✓ |
| 大纲 列表编辑/卷分组/图谱定位草稿 | /api/outline + /api/context + /api/draft | ✓ |
| 手写区 保存/查看/选区工具栏/候选卡 | /api/save-draft + /api/point-edit + /api/rewrite | ✓ |
| 版本历史/回滚 | /api/history + /api/rollback | ✓ |
| 专注/并排模式 | 纯前端（无后端依赖） | ✓ |
| AI 洞察（字数/脉搏/节奏） | /api/context + /api/curve + /api/draft | ✓ |
| 上下文面板（理解/素材/思想/风格/RAG/上传） | /api/context + /api/style + /api/rag/* + /api/upload | ✓ |
| 审计页（指标/曲线/伏笔/回译） | /api/report + /api/curve + /api/consistency + /api/roundtrip | ✓ |
| 风格肖像 | /api/style | ✓ |
| 知识库 | /api/knowledge | ✓ |
| 作品库/对比 | /api/works + /api/work + /api/works/compare | ✓ |
| 导出 | /api/export | ✓ |

## 遗留说明

- `/api/rag/needs` 保留给 CLI/MCP（供给协议），前端用 context 展示待办数——若以后
  Web 要展示"待检索队列明细"，直接加一个 GET 调用即可，路由已存在。
- 所有前端请求统一走 `apiGet/apiPost/apiDelete`（非 2xx 抛错 + toast），
  未发现绕过统一封装的裸 fetch。
