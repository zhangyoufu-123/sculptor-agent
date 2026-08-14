#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stylotrace 公开 API（FastAPI + BYOK）。

核心设计：Bring Your Own Key。每个请求用 `Authorization: Bearer <你自己的 LLM API Key>`
携带用户自己的密钥——服务端不存任何中心账号、不出任何 LLM 费用；密钥同时用于：
  1) 调用 LLM（用户自己付费）；
  2) 区分账号（对 key 做 sha256，前 16 位作为会话命名空间）。

可选访问门：设置环境变量 STYLOTRACE_ACCESS_TOKEN 后，只有 Bearer 等于该值的请求能进
（用于只把服务开给特定人）；不设置则任何自带 key 的人都能用（BYOK 语义下天然安全）。

会话数据落盘在 api-data/users/<key 哈希>/<session_id>/（复用 Stylotrace 工作区协议）。
引擎为 Node 子进程（agent/bin/headless.mjs），每轮一次调用，JSON 进 JSON 出。

启动：
  pip install -r requirements.txt
  uvicorn api.main:app --host 0.0.0.0 --port 8000
离线冒烟：
  STYLOTRACE_MOCK_LLM=1 uvicorn api.main:app --port 8000
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
NODE = ROOT / "agent" / "bin" / "headless.mjs"
DATA_ROOT = Path(os.environ.get("STYLOTRACE_API_DATA", ROOT / "api-data"))
IO_SCRIPTS = ROOT / "agent" / "scripts" / "io"
STATIC = Path(__file__).parent / "static"

ACCESS_TOKEN = os.environ.get("STYLOTRACE_ACCESS_TOKEN", "").strip()
DEFAULT_MODEL = os.environ.get("STYLOTRACE_DEFAULT_MODEL", "deepseek-v4-flash").strip()
DEFAULT_BASE_URL = os.environ.get("STYLOTRACE_DEFAULT_BASE_URL", "https://api.deepseek.com/v1").strip().rstrip("/")
MOCK = os.environ.get("STYLOTRACE_MOCK_LLM", "") == "1"

app = FastAPI(title="Stylotrace API", version="1.0.0", description="从修改中学习个人文风的写作系统（BYOK）")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def user_namespace(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def extract_key(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="缺少 Authorization: Bearer <your-llm-api-key>")
    parts = authorization.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise HTTPException(status_code=401, detail="Authorization 需为 'Bearer <key>' 格式")
    return parts[1].strip()


def authorize(authorization: Optional[str]) -> str:
    key = extract_key(authorization)
    if ACCESS_TOKEN and key != ACCESS_TOKEN:
        raise HTTPException(status_code=403, detail="访问被拒（服务端已设置访问门）")
    return key


def session_dir(ns: str, session_id: str) -> Path:
    safe = "".join(c for c in session_id if c.isalnum() or c == "-")
    if not safe:
        raise HTTPException(status_code=400, detail="非法 session_id")
    d = (DATA_ROOT / "users" / ns / safe).resolve()
    root = (DATA_ROOT / "users" / ns).resolve()
    if not str(d).startswith(str(root)):
        raise HTTPException(status_code=400, detail="非法 session_id")
    return d


def run_engine(api_key: str, model: str, base_url: str, workspace: Path, message: str) -> dict:
    env = os.environ.copy()
    env["STYLOTRACE_LLM_API_KEY"] = api_key
    env["STYLOTRACE_LLM_MODEL"] = model
    env["STYLOTRACE_LLM_BASE_URL"] = base_url
    if MOCK:
        env["STYLOTRACE_MOCK_LLM"] = "1"
    req = json.dumps({"message": message, "workspace": str(workspace)}, ensure_ascii=False)
    try:
        proc = subprocess.run(
            ["node", str(NODE)],
            input=req,
            capture_output=True,
            text=True,
            env=env,
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="引擎执行超时")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="未找到 Node 运行时")
    if proc.returncode != 0 and not proc.stdout.strip():
        raise HTTPException(status_code=500, detail=proc.stderr.strip()[:400])
    try:
        return json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="引擎返回非 JSON：" + proc.stdout[:200])


def read_state(d: Path) -> dict:
    p = d / "protocol" / "state.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


