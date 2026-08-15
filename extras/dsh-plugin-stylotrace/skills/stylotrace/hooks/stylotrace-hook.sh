#!/usr/bin/env bash
# Stylotrace observer hook — 宿主（Codex / Claude Code / OpenCode）生命周期事件 → 观察日志 + 压缩守卫
#
# 容错设计：工作区不存在、CLI 缺失、事件不认识，都安全退出 0，绝不干扰宿主。
# 事件载荷从 stdin 读取（JSON），透传给 stylotrace.mjs hook。
set -uo pipefail

WORKSPACE="${STYLOTRACE_WORKSPACE:-${PWD}/.stylotrace}"
[ -d "$WORKSPACE" ] || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HOOK_DIR/../scripts/stylotrace.mjs"
[ -f "$CLI" ] || exit 0

node "$CLI" hook "$WORKSPACE"
exit 0
