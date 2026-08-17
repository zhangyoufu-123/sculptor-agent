# dsh-plugin-stylotrace 全盘审核报告

> 审核时间:2026-08-14 · 审核对象:`extras/dsh-plugin-stylotrace/` 插件包 + stylotrace 宿主项目的产品化面
> 审核目标:交付一个**真正可用、可下载、有效果、会有人用**的 DSH 插件产品
> 方法:结构审核 + 运行时实证(非纸面检查)+ 生态对照 + 安全扫描

---

## 一、审核结论总览

| 维度 | 评分 | 结论 |
|---|---|---|
| 包结构与 manifest | ★★★★★ | `dsh.bundle` 规范、patch 单行、子路径导出清晰 |
| 运行时正确性 | ★★★★★ | 4 层实证:组合/加载/引擎拉起/39 工具注册全部通过 |
| 宿主凭据互操作 | ★★★★★(修复后) | 原缺口:引擎不识 DSH 凭据 → **本次修复** |
| 安装体验(多终端) | ★★★★☆ | 1 条命令装插件 + 1 条命令装 6 个宿主技能点 |
| 文档与叙事 | ★★★★☆ | README 价值叙事完整,主仓库 README 已补 DSH 入口 |
| 发布就绪度 | ★★★★☆ | 包名可用、内容无密钥、零构建;仅剩 npm 账号/缓存权限两步用户操作 |

**一句话**:插件本体已达到"可发布"标准;本次审核修复了**唯一阻断 DSH 用户开箱即用的缺陷**(凭据互操作),并补齐了产品化表面。

---

## 二、审核发现与处置

### 🔴 严重(发布前必须修)

| # | 发现 | 影响 | 处置 |
|---|---|---|---|
| F1 | **引擎凭据发现不识 DSH** | DSH 用户装完插件,LLM 相关工具(写作/审计/群像)静默失败,必须手动设 `STYLOTRACE_LLM_API_KEY`——首因体验断裂 | ✅ 已修:`agent/src/credentials.js` 新增 `discoverFromDsh()` + `parseFlatYaml()`(零依赖),读 `$DSH_HOME/.credentials.yaml`(严格 CredentialRef→string 扁平映射,Models 页管理);新增 `agent/test/credentials.test.mjs` 4 项断言;e2e 全绿 |
| F2 | **SKILL.md 凭据段落未提 DSH** | 模型按技能文档操作时不知道 DSH 凭据已被自动发现,可能误导用户重复配 key | ✅ 已修:`skills/stylotrace/SKILL.md` 凭据段落补入 DSH `$DSH_HOME/.credentials.yaml` |
| F3 | **引擎快照漂移风险** | 修复只落在 `agent/`,若不同步,发布的插件仍带旧引擎 | ✅ 已修:执行 `scripts/sync-skill-engine.sh` 同步技能内嵌引擎,`--check` 校验通过,重新 vendor |

### 🟡 重要(已修/处理)

| # | 发现 | 处置 |
|---|---|---|
| F4 | 插件 `mcp.js` 静态 import `@deepseek-ai/dsh-mcp-client`,在 `link:`/手动符号链接安装下解析失败(实测报 ERR_MODULE_NOT_FOUND) | ✅ 已修:改为惰性动态 import + 解析级联(正常解析 → `$DSH_HOME/profiles/node_modules` → `$DSH_HOME/node_modules`) |
| F5 | SKILL.md 缺 `whenToUse`/`metadata` frontmatter,DSH 模型目录里触发提示弱 | ✅ 已修:补 `whenToUse` + `metadata`(category/author/license/version),对其他宿主无害 |
| F6 | 主仓库 README 无 DSH 入口,生态里搜不到 | ✅ 已修:README「安装」节新增「装进 DeepSeek Harness(DSH 插件)」段落 |
| F7 | 技能包校验:pack 内容含无关文件风险 | ✅ 验证:`npm pack --dry-run` = 111 文件 / 366KB,无 `.git`/`.bak`/`.DS_Store`/密钥(正则扫描通过) |
| F8 | **官方 `@deepseek-ai/*` 包用 dependencies 声明**(社区规范要求 peerDependencies) | ✅ 已修:`@deepseek-ai/dsh-mcp-client` 移至 `peerDependencies`,解析级联兜底 |

### 🟢 本轮产品化升级(新增,均带测试)

