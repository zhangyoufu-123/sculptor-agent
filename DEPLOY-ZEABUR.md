# Sculptor Studio —— Zeabur 免费部署指南（无需银行卡）

> 若 Render 因"必须绑定支付方式"不可用，Zeabur 是免费替代：无需信用卡、可用 GitHub 账号登录、
> 支持从 GitHub 仓库自动构建 Docker 镜像，并提供持久化存储卷。免费档服务闲置时自动休眠，
> 下一次访问会有几秒冷启动，适合演示与个人使用。

## 一、准备

- 一个 GitHub 账号（已有：zhangyoufu-123），仓库 `sculptor-agent` 需已推送（main 分支）。
- 一个 LLM API Key（`SCULPTOR_LLM_API_KEY`），例如 DeepSeek 的 key。
- 仓库已内置 `Dockerfile`（node + python3 + python-docx）与 `.dockerignore`
  （排除 `.env*`、`web-data` 等敏感/运行数据，不被打进镜像）。

## 二、部署步骤（约 5 分钟）

1. 打开 https://zeabur.com ，点击 **Sign in**，选择 **GitHub** 登录（免费，无需银行卡）。
2. 登录后进入控制台，点击 **新建项目**，区域任选（建议选离你近的免费区域）。
3. 在项目内点击 **创建服务 → 从 GitHub 导入**，授权 Zeabur 访问 GitHub，
   选择仓库 `zhangyoufu-123/sculptor-agent`，分支 `main`。
4. 构建方式选择 **Dockerfile**（Zeabur 会自动识别仓库根目录的 `Dockerfile`）。
5. 在服务的 **Variables（环境变量）** 中添加：

   | 变量 | 值 | 说明 |
   | --- | --- | --- |
   | `SCULPTOR_LLM_API_KEY` | 你的 LLM Key | **必填**，写作/对话都用它 |
   | `SCULPTOR_WEB_PASSWORD` | 自定义密码 | 建议设置，防止公网被随意访问 |
   | `SCULPTOR_LLM_BASE_URL` | `https://api.deepseek.com/v1` | 可留空，默认即此值 |
   | `SCULPTOR_LLM_MODEL` | `deepseek-v4-flash` | 可留空，默认即此值 |

   > `PORT` 由 Zeabur 自动注入，服务端已读取 `process.env.PORT`，无需手动设置。
6. （推荐）为服务添加 **持久化存储卷**：挂载路径 `/var/data`，容量 1 GB。
   这样会话、作品库、风格肖像、知识库在休眠/重启后仍然保留。
   1GB 卷的费用在免费档额度内（约 $0.2/月级别）。不挂卷时，数据仅保存在实例内，
   重新部署会丢失。
7. 点击 **部署**，等待构建完成（首次构建约 2–5 分钟）。
8. 部署成功后，服务会获得公网地址 `https://<项目名>.zeabur.app`。

## 三、验证

- 打开首页，确认能正常加载。
- 访问 `/api/auth/status`：
  - 未设置密码：返回 `{"required":false,"ok":true}`；
  - 设置了 `SCULPTOR_WEB_PASSWORD`：未登录访问应返回 401，输入密码后进入。
- 新建一个会话，走一遍"澄清 → 大纲 → 写作 → 导出 docx"，确认 LLM 调用正常。

## 四、注意事项

- 免费档服务闲置一段时间后自动休眠，下次访问冷启动约几秒，属正常现象。
- 公网可访问，请务必设置 `SCULPTOR_WEB_PASSWORD`，避免他人消耗你的 LLM Key。
- 免费档无 SLA、日志保留 48 小时；正式商用建议升级 Dev/Pro 计划或换回带持久盘的付费档。
