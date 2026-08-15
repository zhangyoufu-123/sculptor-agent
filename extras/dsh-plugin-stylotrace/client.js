// dsh-plugin-stylotrace — 浏览器半区（client bundle，零构建、纯 DOM）。
//
// 与 omdsh-dev/dsh-annotation 同模式：手写 CJS + window.__ModuleLoader__ 注册，
// 无任何 @deepseek-ai 值导入（bundle purity gate 合规），cordis 服务经
// exports.inject 的字符串名接入。
//
// 两个能力：
//   1. 「Stylotrace 改进」选区工具条 —— 在页面任意文本上选中一句，
//      浮动工具条把选中内容包成「Stylotrace 引用」块插入输入框：
//      〔Stylotrace 引用〕《原句》
//      修改指令：按我的风格改进这一句（更像我写的）
//      发送后宿主 agent 会调用 mcp__stylotrace__point_edit 精修该句并吸收进风格档案。
//      （找不到输入框时退化为复制到剪贴板 + 提示。）
//   2. 「作品」识别 —— 扫描助手消息中的 synthesized/*.(md|docx|html) 等
//      产出路径（Stylotrace 自动提炼写作的产物），渲染为可复制的作品 chip。
//
// 健壮性契约（保证不出错）：
//   - 全部功能包在 try/catch，任何异常静默降级，绝不污染宿主页面；
//   - 使用 MutationObserver（DOMNodeInserted 已废弃）；
//   - 选区/扫描均防抖，避免性能问题；
//   - 找不到任何目标 DOM 时安全返回，不抛错。
//
// 判别式沿用社区惯例：助手行 = [data-time-hover-root] 且不含 user bubble；
// 同时兼容 focus-chat 的 [data-focus-flow] 视图。

