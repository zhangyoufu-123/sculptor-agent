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
2. **高保真往返可选 Pandoc**：Pandoc 是 DOCX ↔ Markdown 往返的事实标准；`--reference-doc=<原文件>` 可复用 Word 模板样式。本机无 Pandoc 时自动回退到内置 python-docx 提取/导出（结构保留，样式级别有限）。
3. **LLM 优先、结构不变量**：翻译/重写提示词要求"保留全部 Markdown 结构（标题/列表/表格/引用），只改内容"；原意解读（翻译）与风格底稿（重写）作为前置上下文。
4. **对外接口 = MCP 工具**：与 docx-mcp、pandoc-mcp、doc-ops-mcp 等生态一致，把文档操作暴露为标准 MCP 工具，任何 MCP 客户端（Codex/Claude Desktop/Cursor）可直接调用。

## 已实现

### CLI

```bash
sculptor doc translate 论文.docx --lang en --out 论文.en
sculptor doc restyle  老文章.md --style "克制、短句、具体细节" --out 老文章.sculptor
sculptor doc restyle  老文章.md --style 我的旧稿.md --out 老文章.sculptor   # 风格来自旧稿文件
```

产物：`<out>.md` + `<out>.docx`（本机有 python-docx 时）+ `<out>.html`；翻译另附回译校验（保留/丢失/漂移）。

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
2. run 级格式保留：用 python-docx 把译文/重写稿逐段映射回原 docx（保留字体/缩进/表格样式），对接 llm-document-translator 模式；
3. 高保真解析升级：可选对接 MinerU / Docling（PDF/DOCX/PPTX/XLSX → LLM-ready Markdown）；
4. 模板填充：把澄清/大纲结果填入指定 Word 模板（pandoc `--reference-doc` 或 python-docx 模板引擎）。

## 复现与测试

```bash
cd agent && node test/doc-pipeline.test.mjs
```
