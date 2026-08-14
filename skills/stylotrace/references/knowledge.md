# 个人知识库（Personal Knowledge Base，PKB）

## 为什么需要它

一个人的联想、理论与作品，都来源于"读过什么 + 个人经历"。AI 的通用智库再大，
也只是底座；真正让文章"像这个作者"的，是他独有的知识——读过的书、听过的理论、
去过的地方、看过的作品、自己反复琢磨过的构想。个人知识库把这份独有资产
沉淀成**用户可读、可编辑、可带走**的文件，而不是埋在对话历史里。

## 三条铁律（与用户确认过的设计原则）

1. **归纳式确认**：用户提出构想时说"这让我想起《X》"或"像去过的地方"，
   AI 主动问一句"你读过/去过相关的什么吗？"——用户同意才记录，不硬塞、不强求。
2. **提问去重**：同一个话题/作品只问一次（`vault/knowledge/asked.jsonl` 记录），
   用户答"没读过"也算已问过，绝不反复追问。
3. **灵活调用**：检索注入只是"辅助参考"，按使用次数轮换（`usageCount` 累积，
   用过的条目分数递减），不用完所有条目、不每篇都翻同一本。

## 存储格式

`vault/knowledge/<id>.md`（`<id>` = 标题 sha1 前 10 位），人类可直接阅读/编辑：

```markdown
---
{
  "id": "a1b2c3d4e5",
  "title": "《我与地坛》",
  "type": "book",
  "author": "史铁生",
  "note": "关于生死、地坛与母亲，荒芜与落日",
  "source": "user-confirmed",
  "usageCount": 2,
  "createdAt": "2026-08-09T…"
}
---
关于生死、地坛与母亲，荒芜与落日
```

类型：`book`（书）/ `place`（去过的地方）/ `theory`（自己的理论构想）/
`work`（看过的作品）。文件权限 0600。

## 采集流程（Phase 1 澄清内嵌，非阻塞）

每轮 `clarifyStep` 末尾调用 `knowledgeSuggestion`：

1. **书名捕捉**：用户提到《书名》且库里没有且没问过 → 生成一句
   "如果《X》是你读过/喜欢的作品，告诉我一声，我会记进你的个人知识库"，
   并立即 `markAsked('book:X')`（只问一次）。
2. **确认收录**：下一轮用户答"读过/喜欢/可以"（`confirmSignal`）→
   `captureKbMentions` 收录；答"没读过"（`declineSignal`）→ 记已问过、清 pending。
3. **地点捕捉**：用户答"去过/参观过 ×" → 收录为 `place`（泛指"很多地方"不收录）。
4. **主题泛问**：若主题明确且库中无相关 → 每会话最多一次：
   "这个话题你读过什么书、或去过相关的地方吗？"
5. pending 机制：悬而未决的书在下一轮被"读过/喜欢"确认时补录；
   用户答了别的 → 清 pending，只问一次，绝不吊着追问。

## 注入纪律（Phase 2/3）

- 大纲与每节写作的 ctx 都带 `knowledgeBrief`，渲染为
  `【作者知识库·辅助参考】（只作联想与素材引子，不强求使用；轮换使用，绝不反复引用同一本）`。
- 匹配用 BM25 字符二元组 + 标题/作者/标签/关联词；未用过的条目 +0.2，
  用过的按次数递减（封顶 -0.45）——相近候选中让位，避免用户起疑。
- 注入不进入状态文件，不污染上下文；用户随时可用
  `stylotrace knowledge` 查看/搜索/增删自己的知识。

## CLI 管理

```bash
stylotrace knowledge                  # 列表（标题/类型/使用次数/收录时间）
stylotrace knowledge search 地坛      # 按主题检索（score 排序）
stylotrace knowledge view 《我与地坛》 # 查看单条（含笔记）
stylotrace knowledge add 《X》 --type book --author 作者 --note 备注
stylotrace knowledge remove 《X》     # 移除（可恢复：从 git/备份恢复该 md）
```

## 竞品/方法参考

- **MemGPT（Letta）**：分层记忆 + 自我编辑——知识按主题检索注入，核心记忆不随上下文漂移；
  Stylotrace 对应：`knowledgeBrief` 每次按主题检索，条目独立于对话历史。
- **Alexandria**：来源可引、人可读——知识条目带 `source` 与 `createdAt`，且是 Markdown，
  用户可以像读笔记一样审阅；Stylotrace 的 `<id>.md` 即此思路。
- **memories-off**：像管代码一样管知识——显式 CRUD + 测试；Stylotrace 的
  `list/add/remove/search/view` 子命令与单元测试（`agent/test/knowledge.test.mjs`）对应。
- **read-aware（研究）**：Agent 引导的简短访谈比一次性问卷更能捕捉阅读背景；
  Stylotrace 的归纳式一问（书名捕捉 + 主题泛问）即此类引导，且用 `asked.jsonl` 防重复。

## 与个人写作库的分工

- **个人写作库（library）**：存"你写过的作品"，蒸馏"这类文体你个人的写法"。
- **个人知识库（knowledge）**：存"你读过的/经历过的"，作为联想的引子。
- 两者互不覆盖：写作库管**产出**的风格，知识库管**输入**的养分。