| # | 升级 | 说明 |
|---|---|---|
| U1 | **`synthesize` 项目自动提炼**(新引擎模块 + MCP 工具 + CLI) | 从项目(README/docs/package.json/git log/对话上下文/风格档案)自动提炼成**实验报告/产品介绍/技术综述/README/技术博客/文章**;LLM 不可用确定性兜底;产物落盘 `workspace/synthesized/`,可导出 docx/html;`agent/test/synthesize.test.mjs` 4 项断言,MCP 工具面 39→40 |
| U2 | **Web client 插件**(`client.js`,零构建、纯 DOM) | ① 选中文本→「Stylotrace 改进」浮动条→引用块插入输入框(Codex 式选区注释体验,发送后走 point_edit 精修并吸收进风格档案);② 助手消息中的 `synthesized/*` 产出自动渲染为可复制作品 chip;`dsh.client` manifest + `exports["./client"]` + 第二 patch 行,双行组合经 `--dump-config` 实证 |
| U3 | **生态对标与取长补短** | `ECOSYSTEM.md`:990+ 仓库实测,热门插件画像(程序员要"项目→漂亮输出"),确认写作/风格学习类零同类;对齐 archify(项目→产物)/dsh-annotation(选区)/deliverables(产出展示);新增与 **dsh-memory-evolve**("越用越懂你"热门项目)的互补关系分析——它记事实,我们学文风,可共存 |
| U4 | **README 程序员向定位** | 主 README「它能写什么」首条改为程序员场景(项目自动提炼),并强调"少硬编码、AI 主导、多面适配";插件 README 新增 synthesize 场景与 Web 增强说明 |
| U5 | **发布前功能验收** | `test/independence-check.mjs`:**MCP 层 7 个独立工具实测通过**(probe/style_status/synthesize/point_edit/clarify_step/audience/redteam)——从任意阶段开始、独立协作均可用;双风格区分实证(write-style/read-style 双档案 + 写作双注入);情绪反馈式风格吸收实证(`applyStyleDirection`) |
| U6 | **CLI 参数解析修复**(发布前把关发现) | 根因:parseArgs 把布尔 flag 后面的位置参数误当 flag 值吞掉(`style --signals /tmp/ws` 工作区丢失);另有 transform/history/rollback/recommend/academic 五个命令工作区位置参数未接。修复:取值 flag 白名单(默认不吞)+ 五命令 positional 修正 + point-edit/rewrite 任意目录自动建工作区;`agent/test/cli-args.test.mjs` 7 项回归 |
| U7 | **Web client 真实浏览器验收** | `test/browser-check.mjs`:headless Chrome + CDP **真实交互 8/8 通过**——bundle 注册、作品 chip 渲染(助手消息✓/用户消息不误判✓)、选区→「Stylotrace 改进」工具条→引用块插入输入框、无页面 JS 错误;client.js 同时完成健壮性强化(try/catch 隔离、MutationObserver 替换废弃 DOMNodeInserted、防抖) |
| U8 | **Web 注释系统 v2(0.1.2)** | client.js 升级为完整注释系统:① **批注**——选中文本→「💬 批注」→写入并 localStorage 持久化;② **查看**——右下角 💬 面板列出全部批注(原文+内容+时间),消息行「💬 N」角标,点击高亮定位原文;③ **编辑**——面板内联修改;④ **删除**——确认后删除;**文件打开**——作品 chip 增加「·打开」,经 `WorkspaceRuntime.openPath` 用系统默认应用打开 docx(md/html/pdf/srt),拿不到 host 服务自动降级复制路径;浏览器验收 **15/15**(批注全流程 + 持久化 + 降级路径);clipboard/openPath 全部 promise 加 catch 防 unhandled rejection |

### 🟢 观察项(建议,非阻断)

| # | 建议 |
|---|---|
| G1 | 发布后 3 个月收集真实反馈,优先做第三方盲评(论文 3.3 协议已就绪) |
| G2 | `toolCallTimeoutMs` 默认 5 分钟,长文写作可提示用户按需调大 |
| G3 | DSH 未来开放 curated 收录时,本包 skills/stylotrace 即完整 Agent 清单,可直接上架 |
| G4 | 建议给 GitHub 仓库打 `dsh-plugin` + `deepseek-harness-plugin` topic(发布后立即) |
| G5 | npm cache 权限问题(`~/.npm` 含 root 文件)需用户执行 `sudo chown -R 501:20 ~/.npm`(发布前置) |
| G6 | ~~client.js 未经验证~~ → **已升级**:client.js 经真实 headless Chrome 交互验收(U7,8/8)。剩余维护项:DSH 版本升级后重跑 `npm test`(browser-check 覆盖) |

---

## 三、运行时实证记录(每一条都真实跑过)

```
1. 层组合        dsh --profile stylotrace-test --dump-config
                 → 输出含 "# == dsh-plugin-stylotrace" + 两行(id: stylotrace / id: stylotrace-client)
2. 模块加载       headless 启动 → 插件模块成功 import(首次静态 import 失败已修复)
3. 引擎拉起       ps 实测:node .../dsh-plugin-stylotrace/skills/stylotrace/scripts/engine/bin/stylotrace.js mcp
4. 工具注册       node test/mcp-bridge.mjs → 40 个 mcp__stylotrace__* 注册进 ctx.tools(含 synthesize)
5. doctor 自检    stylotrace-plugin doctor → 握手 stylotrace v0.23.0,40 工具全清单
6. 凭据互操作     discoverCredentials 实测:codex-config:deepseek > dsh-credentials:DEEPSEEK_API_KEY(脱敏)
7. synthesize     CLI 确定性模式实测:项目素材收集→产物落盘 synthesized/*.md(单测 4/4)
8. 回归          agent 全量测试套件(30+ 文件)+ 插件 smoke + mcp-bridge 全绿
```

---

## 四、发布前检查清单(全部就绪)

- [x] 包名 `dsh-plugin-stylotrace` npm 未占用(404)
- [x] `dsh.bundle` manifest + `cordis.patch.yml` 正确
- [x] 测试全绿(插件 2 套 + 引擎 e2e + 新凭据单测)
- [x] 无密钥/无多余文件
- [x] 主 README + 插件 README 完整
- [x] 多终端安装 CLI(6 个宿主点)就绪
- [x] **PR 文案**(`PR-awesome.md`)与 **tarball**(`dsh-plugin-stylotrace-0.1.0.tgz`)已产出
- [ ] 用户:`sudo chown -R 501:20 ~/.npm`(npm cache 权限)
- [ ] 用户:`npm login` + `npm publish`
- [ ] 用户:GitHub 仓库打 `dsh-plugin` topic + 提 PR 到 awesome-dsh-plugin

---

*审核工具:read/glob/grep/实测运行 · 审核依据:DSH 官方 publish 文档、dsh-skill-filesystem 规范、dsh-mcp-client 源码、dsh-credentials-local 源码*
