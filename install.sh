#!/usr/bin/env bash
# Sculptor one-click installer (open-source distribution entry).
# The skill ships the complete agent engine inside it - no separate CLI needed.
#
# Usage (either):
#   curl -fsSL https://raw.githubusercontent.com/zhangyoufu-123/sculptor-agent/main/install.sh | bash
#   git clone https://github.com/zhangyoufu-123/sculptor-agent && cd sculptor-agent && ./install.sh
#
# Options:
#   --project <dir>   project-scoped install into <dir>/.codex/skills/sculptor (default: current dir)
#   --global          install into ~/.codex/skills/sculptor (affects all Codex sessions)
#   --cli             also symlink the standalone CLI to ~/.local/bin/sculptor (optional)
#   --mcp-codex       print Codex MCP config snippet (never modifies host config on its own)
#   --dry-run         only show what would be done
set -euo pipefail

DRY_RUN=0
PROJECT_DIR=""
GLOBAL=0
WITH_CLI=0
MCP_CODEX=0
REPO_URL="${SCULPTOR_REPO_URL:-https://github.com/zhangyoufu-123/sculptor-agent}"

usage() {
  sed -n '1,18p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --global) GLOBAL=1; shift ;;
    --cli) WITH_CLI=1; shift ;;
    --mcp-codex) MCP_CODEX=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }

# 1/5 locate the repository (local checkout or clone)
# 按脚本自身位置判断（bash /path/to/install.sh 从任意目录调用都成立）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/agent/package.json" ] && [ -d "$SCRIPT_DIR/skills/sculptor" ]; then
  REPO_DIR="$SCRIPT_DIR"
  step "1/5 use local repo: $REPO_DIR"
else
  REPO_DIR="${SCULPTOR_INSTALL_DIR:-${HOME}/.local/share/sculptor-agent}"
  step "1/5 clone repo to $REPO_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] git clone --depth 1 $REPO_URL $REPO_DIR"
  else
    mkdir -p "$(dirname "$REPO_DIR")"
    [ -d "$REPO_DIR/.git" ] || git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  fi
fi

# 2/5 decide the install target (project-scoped by default)
if [ "$GLOBAL" -eq 1 ]; then
  DEST="${HOME}/.codex/skills/sculptor"
  step "2/5 global install -> $DEST (affects all Codex sessions)"
else
  PROJECT_DIR="${PROJECT_DIR:-$PWD}"
  DEST="$PROJECT_DIR/.codex/skills/sculptor"
  step "2/5 project-scoped install -> $DEST (this project only)"
fi

if [ -d "$DEST" ]; then
  BK="$DEST.bak.$(date +%s)"
  step "existing install found; backing up to $BK (recoverable)"
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] cp -R $DEST $BK"; else cp -R "$DEST" "$BK"; fi
fi

# 3/5 copy the skill (embedded engine included)
step "3/5 copy skill -> $DEST"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] cp -R $REPO_DIR/skills/sculptor $DEST"
else
  mkdir -p "$(dirname "$DEST")"
  cp -R "$REPO_DIR/skills/sculptor" "$DEST"
fi

# 4/5 verify the embedded engine can run standalone
step "4/5 verify embedded engine"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] node $DEST/scripts/sculptor.mjs --help | grep -q interview"
else
  if node "$DEST/scripts/sculptor.mjs" --help | grep -q 'interview' &&
     node "$DEST/scripts/sculptor.mjs" --help | grep -q 'redteam'; then
    echo "OK: engine works - clarify/interview/outline/write/redteam/audience/dissect/restyle all available"
  else
    echo "ERROR: engine verification failed. Node >= 18 required: node --version" >&2
    exit 1
  fi
fi

# 5/5 LLM config and next steps
step "5/5 LLM config & next steps"
if [ -n "${SCULPTOR_LLM_API_KEY:-}" ] || [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  echo "OK: LLM key detected (SCULPTOR_LLM_API_KEY / DEEPSEEK_API_KEY)"
else
  echo "NOTE: no LLM key detected. Before writing, configure:"
  echo "  export SCULPTOR_LLM_API_KEY=sk-xxx"
  echo "  # optional: export SCULPTOR_LLM_BASE_URL=...  export SCULPTOR_LLM_MODEL=..."
fi
if [ "$MCP_CODEX" -eq 1 ]; then
  echo
  echo "Codex MCP config snippet (append to project .codex/config.toml or ~/.codex/config.toml):"
  cat <<EOF
[mcp_servers.sculptor]
command = "node"
args = ["$DEST/scripts/sculptor.mjs", "mcp"]
EOF
fi
if [ "$WITH_CLI" -eq 1 ]; then
  step "optional: symlink standalone CLI to ${HOME}/.local/bin/sculptor"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] ln -sf $DEST/scripts/sculptor.mjs ${HOME}/.local/bin/sculptor"
  else
    mkdir -p "${HOME}/.local/bin"
    ln -sf "$DEST/scripts/sculptor.mjs" "${HOME}/.local/bin/sculptor"
  fi
fi

cat <<EOF

DONE.
- Skill (with full engine): $DEST
- Zero manual steps (recommended): run once
    node $DEST/scripts/sculptor.mjs setup
  -> auto-registers this project's MCP + skill + credentials for
     Codex/Claude Code/OpenCode; open a NEW chat and just describe your
     writing task - Sculptor starts on its own.
- Or start the director manually: node $DEST/scripts/sculptor.mjs agent
- Or let the host agent call it per $DEST/SKILL.md
- Rollback: move $DEST.bak.* back to $DEST if needed
- Docs: https://github.com/zhangyoufu-123/sculptor-agent
EOF
