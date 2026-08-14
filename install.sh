#!/usr/bin/env bash
# Stylotrace one-click installer & updater (open-source distribution entry).
# The skill ships the complete agent engine inside it - no separate CLI needed.
#
# Fresh install (either):
#   curl -fsSL https://raw.githubusercontent.com/zhangyoufu-123/stylotrace/main/install.sh | bash -s -- --all
#   git clone https://github.com/zhangyoufu-123/stylotrace && cd stylotrace && ./install.sh --all
#
# Options:
#   --project <dir>   project-scoped install into <dir>/.codex/skills/stylotrace (default: current dir)
#   --global          install/update into ~/.codex/skills/stylotrace (all Codex sessions)
#   --mirror [dir]    also mirror the dev workspace into <dir> (default ~/stylotrace; selective sync, preserves your files)
#   --all             shorthand for --global --mirror (project stays the default target)
#   --update          pull latest from GitHub (when the repo is a clone), then refresh all chosen points
#   --cli             also symlink the standalone CLI to ~/.local/bin/stylotrace (optional)
#   --mcp-codex       print Codex MCP config snippet (never modifies host config on its own)
#   --no-setup        skip auto-register after install (default: auto-register project Codex)
#   --setup-all       also register Claude Code / OpenCode after install (auto-detected)
#   --dry-run         only show what would be done
set -euo pipefail

DRY_RUN=0
PROJECT_DIR=""
GLOBAL=0
MIRROR=0
MIRROR_DIR=""
UPDATE=0
WITH_CLI=0
MCP_CODEX=0
AUTO_SETUP=1
SETUP_ALL=0
REPO_URL="${STYLOTRACE_REPO_URL:-https://github.com/zhangyoufu-123/stylotrace}"
STORE_DIR="${STYLOTRACE_INSTALL_DIR:-${HOME}/.local/share/stylotrace}"

usage() {
  sed -n '1,20p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --global) GLOBAL=1; shift ;;
    --mirror)
      MIRROR=1
      if [ $# -gt 1 ] && [ "$2" != "--" ] && ! printf '%s' "$2" | grep -q '^--'; then
        MIRROR_DIR="$2"; shift
      fi
      shift ;;
    --all) GLOBAL=1; MIRROR=1; shift ;;
    --update) UPDATE=1; shift ;;
    --cli) WITH_CLI=1; shift ;;
    --mcp-codex) MCP_CODEX=1; shift ;;
    --no-setup) AUTO_SETUP=0; shift ;;
    --setup-all) SETUP_ALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }
say() { [ "$DRY_RUN" -eq 1 ] && printf '[dry-run] %s\n' "$*" || printf '%s\n' "$*"; }

# 1/5 locate the repository (local checkout, or clone/pull into the store)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/agent/package.json" ] && [ -d "$SCRIPT_DIR/skills/stylotrace" ]; then
  REPO_DIR="$SCRIPT_DIR"
  REPO_IS_CLONE=0
  step "1/5 use local repo: $REPO_DIR"
else
  REPO_DIR="$STORE_DIR"
  REPO_IS_CLONE=1
  step "1/5 repo store: $REPO_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -d "$REPO_DIR/.git" ]; then
      echo "[dry-run] git -C $REPO_DIR pull --rebase"
    else
      echo "[dry-run] git clone --depth 1 $REPO_URL $REPO_DIR"
    fi
  else
    mkdir -p "$(dirname "$REPO_DIR")"
    if [ -d "$REPO_DIR/.git" ]; then
      git -C "$REPO_DIR" pull --rebase
    else
      git clone --depth 1 "$REPO_URL" "$REPO_DIR"
    fi
  fi
fi

