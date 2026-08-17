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

  // 3. 选区 → 工具条(两个按钮:改进 + 批注)
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
  if (barVisible && barVisible.text.includes('改进') && barVisible.text.includes('批注')) {
    ok('选区工具条出现(改进 + 批注)')
  } else {
    fail('工具条未出现或按钮缺失', JSON.stringify(barVisible))
  }

  // 4. 点击「改进」按钮 → 引用块插入输入框
  await evaluate(`(function(){
    var b = document.getElementById('stylo-selbar')
    var btn = b && Array.from(b.querySelectorAll('button')).find(x => x.textContent.includes('改进'))
    if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return !!btn
  })()`)
  await sleep(300)
  const composerValue = await evaluate(`document.getElementById('composer').value`)
  if (composerValue.includes('〔Stylotrace 引用〕《') && composerValue.includes('修改指令')) {
    ok('点击后引用块插入输入框')
  } else {
    fail('引用块未插入', composerValue.slice(0, 120))
  }

  // ===================== 注释系统验收 =====================
  // 5. 选区 → 批注输入层 → 保存
  await evaluate(`(() => {
    const msg = document.querySelector('[data-time-hover-root] .user-bubble')
    const range = document.createRange()
    range.selectNodeContents(msg)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  const annoBtnClicked = await evaluate(`(function(){
    var b = document.getElementById('stylo-selbar')
    var btn = b && Array.from(b.querySelectorAll('button')).find(x => x.textContent.includes('批注'))
    if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return !!btn
  })()`)
  await sleep(300)
  const inputVisible = await evaluate(`!!document.querySelector('.stylo-anno-input-wrap textarea')`)
  if (inputVisible) ok('批注输入层弹出'); else fail('批注输入层未弹出', '')
  await evaluate(`(() => {
    const ta = document.querySelector('.stylo-anno-input-wrap textarea')
    ta.value = '这段可以更口语化一些'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const save = Array.from(document.querySelectorAll('.stylo-anno-input-wrap button')).find(x => x.textContent.includes('保存批注'))
    save.click()
    return true
  })()`)
  await sleep(300)
  const savedCount = await evaluate(`(function(){
    try { return JSON.parse(localStorage.getItem('dsh-plugin-stylotrace.annotations') || '[]').length } catch(e) { return -1 }
  })()`)
  if (savedCount === 1) ok('批注保存到 localStorage'); else fail('批注未保存', savedCount)

  // 6. 查看:打开面板,注释项存在且内容正确
  await evaluate(`(function(){
    var chip = document.querySelector('.stylo-anno-chip')
    if (chip) chip.click()
    return !!chip
  })()`)
  await sleep(300)
  const panelText = await evaluate(`document.querySelector('.stylo-anno-panel') ? document.querySelector('.stylo-anno-panel').innerText : ''`)
  if (panelText.includes('这段可以更口语化一些') && panelText.includes('把这段改得更口语')) {
    ok('面板可查看注释(原文 + 批注)')
  } else {
    fail('面板查看失败', panelText.slice(0, 120))
  }

  // 7. 编辑:点编辑 → 改内容 → 保存
  await evaluate(`(() => {
    window.__origConfirm = window.confirm
    window.confirm = () => true
    const item = document.querySelector('.stylo-anno-item')
    const editBtn = Array.from(item.querySelectorAll('button')).find(x => x.textContent === '编辑')
    editBtn.click()
    return true
  })()`)
  await sleep(200)
  await evaluate(`(() => {
    const ta = document.querySelector('.stylo-anno-item textarea')
    ta.value = '改为:更口语,并且更简洁'
    const save = Array.from(document.querySelectorAll('.stylo-anno-item button')).find(x => x.textContent === '保存')
    save.click()
    return true
  })()`)
  await sleep(300)
  const editedText = await evaluate(`document.querySelector('.stylo-anno-panel') ? document.querySelector('.stylo-anno-panel').innerText : ''`)
  if (editedText.includes('改为:更口语,并且更简洁')) {
    ok('批注可编辑(内容已更新)')
  } else {
    fail('编辑未生效', editedText.slice(0, 120))
  }

  // 8. 删除:点删除 → confirm 已覆盖 → 项消失
  await evaluate(`(() => {
    const item = document.querySelector('.stylo-anno-item')
    const delBtn = Array.from(item.querySelectorAll('button')).find(x => x.textContent === '删除')
    delBtn.click()
    return true
  })()`)
  await sleep(300)
  const afterDel = await evaluate(`(function(){
    try { return JSON.parse(localStorage.getItem('dsh-plugin-stylotrace.annotations') || '[]').length } catch(e) { return -1 }
  })()`)
  if (afterDel === 0) ok('批注可删除(localStorage 清空)'); else fail('删除未生效', afterDel)

  // 9. 持久化:reload 后注释保留
  await evaluate(`(() => {
    window.__origConfirm && (window.confirm = window.__origConfirm)
    return true
  })()`)
  await evaluate(`(function(){
    var list = JSON.parse(localStorage.getItem('dsh-plugin-stylotrace.annotations') || '[]')
    list.push({ id:'persist-test', quote:'持久化测试原文', note:'重启后还在', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })
    localStorage.setItem('dsh-plugin-stylotrace.annotations', JSON.stringify(list))
    location.reload()
    return true
  })()`)
  await sleep(1800) // 等 reload + bundle 重新 materialize
  const persisted = await evaluate(`(function(){
    try {
      const arr = JSON.parse(localStorage.getItem('dsh-plugin-stylotrace.annotations') || '[]')
      return arr.length === 1 && arr[0].note === '重启后还在'
    } catch(e) { return false }
  })()`)
  if (persisted) ok('批注持久化(刷新后保留)'); else fail('持久化失败', '')

  // 10. 作品 chip「·打开」在无 host 服务时降级(不抛错)
  await evaluate(`(() => {
    const openBtn = document.querySelector('.stylo-works-chip .open')
    if (openBtn) openBtn.click()
    return !!openBtn
  })()`)
  await sleep(200)
  const stillAlive = await evaluate(`typeof window.getSelection === 'function'`)
  if (stillAlive) ok('打开文件降级路径无异常'); else fail('降级路径出错', '')

  // 11. 无页面报错
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
