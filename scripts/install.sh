#!/usr/bin/env bash
# Sculptor Agent 安装器（顶层入口）— 委托给 skill 内部的完整安装器
set -euo pipefail
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$PKG_ROOT/skills/sculptor/scripts/install.sh" "$@"