# --update: pull latest before syncing (only when the repo is our clone store)
if [ "$UPDATE" -eq 1 ] && [ "$REPO_IS_CLONE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  step "update: pull latest into $REPO_DIR"
  git -C "$REPO_DIR" pull --rebase
fi

SRC_SKILL="$REPO_DIR/skills/stylotrace"
SRC_TRANSLATOR="$REPO_DIR/skills/translator"

# 2/5 targets
declare -a TARGETS=()
if [ "$GLOBAL" -eq 1 ]; then
  TARGETS+=("${HOME}/.codex/skills/stylotrace:global")
fi
if [ -n "$PROJECT_DIR" ] || [ "$GLOBAL" -eq 0 ]; then
  PROJECT_DIR="${PROJECT_DIR:-$PWD}"
  TARGETS+=("$PROJECT_DIR/.codex/skills/stylotrace:project")
fi
if [ "$MIRROR" -eq 1 ]; then
  MIRROR_DIR="${MIRROR_DIR:-${HOME}/stylotrace}"
fi

step "2/5 install/update points"
for t in "${TARGETS[@]}"; do
  dest="${t%%:*}"
  label="${t##*:}"
  say "  [$label] $dest"
done
if [ "$MIRROR" -eq 1 ]; then say "  [mirror] $MIRROR_DIR (selective sync, keeps your .git/node_modules/.env)"; fi

backup_dir() { # dest label
  local dest="$1" label="$2"
  local bk="${dest}.bak.$(date +%s)"
  say "backing up existing $label install -> $bk (recoverable)"
  if [ "$DRY_RUN" -eq 0 ]; then
    cp -R "$dest" "$bk"
    # 保留最近 2 份备份，防止无限堆积
    ls -1dt "${dest}.bak."* 2>/dev/null | tail -n +3 | xargs rm -rf 2>/dev/null || true
  fi
}

sync_skill() { # dest label
  local dest="$1" label="$2"
  step "3/5 sync skill -> $dest ($label)"
  if [ -e "$dest" ]; then backup_dir "$dest" "$label"; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] rsync -a --delete ${SRC_SKILL}/ $dest/"
  else
    mkdir -p "$(dirname "$dest")"
    rsync -a --delete "${SRC_SKILL}/" "$dest/"
    chmod +x "$dest/scripts/stylotrace.mjs" "$dest/scripts/install.sh" "$dest/scripts/update.sh" "$dest/hooks/stylotrace-hook.sh" 2>/dev/null || true
  fi
}

sync_translator() { # dest label
  local dest="$1" label="$2"
  [ -d "$SRC_TRANSLATOR" ] || return 0
  step "3/5 sync translator skill -> $dest ($label)"
  if [ -e "$dest" ]; then backup_dir "$dest" "$label"; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] rsync -a --delete ${SRC_TRANSLATOR}/ $dest/"
  else
    mkdir -p "$(dirname "$dest")"
    rsync -a --delete "${SRC_TRANSLATOR}/" "$dest/"
    chmod +x "$dest/scripts/roundtrip.mjs" 2>/dev/null || true
  fi
}

sync_mirror() { # dest
  local dest="$1"
  step "3/5 sync mirror -> $dest (selective, preserves .git/node_modules/.env.local/…)"
  for d in agent skills scripts examples extras .github .claude-plugin .codex-plugin; do
    [ -d "$REPO_DIR/$d" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] rsync -a --delete $REPO_DIR/$d/ $dest/$d/"
    else
      mkdir -p "$dest/$d"
      rsync -a --delete "$REPO_DIR/$d/" "$dest/$d/"
    fi
  done
  for f in install.sh README.md CHANGELOG.md LICENSE; do
    [ -f "$REPO_DIR/$f" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] cp $REPO_DIR/$f $dest/$f"
    else
      cp "$REPO_DIR/$f" "$dest/$f"
    fi
  done
}

for t in "${TARGETS[@]}"; do
  dest="${t%%:*}"
  label="${t##*:}"
  sync_skill "$dest" "$label"
  sync_translator "${dest%/stylotrace}/translator" "$label"
done
[ "$MIRROR" -eq 1 ] && sync_mirror "$MIRROR_DIR"

