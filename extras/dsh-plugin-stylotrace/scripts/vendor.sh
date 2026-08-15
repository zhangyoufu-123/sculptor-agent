#!/usr/bin/env bash
# dsh-plugin-stylotrace — 从 stylotrace 仓库 vendor 技能包(含引擎)进本包。
# 保持「技能包 = 仓库 skills/stylotrace 的忠实快照」,引擎由技能包内嵌提供。
# 用法: bash scripts/vendor.sh   (在 extras/dsh-plugin-stylotrace/ 下执行)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$PKG_DIR/../.." && pwd)"
SRC_SKILL="$REPO_DIR/skills/stylotrace"
DEST_SKILL="$PKG_DIR/skills/stylotrace"

[ -d "$SRC_SKILL" ] || { echo "错误: 未找到 $SRC_SKILL" >&2; exit 1; }

rm -rf "$DEST_SKILL"
mkdir -p "$PKG_DIR/skills"
cp -R "$SRC_SKILL" "$DEST_SKILL"

# 忠实快照,但排除宿主安装器留下的多余安装点(避免包体积膨胀)
rm -rf "$DEST_SKILL"/.git

# 引擎入口可执行位
chmod +x "$DEST_SKILL/scripts/engine/bin/stylotrace.js" \
         "$DEST_SKILL/scripts/stylotrace.mjs" \
         "$DEST_SKILL/scripts/install.sh" \
         "$DEST_SKILL/hooks/stylotrace-hook.sh" 2>/dev/null || true

# 记录来源 commit,供发布时追溯
COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
{
  echo "# Vendored from stylotrace repo (extras/dsh-plugin-stylotrace)"
  echo "# source: github.com/zhangyoufu-123/stylotrace"
  echo "# commit: $COMMIT"
  echo "# 重新生成: bash scripts/vendor.sh"
} > "$PKG_DIR/VENDORED.md"

echo "已 vendor:"
echo "  $SRC_SKILL"
echo "  → $DEST_SKILL"
echo "  来源 commit: $COMMIT"