class ChatIn(BaseModel):
    message: str
    session_id: Optional[str] = None
    topic: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "mode": "mock" if MOCK else "live",
        "default_model": DEFAULT_MODEL,
        "byok": True,
        "access_gated": bool(ACCESS_TOKEN),
    }


@app.post("/v1/chat")
def chat(body: ChatIn, authorization: Optional[str] = Header(default=None)):
    key = authorize(authorization)
    ns = user_namespace(key)
    model = (body.model or DEFAULT_MODEL).strip()
    base_url = (body.base_url or DEFAULT_BASE_URL).strip().rstrip("/")

    sid = body.session_id
    if not sid:
        sid = hashlib.sha256(os.urandom(16)).hexdigest()[:16]
        d = session_dir(ns, sid)
        d.mkdir(parents=True, exist_ok=True)
        # 首个 message 兼作主题，写入转录（复用 Stylotrace 工作区由 agentStep 建 state）
        if body.topic:
            (d / "transcript.jsonl").write_text(
                json.dumps({"role": "user", "text": body.topic}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
    else:
        d = session_dir(ns, sid)
        if not d.exists():
            raise HTTPException(status_code=404, detail="会话不存在")

    if body.message:
        with (d / "transcript.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "text": body.message}, ensure_ascii=False) + "\n")

    result = run_engine(key, model, base_url, d, body.message)
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["error"])
    result["session_id"] = sid
    result["model"] = model
    result["base_url"] = base_url
    return result


@app.get("/v1/sessions")
def list_sessions(authorization: Optional[str] = Header(default=None)):
    key = authorize(authorization)
    ns = user_namespace(key)
    root = DATA_ROOT / "users" / ns
    out = []
    if root.exists():
        for sid in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if sid.is_dir():
                st = read_state(sid)
                out.append(
                    {
                        "session_id": sid.name,
                        "title": (st.get("outline") or {}).get("title") or "新写作",
                        "phase": st.get("phase", "clarify"),
                        "stage": (st.get("director") or {}).get("stage", ""),
                        "updated_at": sid.stat().st_mtime,
                    }
                )
    return {"sessions": out}


@app.get("/v1/sessions/{session_id}")
def get_session(session_id: str, authorization: Optional[str] = Header(default=None)):
    key = authorize(authorization)
    ns = user_namespace(key)
    d = session_dir(ns, session_id)
    if not d.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    draft = (d / "draft.md").read_text(encoding="utf-8") if (d / "draft.md").exists() else ""
    return {"session_id": session_id, "state": read_state(d), "draft": draft}


@app.delete("/v1/sessions/{session_id}")
def delete_session(session_id: str, authorization: Optional[str] = Header(default=None)):
    key = authorize(authorization)
    ns = user_namespace(key)
    d = session_dir(ns, session_id)
    if not d.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    import shutil

    shutil.rmtree(d)
    return {"ok": True, "deleted": session_id}


@app.get("/v1/sessions/{session_id}/export")
def export_session(session_id: str, fmt: str = "md", authorization: Optional[str] = Header(default=None)):
    key = authorize(authorization)
    ns = user_namespace(key)
    d = session_dir(ns, session_id)
    draft_file = d / "draft.md"
    if not draft_file.exists():
        raise HTTPException(status_code=404, detail="尚无成稿")
    text = draft_file.read_text(encoding="utf-8")
    if fmt in ("md", "txt"):
        from fastapi.responses import PlainTextResponse

        return PlainTextResponse(text, media_type="text/markdown" if fmt == "md" else "text/plain")
    if fmt == "docx":
        from fastapi.responses import FileResponse

        out = d / "draft.docx"
        script = IO_SCRIPTS / "write_docx.py"
        if script.exists():
            tmp_md = d / ".export.md"
            tmp_md.write_text(text, encoding="utf-8")
            subprocess.run(
                [sys.executable, str(script), str(tmp_md), str(out)],
                capture_output=True,
                timeout=120,
            )
            tmp_md.unlink(missing_ok=True)
        if out.exists():
            return FileResponse(out, filename=f"{session_id}.docx")
    raise HTTPException(status_code=400, detail="format 仅支持 md / txt / docx")


# 静态前端（/）放在所有 API 路由之后挂载，避免吞掉 /health 与 /v1/*。
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
