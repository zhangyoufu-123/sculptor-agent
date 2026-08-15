/**
 * 验收:DSH 实际接口(MCP 层)的工具独立性与协作性。
 * 模拟宿主 agent 通过 MCP 从"任意阶段"开始调用工具——不依赖完整流程顺序。
 * 运行: node test/independence-check.mjs(临时验收脚本,不入测试套件)
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import os from 'node:os'

const ENGINE = path.join(process.cwd(), 'skills', 'stylotrace', 'scripts', 'engine', 'bin', 'stylotrace.js')
if (!fs.existsSync(ENGINE)) {
  console.error('请从 extras/dsh-plugin-stylotrace 目录运行')
  process.exit(1)
}

// 独立工作区
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ind-'))
fs.mkdirSync(path.join(ws, 'protocol'), { recursive: true })
fs.mkdirSync(path.join(ws, 'vault'), { recursive: true })
const TPL = path.join('skills', 'stylotrace', 'scripts', 'engine', 'templates')
fs.copyFileSync(path.join(TPL, 'state.template.json'), path.join(ws, 'protocol', 'state.json'))
fs.copyFileSync(path.join(TPL, 'write-style.template.json'), path.join(ws, 'vault', 'write-style.json'))
fs.copyFileSync(path.join(TPL, 'read-style.template.json'), path.join(ws, 'vault', 'read-style.json'))

// 项目(供 synthesize)
const proj = path.join(ws, 'proj')
fs.mkdirSync(proj, { recursive: true })
fs.writeFileSync(path.join(proj, 'README.md'), '# demo\n本地优先的 AI 笔记工具。\n')
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', description: 'desc', dependencies: { sqlite3: '^5' } }))

const child = spawn(process.execPath, [ENGINE, 'mcp'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, STYLOTRACE_LLM_API_KEY: '', STYLOTRACE_CREDENTIALS: 'off' },
})
const rl = readline.createInterface({ input: child.stdout })
const pending = new Map()
let id = 1
const call = (method, params) => new Promise((resolve, reject) => {
  const i = id++
  pending.set(i, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`超时 ${method}`)) } }, 20000)
})
rl.on('line', (l) => { try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })

const results = []
async function check(name, fn) {
  try {
    const r = await fn()
    const ok = r && !r.error
    results.push({ name, ok, detail: ok ? (r.text || r.result || 'ok') : JSON.stringify(r).slice(0, 120) })
  } catch (e) {
    results.push({ name, ok: false, detail: e.message })
  }
}

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acc', version: '1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

// 1. 生态位判断(零依赖,第一件事就可以做)
await check('probe 独立可用', async () => (await call('tools/call', { name: 'probe', arguments: { text: '帮我写一篇关于故乡的散文' } })).result)

// 2. 风格档案(任何阶段可查)
await check('style_status 独立可用', async () => (await call('tools/call', { name: 'style_status', arguments: { workspace: ws } })).result)

// 3. 项目自动提炼(完全不依赖写作流程)
await check('synthesize 独立可用', async () => (await call('tools/call', { name: 'synthesize', arguments: { workspace: ws, project: proj, target: 'product', topic: 'demo' } })).result)

// 4. 定点修改(直接改用户句子,不经过澄清/大纲)
await check('point_edit 独立可用', async () => {
  const f = path.join(ws, 'note.md')
  fs.writeFileSync(f, '这是一个测试句子。\n')
  return (await call('tools/call', { name: 'point_edit', arguments: { workspace: ws, quote: '这是一个测试句子。', instruction: '更口语', file: f } })).result
})

// 5. 澄清单步(流程入口,可单独调用)
await check('clarify_step 独立可用', async () => (await call('tools/call', { name: 'clarify_step', arguments: { workspace: ws, lastInput: '我想写一篇散文' } })).result)

// 6. 读者群像(对任意文件,不依赖流程)
await check('audience 独立可用(确定性兜底)', async () => {
  const f = path.join(ws, 'draft.md')
  fs.writeFileSync(f, '# 标题\n\n正文内容示例。\n')
  return (await call('tools/call', { name: 'audience', arguments: { workspace: ws, file: f } })).result
})

// 7. 反 AI 审计(任意文本)
await check('redteam 独立可用(确定性)', async () => {
  const f = path.join(ws, 'draft2.md')
  fs.writeFileSync(f, '总而言之,综上所述,首先其次最后。\n')
  return (await call('tools/call', { name: 'redteam', arguments: { workspace: ws, file: f } })).result
})

child.kill()
let pass = 0
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}`)
  if (!r.ok) console.log(`   详情: ${r.detail}`)
  else pass++
}
console.log(`\n独立工具验收: ${pass}/${results.length} 通过`)
fs.rmSync(ws, { recursive: true, force: true })
process.exit(pass === results.length ? 0 : 1)
