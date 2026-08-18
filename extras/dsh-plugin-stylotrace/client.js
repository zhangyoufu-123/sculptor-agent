// dsh-plugin-stylotrace — 浏览器半区 v2（client bundle，零构建、纯 DOM）。
//
// 与 omdsh-dev/dsh-annotation 同模式：手写 CJS + window.__ModuleLoader__ 注册，
// 无任何 @deepseek-ai 值导入（bundle purity gate 合规），纯 DOM 功能、不注入
// 任何 cordis 服务（exports.inject = []，见下方注释）。
//
// 能力：
//   1. 「Stylotrace 改进」选区工具条 —— 选中一句 → 引用块插入输入框，
//      发送后宿主 agent 调 mcp__stylotrace__point_edit 精修并吸收进风格档案。
//   2. 「批注」完整注释系统 —— 精准批注（选中 → 写批注）、查看、编辑、删除，
//      localStorage 持久化（刷新不丢），消息行角标 + 高亮定位。
//   3. 「作品」识别与打开 —— 扫描 synthesized/*.(md|docx|html|pdf|srt) 产出，
//      渲染作品 chip：复制路径，或经 WorkspaceRuntime.openPath 用系统默认应用
//      打开（docx → Word）；拿不到 host 服务时自动降级为复制路径。
//
// 健壮性契约（保证安装/运行不出任何问题）：
//   - 全部功能包在 try/catch，任何异常静默降级，绝不污染宿主页面；
//   - 服务注入全部可选：require 失败 / openPath 失败 → 降级复制路径；
//   - MutationObserver（DOMNodeInserted 已废弃）+ 防抖；
//   - 不依赖任何宿主 DOM 结构细节，找不到目标时安全返回。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-stylotrace',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    // 纯 DOM 插件，不注入任何 cordis 服务。
    // 注意：exports.inject 数组里的每个名字都是「必需依赖」——一旦声明了不存在的
    // 服务（曾误写 workspaceRuntime；真实服务名是 workspaces，且它没有 openPath
    // 方法），插件会永远停在 pending，host boot 直接报
    //   "did not activate (waiting for service: workspaceRuntime)"。
    // 可选服务应改用 apply(ctx) 内的 ctx.inject(['name'], cb)（见 index.js 的 webServer）。
    exports.inject = []

    function safe(fn) {
      try { return fn() } catch (e) {
        if (typeof console !== 'undefined' && console.debug) {
          try { console.debug('[dsh-plugin-stylotrace]', e && e.message || e) } catch (_) {}
        }
        return null
      }
    }

    function init() {
      // ============================== 样式 ==============================
      var STYLE_ID = 'dsh-plugin-stylotrace-style'
      if (document.getElementById(STYLE_ID) === null) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = [
          '.stylo-selbar { position: fixed; z-index: 1300; display: flex; align-items: center; gap: 2px;',
          '  padding: 4px 6px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-specific-menu, #2c2c2e); box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.3));',
          '  font: 12px var(--dsw-font-family, system-ui); color: var(--dsw-text-strong, #eee);',
          '  cursor: pointer; user-select: none; white-space: nowrap; }',
          '.stylo-selbar button { all: unset; cursor: pointer; padding: 3px 8px; border-radius: 6px; font: inherit; color: inherit; }',
          '.stylo-selbar button:hover { background: rgba(255,255,255,.12); }',
          '.stylo-selbar .sep { width: 1px; height: 14px; background: var(--dsw-alias-border-inverted, #555); margin: 0 2px; }',
          '.stylo-toast { position: fixed; z-index: 1400; left: 50%; bottom: 96px; transform: translateX(-50%);',
          '  padding: 8px 14px; border-radius: 10px; background: var(--dsw-specific-menu, #2c2c2e);',
          '  color: var(--dsw-text-strong, #eee); font: 13px var(--dsw-font-family, system-ui);',
          '  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.4)); opacity: 0;',
          '  transition: opacity .2s; pointer-events: none; }',
          '.stylo-anno-panel { position: fixed; z-index: 1350; right: 16px; top: 64px; width: 340px; max-height: 70vh;',
          '  display: flex; flex-direction: column; border-radius: 12px;',
          '  border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-specific-menu, #26262a); box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.4));',
          '  font: 13px var(--dsw-font-family, system-ui); color: var(--dsw-text-strong, #eee); }',
          '.stylo-anno-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;',
          '  border-bottom: 1px solid var(--dsw-alias-border-inverted, #444); font-weight: 600; }',
          '.stylo-anno-head button { all: unset; cursor: pointer; font-size: 15px; padding: 0 4px; }',
          '.stylo-anno-list { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }',
          '.stylo-anno-item { border: 1px solid var(--dsw-alias-border-inverted, #444); border-radius: 8px; padding: 8px 10px; background: rgba(255,255,255,.03); }',
          '.stylo-anno-quote { font-size: 12px; color: var(--dsw-text-weak, #aaa); font-style: italic;',
          '  border-left: 2px solid #7C3AED; padding-left: 6px; margin-bottom: 6px; overflow: hidden;',
          '  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; cursor: pointer; }',
          '.stylo-anno-note { white-space: pre-wrap; word-break: break-word; margin-bottom: 6px; }',
          '.stylo-anno-meta { display: flex; justify-content: space-between; align-items: center; }',
          '.stylo-anno-time { font-size: 11px; color: var(--dsw-text-weak, #888); }',
          '.stylo-anno-actions { display: flex; gap: 6px; }',
          '.stylo-anno-actions button { all: unset; cursor: pointer; font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-inverted, #555); }',
          '.stylo-anno-actions button:hover { background: rgba(255,255,255,.1); }',
          '.stylo-anno-empty { padding: 20px; text-align: center; color: var(--dsw-text-weak, #888); font-size: 12px; }',
          '.stylo-anno-fab { position: fixed; z-index: 1340; right: 16px; bottom: 24px; width: 44px; height: 44px;',
          '  border-radius: 50%; border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-specific-menu, #2c2c2e); color: var(--dsw-text-strong, #eee);',
          '  font: 15px var(--dsw-font-family, system-ui); cursor: pointer; box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.4)); }',
          '.stylo-anno-chip { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 1px 7px;',
          '  border-radius: 999px; font-size: 11px; cursor: pointer; border: 1px solid #7C3AED55; background: #7C3AED22; }',
          '.stylo-anno-input-wrap { position: fixed; z-index: 1360; width: 300px; border-radius: 10px;',
          '  border: 1px solid var(--dsw-alias-border-inverted, #555); background: var(--dsw-specific-menu, #2c2c2e);',
          '  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.4)); padding: 8px; }',
          '.stylo-anno-input-wrap textarea { width: 100%; min-height: 52px; resize: vertical; box-sizing: border-box;',
          '  border-radius: 6px; border: 1px solid var(--dsw-alias-border-inverted, #555); background: rgba(255,255,255,.06);',
          '  color: var(--dsw-text-strong, #eee); font: 12px var(--dsw-font-family, system-ui); padding: 6px; }',
          '.stylo-anno-input-wrap .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }',
          '.stylo-anno-input-wrap button { all: unset; cursor: pointer; font-size: 12px; padding: 3px 10px; border-radius: 6px;',
          '  border: 1px solid var(--dsw-alias-border-inverted, #555); }',
          '.stylo-anno-input-wrap button.primary { background: #7C3AED; border-color: #7C3AED; color: #fff; }',
          '.stylo-works { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }',
          '.stylo-works-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;',
          '  border-radius: 999px; border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-alias-bg-elevated, #333); color: var(--dsw-text-strong, #eee);',
          '  font: 12px var(--dsw-font-family, system-ui); cursor: pointer; }',
          '.stylo-works-chip:hover { filter: brightness(1.15); }',
          '.stylo-works-chip .open { color: #7C3AED; }',
          '.stylo-works-chip .prev { color: #22c55e; }',
          '.stylo-preview { position: fixed; z-index: 1330; left: 50%; top: 50%; transform: translate(-50%,-50%);',
          '  width: min(720px, 92vw); height: min(72vh, 640px); display: flex; flex-direction: column;',
          '  border-radius: 12px; border: 1px solid var(--dsw-alias-border-inverted, #555);',
          '  background: var(--dsw-specific-menu, #1f1f23); box-shadow: var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.5));',
          '  font: 13px var(--dsw-font-family, system-ui); color: var(--dsw-text-strong, #eee); overflow: hidden; }',
          '.stylo-preview-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px;',
          '  border-bottom: 1px solid var(--dsw-alias-border-inverted, #444); background: rgba(255,255,255,.04); }',
          '.stylo-preview-head .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
          '.stylo-preview-head .name small { color: var(--dsw-text-weak, #999); font-weight: 400; margin-left: 8px; }',
          '.stylo-preview-head button { all: unset; cursor: pointer; font-size: 15px; padding: 0 4px; }',
          '.stylo-preview-body { flex: 1; overflow: auto; padding: 12px 14px; }',
          '.stylo-preview-body pre { margin: 0; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
          '  white-space: pre-wrap; word-break: break-all; color: var(--dsw-text-strong, #eee); }',
          '.stylo-preview-binary { padding: 24px; text-align: center; color: var(--dsw-text-weak, #aaa); }',
          '.stylo-preview-binary button { all: unset; cursor: pointer; margin-top: 12px; padding: 6px 16px;',
          '  border-radius: 8px; background: #7C3AED; color: #fff; font-size: 13px; }',
          '.stylo-preview-loading { padding: 24px; text-align: center; color: var(--dsw-text-weak, #999); }',
          '.stylo-highlight { outline: 2px solid #7C3AED; outline-offset: 2px; border-radius: 4px; }',
        ].join('\n')
        document.head.appendChild(style)
      }

      // ============================== 工具 ==============================
      var BAR_ID = 'stylo-selbar'
      var bar = null
      var LAST_SELECTION = null

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

      function buildQuoteBlock(text) {
        var q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!q) return ''
        return '〔Stylotrace 引用〕《' + q + '》\n修改指令：按我的风格改进这一句（更像我写的）'
      }

      function findComposer() {
        var ae = document.activeElement
        if (ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return ae
        var ta = document.querySelector('textarea')
        if (ta) return ta
        var ce = document.querySelector('[contenteditable="true"]')
        return ce || null
      }

      function insertIntoComposer(composer, block) {
        if (!composer) return false
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

      // 「用系统默认应用打开」：当前 harness 未暴露 openPath 能力（workspaces
      // 服务没有 openPath 方法），故一律降级为复制路径，不再引用不存在的服务。
      function openPathWithFallback(p) {
        copyPath(p)
      }

      function copyPath(p) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(p).catch(function () {})
          toast('已复制路径: ' + p)
        } else {
          toast('路径: ' + p)
        }
      }

      // ============================== 文件内嵌预览(Codex 式) ==============================
      // 通过 Node 半区注册的 /stylotrace/file 路由读取文件内容，在 web 内渲染。
      var preview = null

      function closePreview() {
        if (preview) { preview.remove(); preview = null }
      }

      function openPreview(p, label) {
        closePreview()
        preview = document.createElement('div')
        preview.className = 'stylo-preview'
        preview.innerHTML =
          '<div class="stylo-preview-head"><span class="name"></span><button title="关闭">✕</button></div>' +
          '<div class="stylo-preview-loading">正在读取…</div>'
        var head = preview.querySelector('.stylo-preview-head')
        head.querySelector('.name').textContent = label || '文件预览'
        head.querySelector('button').addEventListener('click', closePreview)
        var body = preview.querySelector('.stylo-preview-loading')
        body.className = 'stylo-preview-body'
        body.innerHTML = '<div class="stylo-preview-loading">正在读取…</div>'
        document.body.appendChild(preview)

        safe(function () {
          var url = '/stylotrace/file?path=' + encodeURIComponent(String(p))
          fetch(url)
            .then(function (r) { return r.json() })
            .then(function (data) {
              if (!preview) return
              if (!data || !data.ok) {
                body.innerHTML = '<div class="stylo-preview-binary">读取失败：' + ((data && data.error) || '未知错误') +
                  '<br><button>用系统应用打开</button></div>'
                bindBinaryOpen(body, p, label)
                return
              }
              if (data.kind === 'text') {
                head.querySelector('.name').textContent = label || data.name
                var pre = document.createElement('pre')
                pre.textContent = data.content || '（空文件）'
                body.innerHTML = ''
                body.appendChild(pre)
              } else {
                body.innerHTML = '<div class="stylo-preview-binary">' + (data.hint || '二进制文件') +
                  '<br><button>用系统应用打开</button></div>'
                bindBinaryOpen(body, p, label)
              }
            })
            .catch(function (e) {
              if (!preview) return
              body.innerHTML = '<div class="stylo-preview-binary">预览服务不可用（' + (e && e.message || e) + '）' +
                '<br><button>用系统应用打开</button></div>'
              bindBinaryOpen(body, p, label)
            })
        })
      }

      function bindBinaryOpen(container, p, label) {
        var btn = container.querySelector('button')
        if (btn) btn.addEventListener('click', function () { openPathWithFallback(p, label || String(p).split('/').pop()) })
      }

      // ============================== 注释系统 ==============================
      var LS_KEY = 'dsh-plugin-stylotrace.annotations'
      var annotations = []

      function loadAnnotations() {
        annotations = safe(function () {
          var raw = localStorage.getItem(LS_KEY)
          var arr = raw ? JSON.parse(raw) : []
          return Array.isArray(arr) ? arr : []
        }) || []
      }
      function saveAnnotations() {
        safe(function () { localStorage.setItem(LS_KEY, JSON.stringify(annotations)) })
      }
      function uid() {
        return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
      }

      function addAnnotation(text, note) {
        var quote = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!quote) return
        annotations.unshift({
          id: uid(),
          quote: quote,
          note: String(note || '').trim(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        saveAnnotations()
        renderAnnotationPanel()
        attachChips()
        return annotations[0]
      }

      function updateAnnotation(id, note) {
        var a = annotations.find(function (x) { return x.id === id })
        if (!a) return
        a.note = String(note || '').trim()
        a.updatedAt = new Date().toISOString()
        saveAnnotations()
        renderAnnotationPanel()
      }

      function removeAnnotation(id) {
        annotations = annotations.filter(function (x) { return x.id !== id })
        saveAnnotations()
        renderAnnotationPanel()
        attachChips()
      }

      function fmtTime(iso) {
        var d = new Date(iso)
        var diff = new Date() - d
        if (diff < 60000) return '刚刚'
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
        return (d.getMonth() + 1) + '月' + d.getDate() + '日'
      }

      // 高亮定位：在文档中找含该注释原文的行，滚动到可见并描边
      function locateAnnotation(quote) {
        var needle = quote.slice(0, 20)
        var rows = document.querySelectorAll('[data-time-hover-root]')
        var found = null
        rows.forEach(function (r) {
          if (found) return
          var t = r.innerText || ''
          if (t.indexOf(needle) !== -1) found = r
        })
        if (found) {
          found.scrollIntoView({ block: 'center', behavior: 'smooth' })
          found.classList.add('stylo-highlight')
          setTimeout(function () { found.classList.remove('stylo-highlight') }, 2500)
        } else {
          toast('未在页面中找到该批注的原文（可能已在其他会话）')
        }
      }

      // ============================== 注释面板 ==============================
      var panel = null
      var fab = null

      function closePanel() {
        if (panel) { panel.remove(); panel = null }
        if (fab) { fab.remove(); fab = null }
      }

      function openPanel() {
        closePanel()
        fab = document.createElement('button')
        fab.className = 'stylo-anno-fab'
        fab.textContent = '💬'
        fab.title = 'Stylotrace 批注 (' + annotations.length + ')'
        fab.addEventListener('click', closePanel)
        document.body.appendChild(fab)
        renderAnnotationPanel()
      }

      function renderAnnotationPanel() {
        if (!panel) {
          panel = document.createElement('div')
          panel.className = 'stylo-anno-panel'
          document.body.appendChild(panel)
        }
        var head = document.createElement('div')
        head.className = 'stylo-anno-head'
        head.innerHTML = '<span>Stylotrace 批注（' + annotations.length + '）</span>'
        var closeBtn = document.createElement('button')
        closeBtn.textContent = '✕'
        closeBtn.title = '收起'
        closeBtn.addEventListener('click', closePanel)
        head.appendChild(closeBtn)
        var list = document.createElement('div')
        list.className = 'stylo-anno-list'
        if (!annotations.length) {
          var empty = document.createElement('div')
          empty.className = 'stylo-anno-empty'
          empty.textContent = '还没有批注。选中任意文字 → 点「批注」即可添加，可随时查看 / 编辑 / 删除。'
          list.appendChild(empty)
        } else {
          annotations.forEach(function (a) { list.appendChild(renderAnnotationItem(a)) })
        }
        panel.innerHTML = ''
        panel.appendChild(head)
        panel.appendChild(list)
      }

      function renderAnnotationItem(a) {
        var item = document.createElement('div')
        item.className = 'stylo-anno-item'
        item.setAttribute('data-anno-id', a.id)

        var quote = document.createElement('div')
        quote.className = 'stylo-anno-quote'
        quote.textContent = '「' + a.quote + '」'
        quote.title = '点击定位到原文'
        quote.addEventListener('click', function () { locateAnnotation(a.quote) })

        var note = document.createElement('div')
        note.className = 'stylo-anno-note'
        note.textContent = a.note || '（无批注内容）'

        var meta = document.createElement('div')
        meta.className = 'stylo-anno-meta'
        var time = document.createElement('span')
        time.className = 'stylo-anno-time'
        time.textContent = fmtTime(a.updatedAt)
        var actions = document.createElement('span')
        actions.className = 'stylo-anno-actions'
        var editBtn = document.createElement('button')
        editBtn.textContent = '编辑'
        editBtn.addEventListener('click', function () { startEdit(a.id) })
        var delBtn = document.createElement('button')
        delBtn.textContent = '删除'
        delBtn.addEventListener('click', function () {
          if (window.confirm('删除这条批注？')) removeAnnotation(a.id)
        })
        actions.appendChild(editBtn)
        actions.appendChild(delBtn)
        meta.appendChild(time)
        meta.appendChild(actions)

        item.appendChild(quote)
        item.appendChild(note)
        item.appendChild(meta)
        return item
      }

      // 编辑：把该项的 note 换成 textarea
      function startEdit(id) {
        var item = panel && panel.querySelector('[data-anno-id="' + id + '"]')
        var a = annotations.find(function (x) { return x.id === id })
        if (!item || !a) return
        var noteEl = item.querySelector('.stylo-anno-note')
        var ta = document.createElement('textarea')
        ta.value = a.note || ''
        var row = document.createElement('div')
        row.className = 'row'
        var saveBtn = document.createElement('button')
        saveBtn.className = 'primary'
        saveBtn.textContent = '保存'
        saveBtn.addEventListener('click', function () { updateAnnotation(id, ta.value) })
        var cancelBtn = document.createElement('button')
        cancelBtn.textContent = '取消'
        cancelBtn.addEventListener('click', function () { renderAnnotationPanel() })
        row.appendChild(cancelBtn)
        row.appendChild(saveBtn)
        noteEl.replaceWith(ta)
        ta.after(row)
        ta.focus()
      }

      // 批注输入弹出层（在工具条位置）
      var inputWrap = null
      function openAnnotationInput(text, x, y) {
        closeInput()
        inputWrap = document.createElement('div')
        inputWrap.className = 'stylo-anno-input-wrap'
        inputWrap.style.left = Math.max(8, Math.min(x, window.innerWidth - 320)) + 'px'
        inputWrap.style.top = Math.max(8, y) + 'px'
        var ta = document.createElement('textarea')
        ta.placeholder = '写下你对这段文字的批注…（可留空仅标记）'
        var row = document.createElement('div')
        row.className = 'row'
        var saveBtn = document.createElement('button')
        saveBtn.className = 'primary'
        saveBtn.textContent = '保存批注'
        saveBtn.addEventListener('click', function () {
          addAnnotation(text, ta.value)
          closeInput()
          removeBar()
          toast('批注已保存')
        })
        var cancelBtn = document.createElement('button')
        cancelBtn.textContent = '取消'
        cancelBtn.addEventListener('click', closeInput)
        row.appendChild(cancelBtn)
        row.appendChild(saveBtn)
        inputWrap.appendChild(ta)
        inputWrap.appendChild(row)
        document.body.appendChild(inputWrap)
        ta.focus()
      }
      function closeInput() {
        if (inputWrap) { inputWrap.remove(); inputWrap = null }
      }

      // ============================== 选区工具条 ==============================
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
            LAST_SELECTION = sel
            if (!bar) {
              bar = document.createElement('div')
              bar.id = BAR_ID
              bar.className = 'stylo-selbar'
              var improveBtn = document.createElement('button')
              improveBtn.textContent = '✨ 改进'
              improveBtn.title = '生成 Stylotrace 引用块，按你的风格改进这一句'
              improveBtn.addEventListener('mousedown', function (e) {
                e.preventDefault(); e.stopPropagation()
                safe(function () {
                  var chosen = LAST_SELECTION ? LAST_SELECTION.toString() : text
                  var block = buildQuoteBlock(chosen)
                  if (!block) return
                  var composer = findComposer()
                  if (composer && insertIntoComposer(composer, block)) {
                    toast('已插入「Stylotrace 引用」，按 Enter 发送即可')
                  } else {
                    copyQuote(block)
                  }
                })
                removeBar()
              })
              var sep = document.createElement('span')
              sep.className = 'sep'
              var annoBtn = document.createElement('button')
              annoBtn.textContent = '💬 批注'
              annoBtn.title = '给这段文字加批注（可查看/编辑/删除）'
              annoBtn.addEventListener('mousedown', function (e) {
                e.preventDefault(); e.stopPropagation()
                var chosen = LAST_SELECTION ? LAST_SELECTION.toString() : text
                openAnnotationInput(chosen, rect.left, rect.top - 8)
              })
              bar.appendChild(improveBtn)
              bar.appendChild(sep)
              bar.appendChild(annoBtn)
              document.body.appendChild(bar)
            }
            bar.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 190)) + 'px'
            bar.style.top = Math.max(4, rect.top - 34) + 'px'
          })
        }, 0)
      }

      function copyQuote(block) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(block).catch(function () {})
          toast('已复制 Stylotrace 引用块，粘贴到输入框发送')
        }
      }

      document.addEventListener('mouseup', onSelectionChange)
      document.addEventListener('keyup', function (e) {
        if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') onSelectionChange()
      })
      document.addEventListener('mousedown', function (e) {
        if (bar && !bar.contains(e.target)) removeBar()
        if (inputWrap && !inputWrap.contains(e.target)) closeInput()
      })
      window.addEventListener('scroll', function () { removeBar() }, true)

      // ============================== 消息行注释角标 ==============================
      var chipSeen = new WeakSet()
      function attachChips() {
        safe(function () {
          if (!annotations.length) return
          var rows = document.querySelectorAll('[data-time-hover-root]')
          rows.forEach(function (row) {
            if (chipSeen.has(row)) return
            var text = row.innerText || ''
            var matched = annotations.filter(function (a) {
              return text.indexOf(a.quote.slice(0, 20)) !== -1
            })
            if (!matched.length) return
            chipSeen.add(row)
            var chip = document.createElement('span')
            chip.className = 'stylo-anno-chip'
            chip.textContent = '💬 ' + matched.length
            chip.title = matched.map(function (a) { return a.note || a.quote.slice(0, 30) }).join(' | ')
            chip.addEventListener('click', function (e) {
              e.stopPropagation()
              openPanel()
              if (matched[0]) locateAnnotation(matched[0].quote)
            })
            var target = row.querySelector('.author') || row
            target.appendChild(chip)
          })
        })
      }

      // ============================== 作品识别与打开 ==============================
      var WORKS_RE = /(?:synthesized\/|draft\.|out\/)[\w\u4e00-\u9fa5./-]+\.(?:md|docx|html|pdf|srt)/g
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
          chip.title = p + '（点击复制路径；·预览 在 web 内查看；·打开 用系统应用打开）'
          chip.addEventListener('click', function () { copyPath(p) })
          var prevBtn = document.createElement('span')
          prevBtn.className = 'prev'
          prevBtn.textContent = '·预览'
          prevBtn.addEventListener('click', function (e) {
            e.stopPropagation()
            openPreview(p, String(p).split('/').pop())
          })
          var openBtn = document.createElement('span')
          openBtn.className = 'open'
          openBtn.textContent = '·打开'
          openBtn.addEventListener('click', function (e) {
            e.stopPropagation()
            openPathWithFallback(p, String(p).split('/').pop())
          })
          chip.appendChild(prevBtn)
          chip.appendChild(openBtn)
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

      // MutationObserver + 防抖
      var scanTimer = null
      function scheduleScan() {
        if (scanTimer) return
        scanTimer = setTimeout(function () {
          scanTimer = null
          scanMessages()
          attachChips()
        }, 400)
      }
      safe(function () {
        var mo = new MutationObserver(function () { scheduleScan() })
        mo.observe(document.body, { childList: true, subtree: true })
      })
      window.setInterval(function () { safe(function () { scanMessages(); attachChips() }) }, 3000)

      // 初始化
      loadAnnotations()
      safe(scanMessages)
      safe(attachChips)
    }

    // cordis 插件契约：浏览器 bundle 必须导出 apply（否则 loader 收到空对象报
    // "invalid plugin ... received object"）。纯 DOM 功能，无需 cordis 服务注入。
    // apply 由宿主在注入服务后调用，内部 safe 包裹的 init 执行全部 DOM 挂载。
    exports.apply = function apply(ctx) {
      safe(init)
    }

    module.exports = exports
    return module.exports
  },
})
