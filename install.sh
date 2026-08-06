#!/usr/bin/env bash
# Sculptor Agent 一键安装（开源分发入口）
#
# 用法（任一）:
#   curl -fsSL https://raw.githubusercontent.com/sculptor-agent/sculptor-agent/main/install.sh | bash
#   git clone https://github.com/sculptor-agent/sculptor-agent && cd sculptor-agent && ./install.sh
#
# 可选参数:
#   --prefix <目录>     CLI 安装目录（默认 ~/.local/bin）
#   --setup-dir <目录>  安装后自动 setup 到指定项目（目录级接入）
#   --repo <URL>        curl 安装时使用的仓库地址（默认 github.com/sculptor-agent/sculptor-agent）
#   --dry-run           只显示将做什么
set -euo pipefail

DRY_RUN=0
PREFIX="${HOME}/.local/bin"
SETUP_DIR=""
REPO_URL="${SCULPTOR_REPO_URL:-https://github.com/sculptor-agent/sculptor-agent}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --setup-dir) SETUP_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }

if [ -f "$PWD/agent/package.json" ]; then
  REPO_DIR="$PWD"
  step "1/3 使用本地仓库"
else
  REPO_DIR="${SCULPTOR_INSTALL_DIR:-${HOME}/.local/share/sculptor-agent}"
  step "1/3 克隆仓库到 $REPO_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] git clone --depth 1 $REPO_URL $REPO_DIR"
  else
    mkdir -p "$(dirname "$REPO_DIR")"
    [ -d "$REPO_DIR/.git" ] || git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  fi
fi

step "2/3 安装 CLI 到 $PREFIX/sculptor"
if [ "$DRY_RUN" -eq 1 ]; then
  bash "$REPO_DIR/scripts/install-agent.sh" --prefix "$PREFIX" --dry-run
else
  bash "$REPO_DIR/scripts/install-agent.sh" --prefix "$PREFIX"
fi

step "3/3 验证"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 跳过验证"
else
  "$PREFIX/sculptor" doctor || true
fi

if [ -n "$SETUP_DIR" ]; then
  step "安装后自动接入到项目: $SETUP_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    "$PREFIX/sculptor" setup --dir "$SETUP_DIR" --dry-run
  else
    "$PREFIX/sculptor" setup --dir "$SETUP_DIR"
  fi
fi

cat <<EOF

✅ 完成。
- CLI: ${PREFIX}/sculptor（如 PATH 不含 ${PREFIX}，请加入）
- 下一步: 在你的写作项目里运行: sculptor setup
- 配置 LLM: export SCULPTOR_LLM_API_KEY=sk-xxx  （或 setup 自动复用本机已有凭据）
- 文档: https://github.com/sculptor-agent/sculptor-agent
EOF
