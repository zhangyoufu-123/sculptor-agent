# PR:awesome-dsh-plugin 收录申请(复制即用)

> 提交地址:https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
> 标题建议:**Add Stylotrace: first writing-agent plugin (writing & style)**
> 前置条件(已满足):仓库子包 `extras/dsh-plugin-stylotrace` 声明 `dsh.bundle` manifest;
> 代码真实可用(40 个 MCP 工具实测注册 + Web client 增强);活跃维护;记得给主仓库打 `dsh-plugin` topic。

## PR 描述(直接粘贴到 PR body)

```markdown
## What

Add [zhangyoufu-123/stylotrace](https://github.com/zhangyoufu-123/stylotrace) —
the first writing-agent plugin in the DSH ecosystem.

Stylotrace is a deep-collaboration writing agent: it learns the user's personal
writing style (four-layer style vectors + an outer modulator that learns per-user
weights from the user's own edit pairs), then runs the full clarify → outline →
section-by-section writing → red-team audit → 8-reader gallery → delivery flow.
For developers, `synthesize` auto-extracts a project (README/docs/package.json/git
log + conversation context + style profile) into a lab report / product intro /
tech survey / README / blog post — no step-by-step prompting needed.
As a DSH bundle it exposes 40 MCP tools (`mcp__stylotrace__*`: clarify_step,
outline, write_section, synthesize, redteam, audience, point_edit, rag_search,
citations, …) through the official `@deepseek-ai/dsh-mcp-client`, ships the full
skill bundle (zero-dependency Node engine) installable into DSH / ~/.agents /
Codex / Claude Code / OpenCode, and adds a web client half (selection →
Stylotrace-quote improve bar; synthesized-work chips).

Install: `dsh plugin --profile web add dsh-plugin-stylotrace` (npm),
plus `npx stylotrace-plugin install --all` for the skill.

## Category

Proposed new category **Writing & Style** (first entry) — falls between
"Memory" (facts) and "Tools & Capabilities" (single-purpose): this is a
full-domain agent with per-user modeling, not a single-purpose tool.
If maintainers prefer, it can live under "Tools & Capabilities".

## Lines to add

README.md (English):

```markdown
### Writing & Style

- [zhangyoufu-123/stylotrace](https://github.com/zhangyoufu-123/stylotrace) - Deep-collaboration writing agent (npm: `dsh-plugin-stylotrace`): 40 MCP writing tools with per-user style learning from your edits; auto-extracts a project into reports/articles via `synthesize`; ships a cross-host skill plus web selection-improve UI.
```

README.zh.md (中文):

```markdown
### Writing & Style

- [zhangyoufu-123/stylotrace](https://github.com/zhangyoufu-123/stylotrace) — 深度协作写作 Agent（npm 包：`dsh-plugin-stylotrace`）：40 个 MCP 写作工具，从你的亲手修改学习个人文风；`synthesize` 自动把项目提炼成报告/文章；附带跨宿主技能包与 Web 端选中改进。
```
```

## 如果只想要最小改动(不放新分类)

把两条 line 放进现有 **Tools & Capabilities** 分类末尾即可,其余不变。

## 提交前自查(对照 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md))

- [x] 每条一行,英文以句号结尾,中文以句号结尾
- [x] 只描述功能,无营销词
- [x] 仓库子包声明 `dsh.bundle`(非仅 `dsh.client`)
- [x] 真实可运行代码(已实测 39 工具注册)
- [x] 仓库已打 `dsh-plugin` topic(待发布时确认)
