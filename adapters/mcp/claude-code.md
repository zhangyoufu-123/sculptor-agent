# Claude Code 接入

方式一（命令，写入用户级配置）：

```bash
claude mcp add stylotrace -- node "$HOME/.codex/skills/stylotrace/scripts/engine/bin/stylotrace.js" mcp
```

方式二（项目级 `.mcp.json`，提交进仓库）：

```json
{
  "mcpServers": {
    "stylotrace": {
      "command": "node",
      "args": ["$HOME/.codex/skills/stylotrace/scripts/engine/bin/stylotrace.js", "mcp"]
    }
  }
}
```
