#!/usr/bin/env bash
# Stylotrace self-updater: refresh ALL three install points from GitHub in one command.
#
# Works from anywhere once the skill is installed (project-scoped or global):
#   bash ~/.codex/skills/sculptor/scripts/update.sh [项目目录]
#
# It ensures a local clone of the repo (clone once, then pull), then runs the
# official installer with --all --update:
#   [1/3] global skill   ~/.codex/skills/sculptor
#   [2/3] project skill  <项目目录>/.codex/skills/sculptor
#   [3/3] dev mirror     ~/sculptor  (SCULPTOR_MIRROR_DIR 可改；选择性同步，保留你的 .git/node_modules/.env)
#
# Env overrides:
#   SCULPTOR_REPO_URL      仓库地址（默认 zhangyoufu-123/stylotrace）
#   SCULPTOR_INSTALL_DIR   本地克隆目录（默认 ~/.local/share/sculptor-agent）
#   SCULPTOR_MIRROR_DIR    镜像目录（默认 ~/sculptor）
set -euo pipefail

PROJECT_DIR="${1:-${PWD}}"
MIRROR_DIR="${SCULPTOR_MIRROR_DIR:-${HOME}/sculptor}"
STORE_DIR="${SCULPTOR_INSTALL_DIR:-${HOME}/.local/share/sculptor-agent}"
REPO_URL="${SCULPTOR_REPO_URL:-https://github.com/zhangyoufu-123/stylotrace}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

echo "=== Stylotrace 更新：三处安装点一次刷新 ==="
echo "  当前 skill: $SKILL_DIR"
echo "  项目目录:   $PROJECT_DIR"
echo "  镜像目录:   $MIRROR_DIR"
echo ""

echo "--- 1/2 确保本地克隆最新 ---"
mkdir -p "$(dirname "$STORE_DIR")"
if [ -d "$STORE_DIR/.git" ]; then
  echo "  pull → $STORE_DIR"
  git -C "$STORE_DIR" pull --rebase
else
  echo "  clone → $STORE_DIR"
  git clone --depth 1 "$REPO_URL" "$STORE_DIR"
fi

echo ""
echo "--- 2/2 同步三处（全局 skill / 项目 skill / 开发镜像）---"
exec bash "$STORE_DIR/install.sh" --all --update --project "$PROJECT_DIR" --mirror "$MIRROR_DIR"
