#!/usr/bin/env bash
# Stylotrace Agent 跨平台安装器：装入 Codex / Claude Code / OpenCode
# 位于 skill 内部（skills/stylotrace/scripts/install.sh），skill 自包含。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$SKILL_DIR/scripts/stylotrace.mjs"
DRY_RUN=0
TARGETS=()

usage() {
  cat <<'EOF'
Stylotrace Agent installer

用法:
  ./scripts/install.sh [--codex|--claude|--opencode|--all] [--dry-run]
  ./scripts/install.sh init [目录]       # 初始化 .stylotrace 工作区
  ./scripts/install.sh hooks [--dry-run|--hermes] # 写入 hooks 配置（默认注释版，--hermes 启用 CLI 字符串格式）

示例:
  ./scripts/install.sh --all             # 装入所有已检测到的宿主
  ./scripts/install.sh init .            # 在当前目录生成 .stylotrace/ 工作区
  ./scripts/install.sh hooks --dry-run   # 预览 hooks 接线
EOF
}

install_into() {
  local dest="$1"
  local host="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %-8s → %s\n' "$host" "$dest"
    return
  fi
  if [ -e "$dest" ]; then
    local backup="${dest}.bak.$(date +%s)"
    cp -R "$dest" "$backup"
    printf '[%s] 已存在，备份到 %s\n' "$host" "$backup"
    rm -rf "$dest"
  fi
  mkdir -p "$(dirname "$dest")"
  cp -R "$SKILL_DIR" "$dest"
  chmod +x "$dest/scripts/stylotrace.mjs" "$dest/scripts/install.sh" "$dest/hooks/stylotrace-hook.sh" 2>/dev/null || true
  printf '[%s] 已安装 → %s\n' "$host" "$dest"
}

detect_codex() {
  local base="${CODEX_HOME:-$HOME/.codex}"
  [ -d "$base" ] && install_into "$base/skills/stylotrace" "codex"
}

detect_claude() {
  install_into "$HOME/.claude/skills/stylotrace" "claude"
}

detect_opencode() {
  for base in "$HOME/.config/opencode/skills" "$HOME/.opencode/skills"; do
    [ -d "$(dirname "$base")" ] && { install_into "$base/stylotrace" "opencode"; return; }
  done
  install_into "$HOME/.config/opencode/skills/stylotrace" "opencode"
}

wire_codex_hooks() {
  local config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  local hook_path="${CODEX_HOME:-$HOME/.codex}/skills/stylotrace/hooks/stylotrace-hook.sh"
  local hermes=0
  for arg in "$@"; do
    [ "$arg" = "--hermes" ] && hermes=1
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] 将在 %s 写入 %s hooks 配置，指向 %s\n' "$config" "$([ "$hermes" -eq 1 ] && echo "启用版" || echo "注释版")" "$hook_path"
    return
  fi
  if [ ! -f "$hook_path" ]; then
    printf '错误: 未找到已安装的 hook 脚本 %s。请先运行 install.sh --codex。\n' "$hook_path" >&2
    exit 1
  fi
  if [ -f "$config" ] && grep -q '^\[hooks\]' "$config"; then
    printf '提示: %s 已有 [hooks] 表，为避免覆盖你的配置，请手动添加以下行：\n' "$config"
    printf '\n[hooks]\n'
    for event in SessionStart UserPromptSubmit AssistantMessage Stop PreCompact; do
      printf '%s = "bash %s"\n' "$event" "$hook_path"
    done
    return
  fi
  if [ -f "$config" ]; then
    local backup="${config}.bak.$(date +%s)"
    cp "$config" "$backup"
    printf '已备份原配置 → %s\n' "$backup"
  fi
  {
    printf '\n# Stylotrace observer hooks（scripts/install.sh hooks 写入）\n'
    if [ "$hermes" -eq 1 ]; then
      printf '# 启用版（Hermes CLI 字符串格式）\n[hooks]\n'
      for event in SessionStart UserPromptSubmit AssistantMessage Stop PreCompact; do
        printf '%s = "bash %s"\n' "$event" "$hook_path"
      done
    else
      printf '# 默认注释：ChatGPT app 期望 hooks 为 struct 格式，字符串格式会导致整个配置解析失败。\n'
      printf '# 仅 Hermes CLI 支持字符串格式；使用 CLI 时运行 install.sh hooks --hermes 启用。\n'
      printf '# [hooks]\n'
      for event in SessionStart UserPromptSubmit AssistantMessage Stop PreCompact; do
        printf '# %s = "bash %s"\n' "$event" "$hook_path"
      done
    fi
  } >> "$config"
  printf '已写入 hooks 配置（%s）→ %s\n' "$([ "$hermes" -eq 1 ] && echo "启用版" || echo "注释版")" "$config"
  printf '生效说明: 重启 Codex（或新开会话）后生效；事件载荷由 stylotrace-hook.sh 容错处理。\n'
}

init_project() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] init → %s/.stylotrace\n' "${1:-.}"
    return
  fi
  node "$CLI" init "${1:-.}"
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

case "$1" in
  init)
    shift
    init_project "${1:-.}"
    exit 0
    ;;
  hooks)
    shift
    for arg in "$@"; do
      [ "$arg" = "--dry-run" ] && DRY_RUN=1
    done
    wire_codex_hooks "$@"
    exit 0
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --codex) TARGETS+=(codex) ;;
    --claude) TARGETS+=(claude) ;;
    --opencode) TARGETS+=(opencode) ;;
    --all) TARGETS=(all) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $arg" >&2; usage; exit 1 ;;
  esac
done

if [[ " ${TARGETS[*]} " == *" all "* ]]; then
  detect_codex
  detect_claude
  detect_opencode
else
  for t in "${TARGETS[@]}"; do
    case "$t" in
      codex) detect_codex ;;
      claude) detect_claude ;;
      opencode) detect_opencode ;;
    esac
  done
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "（dry-run 结束，未写入任何文件）"
fi
