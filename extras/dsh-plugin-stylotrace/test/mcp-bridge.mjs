/**
 * dsh-plugin-stylotrace — MCP 桥接隔离测试
 *
 * 用最小 Cordis 风格 ctx 应用插件的 mcp.js(与真实 loader 完全相同的代码路径),
 * 验证:引擎从插件自带路径拉起 → initialize/tools-list 握手 → 工具注册进 ctx.tools。
 * 不需要 LLM、不需要完整 profile、不依赖 loader。
 *
 * 运行: node test/mcp-bridge.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { apply } from '../mcp.js'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ---- 最小 ctx(只实现 mcp-client 用到的面) ----
const registered = []
const effects = []
const ctx = {
  root: { /* 每个 app 一个 root,activeServerNames 用 WeakMap 按 root 记 */ },
  effect(fn, label) { effects.push(fn); return () => {} },
  tools: {
    register(entry) { registered.push(entry) },
  },
}
// ctx.root 需要是一个对象(WeakMap key)
ctx.root = {}

// ---- 应用插件行(与 loader 相同的调用) ----
console.log('应用 dsh-plugin-stylotrace/mcp ...')
await apply(ctx, {})

// 让连接握手稳定
await new Promise((r) => setTimeout(r, 1500))

const mcpTools = registered.filter((t) => t.name && t.name.startsWith('mcp__stylotrace__'))
console.log(`已注册工具: ${registered.length} 个`)
console.log(`mcp__stylotrace__* 工具: ${mcpTools.length} 个`)
console.log('样例:', mcpTools.slice(0, 8).map((t) => t.name).join(' / '))

if (mcpTools.length >= 10) {
  console.log('\n✓ MCP 桥接测试通过:引擎从插件路径拉起,工具已注册进 ctx.tools')
  process.exit(0)
} else {
  console.error(`\n✗ 工具注册不足:期望 ≥10,实际 ${mcpTools.length}`)
  process.exit(1)
}
