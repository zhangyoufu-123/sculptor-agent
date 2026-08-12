# Render 部署指南（Sculptor Studio）

仓库已包含 `render.yaml`（Blueprint）与 `Dockerfile`，按 Render 官方 Codex 插件
（render-blueprints / render-docker / render-deploy 技能）的规范编写。

## 0. 前置：把仓库推到 GitHub

```bash
cd /Users/wallace/Documents/Codex/2026-08-04/bang/sculptor-agent && git push
```

## 1. 安装并登录 Render CLI（推荐，Blueprint 校验/启动）

```bash
brew install render
render login        # 浏览器 OAuth 登录
render whoami -o json   # 验证
```

校验 Blueprint：

```bash
render blueprints validate --file render.yaml
```

启动（会给出 Dashboard 链接）：

```bash
render blueprint launch --file render.yaml --name sculptor-studio
```

## 2. 或使用 Render MCP / API（需要 API Key）

API Key 页面：`https://dashboard.render.com/u/*/settings#api-keys`

- Render MCP：`https://mcp.render.com/mcp`，Bearer token = API Key
  （在 Codex 的 config.toml 配置 `[mcp_servers.render]` 后重启 Codex 生效）
- 或直接用 REST：`curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services`

## 3. 创建后必须配置的环境变量（Dashboard → 服务 → Environment）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SCULPTOR_LLM_API_KEY` | 是 | LLM 密钥（服务端，不出现在前端） |
| `SCULPTOR_WEB_PASSWORD` | 建议 | 访问密码（设置后启用登录保护） |
| `SCULPTOR_LLM_BASE_URL` | 否 | 自定义 OpenAI 兼容端点 |
| `SCULPTOR_LLM_MODEL` | 否 | 默认模型名 |

数据目录 `SCULPTOR_WEB_DATA=/var/data` 已挂 1GB 持久盘（会话/作品库/风格档案/知识库都在里面，
重启不丢，可随时打包备份）。

## 4. 验证

- 打开服务 URL：登录页 → 密码 → 工作台；
- 跑一次完整写作（澄清 → 大纲 → 写作 → 审计）；
- 工具面板试一次文档翻译（docx 上传 → 下载，验证 python-docx 生效）。

## 已知注意

- Free 计划休眠后首次请求会慢（Render 冷启动），属正常；
- `SCULPTOR_LLM_API_KEY` 为服务端共享密钥：适合自用/小团队/演示；公开大流量需接账号体系；
- 镜像内置 python3-docx（Debian 官方包），docx 读取/导出/块级回填开箱可用。
