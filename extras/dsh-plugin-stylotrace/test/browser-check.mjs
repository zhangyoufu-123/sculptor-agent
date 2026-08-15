/**
 * dsh-plugin-stylotrace — client.js 真实浏览器验收(headless Chrome + CDP)
 *
 * 用 Google Chrome headless 加载 test/fixture.html(模拟 DSH web DOM),
 * 经 CDP 驱动真实交互:
 *   1. bundle 加载无异常、无页面报错;
 *   2. 助手消息中的 synthesized/* 路径被渲染为作品 chip;
 *   3. 模拟文本选区 → 「Stylotrace 改进」工具条出现;
 *   4. 点击工具条 → 「Stylotrace 引用」块插入输入框;
 *   5. 剪贴板/输入框降级路径不抛错。
 *
 * 运行: node test/browser-check.mjs  (需本机 Google Chrome;找不到则跳过,返回 0)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
if (!CHROME) {
  console.log('⚠ 未找到 Chrome,跳过浏览器验收(不影响其他测试)')
  process.exit(0)
}

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture.html')
const PORT = 9333 + Math.floor(Math.random() * 1000)

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'st-chrome-')),
  `file://${FIXTURE}`,
], { stdio: ['ignore', 'ignore', 'ignore'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const pages = await r.json()
      if (pages && pages.length) {
        // 优先选加载了 fixture 的页面 target(忽略扩展/背景页)
        const target = pages.find((p) => p.type === 'page' && (p.url || '').startsWith('file://'))
          || pages.find((p) => p.type === 'page')
        if (target) return target.webSocketDebuggerUrl
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('无法连接 Chrome CDP')
}

let msgId = 0
const pending = new Map()
const consoleErrors = []
let ws

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP 超时: ${method}`))
      }
    }, 10000)
  })
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}

let pass = 0
let failed = 0
const ok = (name) => { pass++; console.log(`✓ ${name}`) }
const fail = (name, detail) => { failed++; console.error(`✗ ${name}: ${detail}`); process.exitCode = 1 }

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('ws error'))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result || {})
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args?.map((a) => a.value || a.description || '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + (m.params.exceptionDetails?.text || ''))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500) // 等 bundle materialize + 首次扫描

  // 0. 诊断:页面实际状态
  const diag = await evaluate(`({
    href: location.href,
    title: document.title,
    hasModuleLoader: typeof window.__ModuleLoader__ === 'object',
    bodyLen: document.body ? document.body.innerHTML.length : -1,
    hasComposer: !!document.getElementById('composer'),
    hasMsg: !!document.querySelector('[data-time-hover-root]'),
  })`)
  console.log('诊断:', JSON.stringify(diag))

  // 1. bundle 加载
  const loaded = await evaluate('window.__stylotraceBundleLoaded')
  if (loaded) {
    ok(`bundle 注册(id=${loaded})`)
  } else {
    fail('bundle 未注册', 'null')
  }
  const factoryErr = await evaluate('window.__stylotraceFactoryError || null')
  if (factoryErr) {
    fail('factory 执行异常', factoryErr)
  } else {
    ok('factory 执行无异常')
  }

  // 2. 作品 chip 渲染
  const chips = await evaluate(
    `Array.from(document.querySelectorAll('.stylo-works-chip')).map(c => c.textContent)`,
  )
  if (chips.length === 2) {
    ok(`作品 chip 渲染: ${chips.join(' / ')}`)
  } else {
    fail('作品 chip 数量', JSON.stringify(chips))
  }
  const worksCount = await evaluate(`document.querySelectorAll('.stylo-works').length`)
  const userMsgHasWorks = await evaluate(`(() => {
    const rows = document.querySelectorAll('[data-time-hover-root]')
    let bad = 0
    rows.forEach(r => {
      const t = r.innerText
      if (t.includes('把这段改得更口语') && r.querySelector('.stylo-works')) bad++
    })
    return bad
  })()`)
  if (userMsgHasWorks === 0) {
    ok('用户消息不渲染作品行')
  } else {
    fail('用户消息误渲染作品行', userMsgHasWorks)
  }
  if (worksCount >= 1) {
    ok('作品行存在')
  } else {
    fail('作品行缺失', worksCount)
  }

  // 3. 选区 → 工具条
  await evaluate(`(() => {
    const msg = document.querySelector('[data-time-hover-root] .user-bubble')
    const range = document.createRange()
    range.selectNodeContents(msg)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return msg.innerText.length
  })()`)
  await sleep(300)
  const barVisible = await evaluate(
    `(function(){ var b = document.getElementById('stylo-selbar'); return b ? { text: b.textContent } : null })()`,
  )
  if (barVisible && barVisible.text.includes('Stylotrace 改进')) {
    ok('选区工具条出现')
  } else {
    fail('工具条未出现', JSON.stringify(barVisible))
  }

  // 4. 点击工具条 → 引用块插入输入框
  await evaluate(`(function(){
    var b = document.getElementById('stylo-selbar')
    if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return !!b
  })()`)
  await sleep(300)
  const composerValue = await evaluate(`document.getElementById('composer').value`)
  if (composerValue.includes('〔Stylotrace 引用〕《') && composerValue.includes('修改指令')) {
    ok('点击后引用块插入输入框')
  } else {
    fail('引用块未插入', composerValue.slice(0, 120))
  }

  // 5. 无页面报错
  if (consoleErrors.length === 0) {
    ok('无页面 JS 错误')
  } else {
    fail('存在页面 JS 错误', consoleErrors.join(' | '))
  }

  console.log(`\n浏览器验收: ${pass} 通过 / ${failed} 失败`)
} catch (e) {
  console.error(`✗ 浏览器验收失败: ${e.message}`)
  process.exitCode = 1
} finally {
  try { ws && ws.close() } catch {}
  chrome.kill()
}
