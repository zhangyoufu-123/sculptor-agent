# Sculptor 公开 API（FastAPI + BYOK）

把 Sculptor 写作引擎包装成可自部署、可对外调用的 HTTP API。核心是 **BYOK（Bring Your Own Key）**：用户带自己的 LLM API Key 来调用，**服务端不存任何中心账号、不出任何 LLM 费用**；同一个 key 既是身份（用来区分会话），也是计费凭证（调用 LLM 时走这个 key）。

## 一键启动

本地需要 Node 18+ 与 Python 3.9+：

```bash
./run-api.sh                 # 自动装依赖并启动，默认 http://localhost:8000
SCULPTOR_MOCK_LLM=1 ./run-api.sh   # 离线冒烟（不调真实 LLM，用于验证部署）
```

或 Docker：

```bash
docker build -f api/Dockerfile -t sculptor-api .
docker run --rm -p 8000:8000 sculptor-api
```

## 调用

每个请求都要在 Header 里带用户自己的 LLM API Key（DeepSeek / 任何 OpenAI 兼容端点）：

```bash
curl -X POST http://localhost:8000/v1/chat \
  -H "Authorization: Bearer sk-你的LLM密钥" \
  -H "Content-Type: application/json" \
  -d '{"message":"我想写一篇关于故乡的散文，约一千字"}'
```

返回 `kind=ask` 时，把 `question` 答给用户，再用同一个 `session_id` 继续：

```bash
curl -X POST http://localhost:8000/v1/chat \
  -H "Authorization: Bearer sk-你的LLM密钥" \
  -H "Content-Type: application/json" \
  -d '{"message":"大约一千字，写北方的冬天","session_id":"上一步返回的 session_id"}'
```

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（返回 mode / 默认模型 / 是否开启访问门） |
| POST | `/v1/chat` | 主入口：`{message, session_id?, topic?, model?, base_url?}`，无 `session_id` 时新建会话 |
| GET | `/v1/sessions` | 列出当前 key 的所有会话 |
| GET | `/v1/sessions/{id}` | 读取会话状态 + 成稿 |
| DELETE | `/v1/sessions/{id}` | 删除会话 |
| GET | `/v1/sessions/{id}/export?format=md\|txt\|docx` | 导出成稿 |

## 账号模型（BYOK，无中心数据库）

- 用户身份 = `Authorization: Bearer <key>` 里的 key，对 key 做 `sha256` 取前 16 位作为会话命名空间。
- 每个 key 的数据互相隔离，存在 `api-data/users/<key 哈希>/<session_id>/`。
- 服务端不记录 key 明文、不做中心计费；LLM 费用全部由 key 持有者承担。
- 可选访问门：设置环境变量 `SCULPTOR_ACCESS_TOKEN` 后，只有 Bearer 等于该值的请求能进（把服务只开给特定人）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCULPTOR_DEFAULT_MODEL` | `deepseek-v4-flash` | 默认模型（请求体可覆盖） |
| `SCULPTOR_DEFAULT_BASE_URL` | `https://api.deepseek.com/v1` | 默认 OpenAI 兼容端点 |
| `SCULPTOR_ACCESS_TOKEN` | 空 | 设置后启用访问门 |
| `SCULPTOR_API_DATA` | `api-data` | 会话数据目录 |
| `SCULPTOR_MOCK_LLM` | 空 | 置 `1` 走内置 mock（离线冒烟） |

## 实现说明

- `api/main.py`：FastAPI 服务，负责鉴权、会话命名空间、导出，以及把每轮请求转交给无头引擎。
- `agent/bin/headless.mjs`：无头引擎桥，JSON 进 JSON 出，复用 `agent/src/director.js` 的完整导演状态机（澄清 → 大纲 → 写作 → 审计 → 交付），凭据经环境变量 `SCULPTOR_LLM_API_KEY / SCULPTOR_LLM_BASE_URL / SCULPTOR_LLM_MODEL` 注入。
- 这样 Python 层只管"门面 + BYOK + 会话"，风格建模、改迹调制、反 AI 审计等 61 个引擎模块原样复用，不重写、不降级。
