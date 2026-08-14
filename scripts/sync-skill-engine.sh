#!/usr/bin/env bash
# 把 agent 引擎内嵌进 skill（skills/stylotrace/scripts/engine/），让 skill 脱离外部 CLI 独立运行。
# 单一事实源：agent/（src + bin + templates）；engine/ 只是其快照。
# 用法:
#   scripts/sync-skill-engine.sh           # 同步（agent → engine）
#   scripts/sync-skill-engine.sh --check   # 只校验是否漂移（CI 用，漂移即失败）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$ROOT/agent"
ENGINE="$ROOT/skills/stylotrace/scripts/engine"
MODE="${1:-sync}"

if [ "$MODE" = "--check" ]; then
  for d in bin src templates scripts/io; do
    if ! diff -rq "$AGENT/$d" "$ENGINE/$d" >/dev/null; then
      echo "DRIFT: agent/$d differs from skills/stylotrace/scripts/engine/$d"
      echo "Run: scripts/sync-skill-engine.sh"
      exit 1
    fi
  done
  if ! cmp -s "$AGENT/package.json" "$ENGINE/package.json"; then
    echo "DRIFT: agent/package.json differs from engine/package.json"
    exit 1
  fi
  echo "OK: embedded engine matches agent/"
  exit 0
fi

mkdir -p "$ENGINE"
for d in bin src templates scripts/io; do
  rsync -a --delete "$AGENT/$d/" "$ENGINE/$d/"
done
cp "$AGENT/package.json" "$ENGINE/package.json"
echo "OK: engine synced to $ENGINE (generated from agent/, do not edit by hand)"
