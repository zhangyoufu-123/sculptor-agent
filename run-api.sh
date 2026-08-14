#!/usr/bin/env bash
# Stylotrace 公开 API 一键启动（BYOK）：本地需要 Node 18+ 与 Python 3.9+。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
MOCK="${STYLOTRACE_MOCK_LLM:-0}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 python3（>=3.9）" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "缺少 node（>=18）" >&2
  exit 1
fi

if ! python3 -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  echo "正在安装 FastAPI 依赖…"
  python3 -m pip install -r api/requirements.txt
fi

echo "Stylotrace API 启动：http://localhost:${PORT}"
echo "模式：$([ "$MOCK" = "1" ] && echo mock 离线冒烟 || echo live，BYOK)"
echo '调用示例：'
echo '  curl -X POST http://localhost:'"$PORT"'/v1/chat \'
echo '       -H "Authorization: Bearer <你的 LLM API Key>" \'
echo '       -H "Content-Type: application/json" \'
echo '       -d '\''{"message":"我想写一篇关于故乡的散文"}'\'''

if [ "$MOCK" = "1" ]; then
  STYLOTRACE_MOCK_LLM=1 python3 -m uvicorn api.main:app --host 0.0.0.0 --port "$PORT"
else
  python3 -m uvicorn api.main:app --host 0.0.0.0 --port "$PORT"
fi