# 4/5 verify the embedded engine can run standalone (skill points only)
step "4/5 verify embedded engine"
VERIFIED=0
for t in "${TARGETS[@]}"; do
  dest="${t%%:*}"
  label="${t##*:}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] node $dest/scripts/stylotrace.mjs --help | grep -q interview"
  else
    if node "$dest/scripts/stylotrace.mjs" --help | grep -q 'interview' &&
       node "$dest/scripts/stylotrace.mjs" --help | grep -q 'redteam'; then
      echo "OK [$label]: engine works - clarify/interview/outline/write/redteam/audience/dissect/restyle all available"
      VERIFIED=1
    else
      echo "ERROR [$label]: engine verification failed. Node >= 18 required: node --version" >&2
      exit 1
    fi
  fi
done
[ "$DRY_RUN" -eq 1 ] && VERIFIED=1

# 5/5 LLM config, optional CLI/MCP, auto-register, summary
step "5/5 LLM config & next steps"
if [ -n "${STYLOTRACE_LLM_API_KEY:-}" ] || [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  echo "OK: LLM key detected (STYLOTRACE_LLM_API_KEY / DEEPSEEK_API_KEY)"
else
  echo "NOTE: no LLM key detected. Before writing, configure:"
  echo "  export STYLOTRACE_LLM_API_KEY=sk-xxx"
  echo "  # optional: export STYLOTRACE_LLM_BASE_URL=...  export STYLOTRACE_LLM_MODEL=..."
fi
if [ "$MCP_CODEX" -eq 1 ]; then
  echo
  echo "Codex MCP config snippet (append to project .codex/config.toml or ~/.codex/config.toml):"
  cat <<EOF
[mcp_servers.stylotrace]
command = "node"
args = ["$SRC_SKILL/scripts/stylotrace.mjs", "mcp"]
EOF
fi
if [ "$WITH_CLI" -eq 1 ]; then
  step "optional: symlink standalone CLI to ${HOME}/.local/bin/stylotrace"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] ln -sf $SRC_SKILL/scripts/stylotrace.mjs ${HOME}/.local/bin/stylotrace"
  else
    mkdir -p "${HOME}/.local/bin"
    ln -sf "$SRC_SKILL/scripts/stylotrace.mjs" "${HOME}/.local/bin/stylotrace"
  fi
fi

if [ "$DRY_RUN" -eq 0 ] && [ "$AUTO_SETUP" -eq 1 ]; then
  step "auto-register (project-scoped, zero manual)"
  if command -v node >/dev/null 2>&1; then
    HOSTS="codex"
    [ "$SETUP_ALL" -eq 1 ] && HOSTS="codex,claude,opencode"
    if ! node "$SRC_SKILL/scripts/stylotrace.mjs" setup --dir "$PROJECT_DIR" --hosts "$HOSTS"; then
      echo "（自动接入未完全成功；稍后可手动运行: node $SRC_SKILL/scripts/stylotrace.mjs setup --dir $PROJECT_DIR）"
    fi
  else
    echo "（未检测到 Node，跳过自动接入；安装 Node >= 18 后运行: node $SRC_SKILL/scripts/stylotrace.mjs setup --dir $PROJECT_DIR）"
  fi
fi

VERSION="$(node -p "require('$REPO_DIR/agent/package.json').version" 2>/dev/null || echo '?')"
cat <<EOF

DONE (v${VERSION}).
- Global skill:  ${HOME}/.codex/skills/stylotrace
- Project skill: ${PROJECT_DIR}/.codex/skills/stylotrace
- Dev mirror:    ${MIRROR_DIR:-（未启用 --mirror）}
- Rollback:      restore ${HOME}/.codex/skills/stylotrace.bak.* / $PROJECT_DIR/.codex/skills/stylotrace.bak.*
- Docs:          https://github.com/zhangyoufu-123/stylotrace

以后更新三处（推荐，skill 自带更新器，随处可跑）:
  bash ${HOME}/.codex/skills/stylotrace/scripts/update.sh [项目目录]
或在仓库目录:
  ./install.sh --all --update
EOF