window.__ModuleLoader__.load({
  // 必须与 package.json "name" 完全一致
  id: 'dsh-plugin-stylotrace',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    function safe(fn) {
      try { return fn() } catch (e) {
        if (typeof console !== 'undefined' && console.debug) {
          try { console.debug('[dsh-plugin-stylotrace]', e && e.message || e) } catch (_) {}
        }
        return null
      }
    }

    safe(function init() {
      // ============================== 样式 ==============================
      var STYLE_ID = 'dsh-plugin-stylotrace-style'
      if (document.getElementById(STYLE_ID) === null) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = [
          '.stylo-selbar { position: fixed; z-index: 1300; display: flex; align-items: center;',
          '  gap: 4px; padding: 4px 8px; border-radius: 10px;',
          '  border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-specific-menu, #2c2c2e);',
          '  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.3));',
          '  font: 12px var(--dsw-font-family, system-ui); color: var(--dsw-text-strong, #eee);',
          '  cursor: pointer; user-select: none; white-space: nowrap; }',
          '.stylo-selbar:hover { filter: brightness(1.15); }',
          '.stylo-toast { position: fixed; z-index: 1400; left: 50%; bottom: 96px; transform: translateX(-50%);',
          '  padding: 8px 14px; border-radius: 10px; background: var(--dsw-specific-menu, #2c2c2e);',
          '  color: var(--dsw-text-strong, #eee); font: 13px var(--dsw-font-family, system-ui);',
          '  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.4)); opacity: 0;',
          '  transition: opacity .2s; pointer-events: none; }',
          '.stylo-works { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }',
          '.stylo-works-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;',
          '  border-radius: 999px; border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-alias-bg-elevated, #333); color: var(--dsw-text-strong, #eee);',
          '  font: 12px var(--dsw-font-family, system-ui); cursor: pointer; }',
          '.stylo-works-chip:hover { filter: brightness(1.15); }',
        ].join('\n')
        document.head.appendChild(style)
      }

      // ============================== 工具 ==============================
      var BAR_ID = 'stylo-selbar'
      var bar = null

      function toast(text) {
        var el = document.createElement('div')
        el.className = 'stylo-toast'
        el.textContent = text
        document.body.appendChild(el)
        requestAnimationFrame(function () { el.style.opacity = '1' })
        setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove() }, 250) }, 2200)
      }

      function removeBar() {
        if (bar) { bar.remove(); bar = null }
      }

      // 组装「Stylotrace 引用」块（协议与 stylotrace quote / point_edit 一致）
      function buildQuoteBlock(text) {
        var q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!q) return ''
        return '〔Stylotrace 引用〕《' + q + '》\n修改指令：按我的风格改进这一句（更像我写的）'
      }

      // 找到输入框：优先 activeElement，其次 composer 区域的 textarea / contenteditable
      function findComposer() {
        var ae = document.activeElement
        if (ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return ae
        var ta = document.querySelector('textarea')
        if (ta) return ta
        var ce = document.querySelector('[contenteditable="true"]')
        return ce || null
      }

      // 把文本插入输入框末尾（保留用户已输入内容）
      function insertIntoComposer(composer, block) {
        if (composer.tagName === 'TEXTAREA') {
          composer.value = (composer.value ? composer.value.replace(/\s+$/, '') + '\n\n' : '') + block
          composer.focus()
          composer.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        if (composer.isContentEditable) {
          var node = document.createTextNode('\n\n' + block)
          composer.appendChild(node)
          composer.focus()
          composer.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        return false
      }

      // 选区 → 工具条
      var selTimer = null
      function onSelectionChange() {
        if (selTimer) return
        selTimer = setTimeout(function () {
          selTimer = null
          safe(function () {
            var sel = window.getSelection()
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) { removeBar(); return }
            var text = sel.toString()
            if (!text || text.trim().length < 2) { removeBar(); return }
            var rect = sel.getRangeAt(0).getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) { removeBar(); return }
            if (!bar) {
              bar = document.createElement('div')
              bar.id = BAR_ID
              bar.className = 'stylo-selbar'
              bar.textContent = 'Stylotrace 改进'
              bar.title = '把选中这句交给 Stylotrace 按你的风格改进'
              bar.addEventListener('mousedown', function (e) {
                e.preventDefault()
                e.stopPropagation()
                safe(function () {
                  var chosen = sel ? sel.toString() : text
                  var block = buildQuoteBlock(chosen)
                  if (!block) return
                  var composer = findComposer()
                  if (composer && insertIntoComposer(composer, block)) {
                    toast('已插入「Stylotrace 引用」，按 Enter 发送即可')
                  } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(block)
                    toast('已复制 Stylotrace 引用块，粘贴到输入框发送')
                  }
                })
                removeBar()
              })
              document.body.appendChild(bar)
            }
            bar.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 190)) + 'px'
            bar.style.top = Math.max(4, rect.top - 34) + 'px'
          })
        }, 0)
      }

      document.addEventListener('mouseup', onSelectionChange)
      document.addEventListener('keyup', function (e) {
        if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') onSelectionChange()
      })
      document.addEventListener('mousedown', function (e) {
        if (bar && !bar.contains(e.target)) removeBar()
      })
      window.addEventListener('scroll', removeBar, true)

      // ============================== 作品识别 ==============================
      // 助手消息里的 synthesized/*.(md|docx|html)（或其他产出路径）→ 渲染 chip
      var WORKS_RE = /(?:synthesized\/|draft\.|out\/)[\w\u4e00-\u9fa5./-]+\.(?:md|docx|html)/g
      var seen = new WeakSet()

      function isAssistantRow(node) {
        var el = node && node.closest
          ? node.closest('[data-time-hover-root], [data-focus-flow] [class*="assistant"]')
          : null
        if (!el) return false
        return !el.querySelector('[class*="bubble"]')
      }

      function renderWorks(messageEl, paths) {
        if (!messageEl || !messageEl.appendChild) return
        var row = document.createElement('div')
        row.className = 'stylo-works'
        var label = document.createElement('span')
        label.style.cssText = 'font: 11px var(--dsw-font-family,system-ui); color: var(--dsw-text-weak,#999); align-self:center'
        label.textContent = 'Stylotrace 作品'
        row.appendChild(label)
        paths.forEach(function (p) {
          var chip = document.createElement('span')
          chip.className = 'stylo-works-chip'
          chip.textContent = '📄 ' + String(p).split('/').pop()
          chip.title = p
          chip.addEventListener('click', function () {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(p)
              toast('已复制路径: ' + p)
            }
          })
          row.appendChild(chip)
        })
        messageEl.appendChild(row)
      }

      function scanMessages() {
        safe(function () {
          var rows = document.querySelectorAll('[data-time-hover-root]')
          rows.forEach(function (row) {
            if (seen.has(row)) return
            seen.add(row)
            if (isAssistantRow(row)) {
              var text = row.innerText || row.textContent || ''
              var paths = text.match(WORKS_RE) || []
              var unique = []
              paths.forEach(function (p) { if (unique.indexOf(p) === -1) unique.push(p) })
              if (unique.length) renderWorks(row, unique.slice(0, 6))
            }
          })
        })
      }

      // MutationObserver 替代已废弃的 DOMNodeInserted；防抖合并
      var scanTimer = null
      function scheduleScan() {
        if (scanTimer) return
        scanTimer = setTimeout(function () {
          scanTimer = null
          scanMessages()
        }, 400)
      }
      safe(function () {
        var mo = new MutationObserver(function () { scheduleScan() })
        mo.observe(document.body, { childList: true, subtree: true })
      })
      window.setInterval(function () { safe(scanMessages) }, 3000)
      safe(scanMessages)
    })

    module.exports = exports
    return module.exports
  },
})
