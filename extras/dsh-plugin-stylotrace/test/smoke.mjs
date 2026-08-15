/**
 * dsh-plugin-stylotrace — 冒烟测试(离线,不调 LLM)
 *
 * 验证:包结构完整、patch 语法、引擎可启动、MCP 握手返回完整工具面。
 * 运行: node test/smoke.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import readline from 'node:readline'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const assert = (cond, msg) => { if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1 } else console.log(`✓ ${msg}`) }

// 1. 包结构
assert(fs.existsSync(path.join(PKG, 'package.json')), 'package.json 存在')
assert(fs.existsSync(path.join(PKG, 'cordis.patch.yml')), 'cordis.patch.yml 存在')
assert(fs.existsSync(path.join(PKG, 'mcp.js')), 'mcp.js 存在')
assert(fs.existsSync(path.join(PKG, 'client.js')), 'client.js(Web 半区)存在')
assert(fs.existsSync(path.join(PKG, 'index.js')), 'index.js(Node 半区)存在')
const skill = path.join(PKG, 'skills', 'stylotrace')
assert(fs.existsSync(path.join(skill, 'SKILL.md')), '技能包 SKILL.md 存在')
const engine = path.join(skill, 'scripts', 'engine', 'bin', 'stylotrace.js')
assert(fs.existsSync(engine), '引擎入口存在')

// 1b. manifest:client 半区 + ./client 导出
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web')
assert(pkg.exports?.['./client'] === './client.js', 'exports["./client"] 指向 client.js')

// 2. patch 语法:必须引用本包子路径(双行:MCP 桥 + client 半区)
const patch = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
assert(patch.includes('name: dsh-plugin-stylotrace/mcp'), 'patch 引用 dsh-plugin-stylotrace/mcp')
assert(patch.includes('id: stylotrace'), 'patch 行 id 为 stylotrace')
assert(patch.includes('id: stylotrace-client'), 'patch 行 id 为 stylotrace-client')

// 3. SKILL.md frontmatter 兼容 DSH 技能解析(name/description)
const fm = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8').slice(0, 400)
assert(/name:\s*stylotrace/.test(fm), 'SKILL.md 声明 name: stylotrace')
assert(/description:/.test(fm), 'SKILL.md 声明 description')

// 4. 引擎可执行
const run = spawnSync(process.execPath, [engine, 'doctor', '--ping'], { encoding: 'utf8', timeout: 30000 })
assert(run.status !== null, `引擎可启动(exit=${run.status})`)

// 5. MCP 握手:initialize + tools/list
const child = spawn(process.execPath, [engine, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
const rl = readline.createInterface({ input: child.stdout })
const pending = new Map()
let nextId = 1
let toolCount = 0
const done = new Promise((resolve) => {
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const call = (method, params) => new Promise((res) => {
    const id = nextId++
    pending.set(id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  ;(async () => {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } })
    const tools = await call('tools/list', {})
    toolCount = tools.result?.tools?.length ?? 0
    child.kill()
    resolve()
  })()
})
await Promise.race([done, new Promise((r) => setTimeout(r, 20000))])
assert(toolCount >= 10, `MCP tools/list 返回 ${toolCount} 个工具(≥10)`)

console.log(process.exitCode ? '\n冒烟测试未通过' : '\n冒烟测试通过')
