# Stylotrace Web 演示版部署指南

把 "Codex + Stylotrace 组合"的写作流程搬进浏览器：`web/` 是一个零依赖 Node 服务 +
聊天式前端，评委打开网址就能体验 澄清 → 大纲 → 逐节写作 → 反 AI 审计 → 交付。

## 先本地跑起来（30 秒）

```bash
cd web
npm run mock    # 离线 mock 模式：不需要 API 密钥，流程全通，适合先看效果
# 或
STYLOTRACE_LLM_API_KEY=sk-xxx npm start   # 真实模式：用你自己的 DeepSeek/OpenAI 密钥
```

浏览器打开 http://localhost:5177 ，输入一个写作念头即可。

## 部署方案对比（免费，不用买服务器）

| 平台 | 免费额度 | 适不适合本服务 | 说明 |
| --- | --- | --- | --- |
| **Railway** | 一次性试用额度（$5，约够演示几个月） | ✅ 最合适 | 完整 Node 进程 + 持久磁盘，Stylotrace 的工作区文件系统照常工作；自带域名 `*.up.railway.app` |
| **Render** | 免费 Web Service（冷启动较慢） | ✅ 合适 | 完整 Node 进程 + 磁盘，免费实例空闲会休眠、被访问时唤醒 |
| **Fly.io** | 免费额度有限 | ✅ 合适 | 完整 Node + 卷，稍复杂 |
| **Vercel** | 免费 | ⚠ 不推荐 | Serverless 无持久文件系统，Stylotrace 依赖 `.stylotrace/` 状态文件，需要大改 |
| **本地 + Cloudflare Tunnel** | 免费 | ✅ 应急 | 电脑开着即可公网访问，演示前临时用 |

## 推荐：Railway 一键部署

1. 打开 https://railway.app → 用 GitHub 登录；
2. New Project → **Deploy from GitHub repo** → 选 `zhangyoufu-123/stylotrace`；
3. 部署设置里：**Root Directory** 填 `web`；**Start Command** 填 `npm start`；
4. 添加环境变量：`STYLOTRACE_LLM_API_KEY=sk-xxx`（必填，真实模式）；
5. 部署完成后，Railway 会给你一个 `https://<项目名>.up.railway.app` 域名，直接可访问；
6. 可选：Settings → Networking → 绑定自定义域名。

> 提示：演示前建议在 Railway 控制台把实例限制为 1 个、关闭自动扩容，避免免费额度被烧光。

## 备选：Render

1. https://render.com → New → **Web Service** → 连接 GitHub 仓库；
2. Root Directory `web`，Build Command 留空，Start Command `npm start`；
3. 环境变量加 `STYLOTRACE_LLM_API_KEY`；
4. 免费实例域名 `<名称>.onrender.com`。首次访问有 30–60 秒冷启动，属正常。

## 安全与限制

- 当前是**单会话演示版**：会话存在服务器内存/临时目录，刷新或过期即清空；适合比赛展示，
  不适合正式多用户产品（下一版可接数据库与鉴权）。
- API 密钥只存在服务器环境变量里，前端不接触密钥。
- 请给演示账号/页面加一个简单的访问保护（如 Railway 的域名公开但限流，或加 Basic Auth），
  防止被刷爆 API 额度。

## 架构一句话

浏览器 → `web/server.mjs`（Node HTTP）→ Stylotrace 导演状态机（`agent/src/director.js`）→ LLM API。
前端负责美，后端负责流程，Stylotrace 负责写作。
