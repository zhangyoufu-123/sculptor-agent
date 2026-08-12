# Sculptor 文档互通管线（Document Interop Pipeline）v0.56

## 目标

让 Sculptor 的每一个环节都支持"文件进、文件出"，并能与其他产品（Word/WPS、其他 Agent、MCP 客户端）衔接：

| 环节 | 文件进 | 文件出 |
| --- | --- | --- |
| 澄清/大纲 | 已有文档（docx/md/txt）→ 提取 | 确认清单、大纲（md/docx） |
| 写作/改写 | 成品文档 + 风格底稿 | 重写稿（md/docx/html） |
| 翻译 | docx/md/txt + 目标语言 | 译文（md/docx/html）+ 回译校验报告 |
| 审计 | 任意文档 | 规范/红队/回译报告（md） |
| 风格/知识 | 旧稿、书籍、语料 | 风格签名、知识库（JSON/md） |

## 设计原则（调研自行业最佳实践）

1. **Markdown 为规范中间表示（canonical IR）**：docx/xlsx/pdf/md/txt → 提取为 Markdown → 阶段处理 → 导出。结构与内容的分离让 LLM 只处理内容、不碰排版。成熟项目（Lazy_Docx、docx-template-translator-skill、llm-document-translator）均采用"XML/文本层降维为干净 Markdown → AI 处理 → 回写"的模式。
2. **run 级格式保留（已实现）**：`.docx` 输入走 `docx_blocks.py` 块级管线——按文档顺序提取段落与表格单元格（块 ID 如 `P0`、`T0_R0_C0_P0`），LLM 逐块翻译/重写（保持块数与 ID 一一对应，失败块单块重试、仍失败保留原文），再由 python-docx 把新文本写回**原段落首个 run**（保留字体/加粗等），删除其余 run，段落样式与表格结构原样不动。
3. **高保真往返可选 Pandoc**：Pandoc 是 DOCX ↔ Markdown 往返的事实标准；`--reference-doc=<原文件>` 可复用 Word 模板样式。本机无 Pandoc 时自动回退到内置 python-docx 提取/导出（结构保留）。
4. **LLM 优先、结构不变量**：翻译/重写提示词要求"保留全部 Markdown 结构（标题/列表/表格/引用），只改内容"；原意解读（翻译）与风格底稿（重写）作为前置上下文。
5. **对外接口 = MCP 工具**：与 docx-mcp、pandoc-mcp、doc-ops-mcp 等生态一致，把文档操作暴露为标准 MCP 工具，任何 MCP 客户端（Codex/Claude Desktop/Cursor）可直接调用。

## 已实现

### CLI

```bash
sculptor doc translate 论文.docx --lang en --out 论文.en
sculptor doc restyle  老文章.md --style "克制、短句、具体细节" --out 老文章.sculptor
sculptor doc restyle  老文章.md --style 我的旧稿.md --out 老文章.sculptor   # 风格来自旧稿文件
```

产物：`.docx` 输入 → `<out>.docx`（**原格式回填**，run 级保留）+ `<out>.md`；`md/txt` 输入 → `<out>.md` + `<out>.docx` + `<out>.html`；翻译另附回译校验（保留/丢失/漂移）。

### MCP 工具

- `doc_translate {file, lang, out?}`：文档翻译（原意解读 → 结构保留翻译 → 导出 → 回译校验）
- `doc_restyle {file, style?, out?}`：成品文档按作者风格重写（style 为旧稿路径或方向描述，缺省用工作区风格档案）

### 导出矩阵（每阶段）

| 阶段 | 默认产物 | 可选 |
| --- | --- | --- |
| 澄清 | 确认清单 md | docx |
| 大纲 | 大纲 md | docx |
| 写作 | draft.md | docx / html / pdf / latex / srt |
| 翻译 | 译文 md | docx / html + 回译报告 |
| 重写 | 重写稿 md | docx / html |
| 审计 | 报告 md | — |

## 与其他产品衔接

1. **Word/WPS**：直接打开导出的 `.docx`；需要完全复刻原版式时：
   ```bash
   pandoc input.docx -t markdown -o input.md        # 高保真提取
   sculptor doc translate input.md --lang en --out out
   pandoc out.md --reference-doc=input.docx -o out.docx   # 复用原样式
   ```
2. **其他 Agent（Codex/Claude Code/Cursor）**：通过 MCP 调用 `doc_translate` / `doc_restyle`，或在提示词里引用 `sculptor doc ...` 命令。
3. **批量目录**：
   ```bash
   for f in docs/*.docx; do sculptor doc translate "$f" --lang en --out "out/${f%.docx}"; done
   ```
4. **风格档案共享**：`sculptor profile export --to style.json` 把个人风格带走，`doc restyle --style style.json` 让其他环境复用同一风格（v0.56 支持旧稿/方向；档案文件路径接入后续版本）。

## 后续（按价值排序）

1. `--style <风格档案.json>`：直接读取导出的全局风格档案作为重写底稿；
2. 嵌套表格与页眉页脚参与块替换（当前嵌套表按单元格段落平铺）；
3. 高保真解析升级：可选对接 MinerU / Docling（PDF/DOCX/PPTX/XLSX → LLM-ready Markdown）；
4. 模板填充：把澄清/大纲结果填入指定 Word 模板（pandoc `--reference-doc` 或 python-docx 模板引擎）。

## 复现与测试

```bash
cd agent && node test/doc-pipeline.test.mjs
```

## Web 端部署（v0.56+，含鉴权）

零依赖 Node 服务 + 纯静态前端，任何 Node 主机可直接运行（无构建步骤）：

```bash
cd sculptor-agent/web
SCULPTOR_LLM_API_KEY=sk-xxx \
SCULPTOR_WEB_PASSWORD=your-password \   # 设置后启用登录保护（未设置则单机免登录）
SCULPTOR_WEB_DATA=/path/to/web-data \   # 会话/作品库数据目录（建议挂持久盘）
PORT=8080 node server.mjs
```

验证（web 8 套 QA 共 303 项断言）：

```bash
cd sculptor-agent/web && npm test
```

生产注意：
- **HTTPS**：由部署平台提供（Render/Vercel/反向代理终止 TLS）；自建服务器用 caddy/nginx 反代；
- **数据备份**：`SCULPTOR_WEB_DATA` 目录即全部数据（会话/作品库/风格档案/知识库），定期打包即可；
- **密钥安全**：`SCULPTOR_LLM_API_KEY` 仅存服务端环境变量，前端不接触；`SCULPTOR_WEB_PASSWORD` 用于访问保护；
- **公开对外**：务必设置 `SCULPTOR_WEB_PASSWORD`；如需多用户隔离，当前版本为单用户设计，需再接入账号体系。
