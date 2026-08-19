#!/usr/bin/env bash
# Stylotrace 密钥泄露守卫：提交前 / CI 扫描"会被提交的内容"（已跟踪文件 + 未跟踪但未被忽略的文件），
# 也支持 --all-refs 扫描全部 git 历史。命中即失败退出（exit 1）。
# 注意：统一用 grep -E（POSIX ERE），不要用 rg——某些环境（如 ChatGPT 内置 rg）会把 -E 当成
# "编码"参数导致静默失败。
#
# 用法:
#   bash scripts/scan-secrets.sh              # 扫描将提交的内容
#   bash scripts/scan-secrets.sh --all-refs   # 额外扫描全部 git 历史
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERNS=(
  'sk-[A-Za-z0-9]{16,}'
  'ghp_[A-Za-z0-9]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  '-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----'
  'ce4954fb1fb94cecb9c45d5180a1ccf8'
)
JOINED="$(IFS='|'; echo "${PATTERNS[*]}")"
SELF="scripts/scan-secrets.sh" # 守卫自身的模式清单含已知 key 串，必须排除自己

fail=0

echo "== 扫描将提交的内容（已跟踪 + 未忽略的未跟踪文件）=="
tracked="$(git grep -I -n -i -E "$JOINED" -- . ":(exclude)$SELF" 2>/dev/null)"
if [ -n "$tracked" ]; then
  echo "$tracked"
  fail=1
fi
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = "$SELF" ] && continue
  hits="$(grep -n -I -i -E "$JOINED" "$f" 2>/dev/null)"
  if [ -n "$hits" ]; then
    echo "$hits"
    fail=1
  fi
done < <(git ls-files --others --exclude-standard)

if [ "${1:-}" = "--all-refs" ]; then
  echo "== 扫描全部 git 历史 =="
  revs="$(git rev-list --all 2>/dev/null)"
  if [ -n "$revs" ]; then
    # 排除守卫自身(scripts/scan-secrets.sh)——其模式清单含已知 key 串，否则全历史扫描误报自己
    git grep -I -n -i -E "$JOINED" $revs -- . ":(exclude)$SELF" 2>/dev/null && fail=1
  else
    echo "（无提交，跳过）"
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "OK: 未发现疑似密钥"
  exit 0
fi
echo "!! 发现疑似密钥，请先删除/轮换再提交" >&2
exit 1
