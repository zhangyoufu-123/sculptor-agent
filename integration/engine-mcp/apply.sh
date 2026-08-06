#!/usr/bin/env bash
# 一键把 Engine MCP 接入原 sculptor 项目（方案 1）
# 用法: bash apply.sh [仓库路径，默认 /Users/wallace/sculptor]
set -euo pipefail

REPO="${1:-/Users/wallace/sculptor}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$REPO/src" ] || { echo "❌ 找不到仓库: $REPO"; exit 1; }

echo "=== 1/4 复制 src/mcp 到仓库 ==="
mkdir -p "$REPO/src/mcp"
cp -R "$HERE/src/mcp/." "$REPO/src/mcp/"
echo "已复制 → $REPO/src/mcp/{workspace,server}.ts"

echo "=== 2/4 注册 mcp 子命令到 sculptor-cli.ts ==="
python3 - "$REPO/src/cli/sculptor-cli.ts" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
marker = "// Inspect commands"
block = """// Sculptor Engine MCP（方案1 接入）
program
  .command('mcp')
  .description('启动 MCP stdio 服务器（供 Codex/Claude Code/OpenCode 调用引擎）')
  .action(async () => {
    const { startMcpServer } = await import('../mcp/server');
    await startMcpServer();
  });

"""
assert marker in src, '未找到插入锚点 // Inspect commands'
if "command('mcp')" not in src:
    src = src.replace(marker, block + marker, 1)
    open(path, 'w', encoding='utf-8').write(src)
    print('已插入 mcp 子命令')
else:
    print('mcp 子命令已存在，跳过')
PY

echo "=== 3/4 添加 npm script: sculptor:mcp ==="
node - "$REPO/package.json" <<'JS'
const fs = require('fs');
const p = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts = pkg.scripts || {};
if (!pkg.scripts['sculptor:mcp']) {
  pkg.scripts['sculptor:mcp'] = 'tsx --tsconfig tsconfig.json src/mcp/server.ts';
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  console.log('已添加 npm run sculptor:mcp');
} else {
  console.log('sculptor:mcp 已存在，跳过');
}
JS

echo "=== 4/4 校验（type-check + 单测）==="
cd "$REPO"
npm run type-check
npm run test:unit

cat <<EOF

✅ 接入完成。下一步：
1. 配置引擎 LLM（与 console 相同）：DEEPSEEK_API_KEY（可选 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL），或项目根放 .env.local
2. 手动验证: npm run sculptor:mcp  然后按 MCP 协议发 initialize / tools/list
3. 注册到 Codex —— ⚠️ 只写项目级配置（如 zhi/.codex/config.toml），绝不写全局 ~/.codex/config.toml:
   在项目 .codex/config.toml 追加（先备份）:
   [mcp_servers.sculptor-engine]
   command = "/Users/wallace/sculptor/node_modules/.bin/tsx"
   args = ["--tsconfig", "/Users/wallace/sculptor/tsconfig.json", "/Users/wallace/sculptor/src/mcp/server.ts"]
   只有该项目的对话会加载；其他对话/项目不受影响。
4. 触发纪律：MCP 是被动工具，宿主只在用户显式要求或任务明显是长文写作时调用。
5. 完整 agent = 原引擎（深度）+ MCP 协议层（协作）；skill 只是入口
EOF
