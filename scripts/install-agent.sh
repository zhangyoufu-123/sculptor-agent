#!/usr/bin/env bash
# Sculptor Agent 安装器：安装独立 CLI + 可选的宿主 MCP 注册（默认只打印配置，绝不擅自改宿主文件）
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$PKG_ROOT/agent"
BIN_SRC="$AGENT_DIR/bin/sculptor.js"
PREFIX="${HOME}/.local/bin"
DRY_RUN=0
WRITE_CODEX=0

usage() {
  cat <<'EOF'
Sculptor Agent 安装器

用法:
  ./scripts/install-agent.sh [--prefix <dir>] [--dry-run] [--mcp-codex [--write-codex]]

示例:
  ./scripts/install-agent.sh                            # 装到 ~/.local/bin/sculptor
  ./scripts/install-agent.sh --prefix ~/bin --dry-run   # 预览
  ./scripts/install-agent.sh --mcp-codex                # 打印 Codex 的 MCP 配置片段
  ./scripts/install-agent.sh --mcp-codex --write-codex  # 写入 ~/.codex/config.toml（先备份）

设计原则：默认不写任何宿主配置；MCP 注册需要显式 --write-codex 才会改文件，且总是先备份。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --mcp-codex) shift ;;
    --write-codex) WRITE_CODEX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

echo "=== 1. 安装 CLI 到 $PREFIX/sculptor ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 将创建符号链接: $PREFIX/sculptor -> $BIN_SRC"
else
  mkdir -p "$PREFIX"
  chmod +x "$BIN_SRC"
  ln -sf "$BIN_SRC" "$PREFIX/sculptor"
  echo "已安装 → $PREFIX/sculptor"
  echo "（若 PATH 不含 ${PREFIX}，请把它加入 PATH）"
fi

echo ""
echo "=== 2. 验证 ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 跳过验证"
else
  "$PREFIX/sculptor" --help | head -3
  echo "✓ CLI 可用"
fi

echo ""
echo "=== 3. 宿主 MCP 注册（默认只打印，不写文件） ==="
CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
printf '%s\n' "Codex 配置片段（追加到 ${CODEX_CFG}）："
printf '%s\n' "[mcp_servers.sculptor]"
printf '%s\n' "command = \"$PREFIX/sculptor\""
printf '%s\n' 'args = ["mcp"]'
if [ "$WRITE_CODEX" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  if grep -q '\[mcp_servers\.sculptor\]' "$CODEX_CFG" 2>/dev/null; then
    echo "提示: $CODEX_CFG 已存在 sculptor MCP 配置，跳过写入。"
  else
    cp "$CODEX_CFG" "${CODEX_CFG}.bak.$(date +%s)"
    printf '\n[mcp_servers.sculptor]\ncommand = "%s"\nargs = ["mcp"]\n' "$PREFIX/sculptor" >> "$CODEX_CFG"
    echo "已写入 $CODEX_CFG（原配置已备份）。"
  fi
else
  echo "（未写文件。确认无误后运行: ./scripts/install-agent.sh --mcp-codex --write-codex）"
fi

echo ""
printf '%s\n' "Claude Code 配置（项目根目录 .mcp.json）："
printf '%s\n' '{'
printf '%s\n' '  "mcpServers": {'
printf '%s\n' '    "sculptor": { "command": "'"$PREFIX"'/sculptor", "args": ["mcp"] }'
printf '%s\n' '  }'
printf '%s\n' '}'

echo ""
echo "=== 4. 自检 ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 结束"
else
  "$PREFIX/sculptor" doctor || true
  echo "完成。使用前配置环境变量：SCULPTOR_LLM_API_KEY（以及可选的 SCULPTOR_LLM_BASE_URL / SCULPTOR_LLM_MODEL）。"
fi
