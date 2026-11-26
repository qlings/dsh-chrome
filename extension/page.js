/**
 * page.js —— 页面内执行函数的**唯一来源**。
 *
 * 以前 content.js 和 executor.js 各抄一份，改一处忘另一处就会出现
 * 「eval 刷新前能用、刷新后不能用」这种怪事。现在只在这里写，两边取。
 *
 * 铁律：每个 inPageXxx 必须**完全自包含**。chrome.scripting.executeScript
 * 会把函数源码序列化丢进页面，引用函数外的任何变量都会在页面里
 * ReferenceError。所以 norm/clip/cssPath 这类小工具只能在函数体内重复定义。
 *
 * 本文件是普通脚本（不是 module）：content script 用 <script> 列表加载，
 * executor.js 用 import './page.js' 做副作用导入，两边都从 globalThis.__dshPage 取。
 */
;(function () {
  'use strict'

  // 页面世界拿不到 chrome.runtime，版本只能手写；升级时与 manifest.json 的 version 同步。
  const PAGE_VERSION = '1.18.0'

  /* ------------------------------ 帧作用域 ------------------------------
   * 同源 iframe 在门户类页面里是常态（壳页 + 业务 iframe）：以前 read/click/
   * check 只看顶层 document，正文 141 字、行怎么都找不到。这里把同源子帧的
   * document 一起纳入查询范围——一次调用就能跨进 iframe，不用先猜 frameId。
   *
   * 注意：这个对象挂在 globalThis 上，供 page.js 里的函数在 ISOLATED 世界
   * 直接引用（content script 与 executeScript ISOLATED 共享同一个世界）。
   * 每个函数仍保留「没有 __dshScope 就退回当前 document」的兜底。
   */
  const SCOPE = {
    docs(maxDepth) {
      const limit = Number(maxDepth || 3)
      const out = [{ doc: document, frame: null, depth: 0 }]
      const walk = (d, depth) => {
        if (depth >= limit) return
        let list = []
        try { list = Array.from(d.querySelectorAll('iframe,frame')) } catch { return }
        for (const f of list) {
          let cd = null
          try { cd = f.contentDocument } catch { cd = null }   // 跨域会抛，跳过
          if (!cd || !cd.body) continue
          out.push({ doc: cd, frame: f, depth: depth + 1 })
          walk(cd, depth + 1)
        }
      }
      walk(document, 0)
      return out
    },
    /** 每个同源帧的概况：地址、可见尺寸、正文长度。用于 read 自动下沉和提示。 */
    frames() {
      const rows = []
      for (const item of SCOPE.docs()) {
        if (!item.frame) continue
        let rect = { width: 0, height: 0 }
        try { rect = item.frame.getBoundingClientRect() } catch { /* 拿不到就按不可见 */ }
        let visible = rect.width > 0 && rect.height > 0
        try {
          const style = getComputedStyle(item.frame)
          if (style.display === 'none' || style.visibility === 'hidden') visible = false
        } catch { /* 拿不到样式就不改判 */ }
        rows.push({
          id: item.frame.id || '',
          name: item.frame.name || '',
          src: String(item.frame.src || ''),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible,
          textLength: String((item.doc.body && item.doc.body.innerText) || '').length,
          title: String(item.doc.title || '').slice(0, 80),
        })
      }
      return rows
    },
  }
  globalThis.__dshScope = SCOPE


  /* ------------------------------ 读页面 ------------------------------ */

  function inPageRead(args) {
    const opts = args || {}
    // maxChars=0 表示不限（要看完整正文/完整输入值时用）
    const rawMax = Number(opts.maxChars)
    const maxChars = rawMax === 0 ? 2000000 : Math.max(500, Math.min(2000000, rawMax || 20000))
    // offset：长页分页读。一次只回一个窗口 + nextOffset，长文档不用整篇灌进上下文。
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    // selector 也跨同源帧找；不带 selector 时，如果顶层正文少得可疑（壳页），
    // 自动下沉到「可见且正文最长」的同源 iframe——门户页不用再手写 eval。
    let picked = null
    if (opts.selector) {
      for (const item of docs) {
        let el = null
        try { el = item.doc.querySelector(opts.selector) } catch { el = null }
        if (el) { picked = { el, doc: item.doc, frame: item.frame }; break }
      }
    } else if (docs.length > 1) {
      const topText = String((document.body && document.body.innerText) || '')
      if (topText.length < 300) {
        let best = null
        for (const item of docs.slice(1)) {
          if (!item.frame) continue
          let rect = { width: 0, height: 0 }
          try { rect = item.frame.getBoundingClientRect() } catch { rect = { width: 0, height: 0 } }
          if (!(rect.width > 0 && rect.height > 0)) continue
          const len = String((item.doc.body && item.doc.body.innerText) || '').length
          if (!best || len > best.len) best = { item, len }
        }
        if (best && best.len > topText.length) picked = { el: best.item.doc.body, doc: best.item.doc, frame: best.item.frame }
      }
    }
    const doc = picked ? picked.doc : document
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null)
    // 自测环境里 window 是个没有 location 的假对象；真实页面里两者都有。
    const winLoc = (win && win.location) || (typeof location !== 'undefined' ? location : { href: '', host: '' })
    const root = picked ? picked.el : (document.body || document.documentElement)
    const out = {
      ok: true,
      pageVersion: PAGE_VERSION,
      url: winLoc.href,
      title: doc.title,
      readyState: doc.readyState,
      lang: doc.documentElement.getAttribute('lang') || '',
      meta: {
        description: (doc.querySelector('meta[name="description"]') || {}).content || '',
        canonical: (doc.querySelector('link[rel="canonical"]') || {}).href || '',
        ogTitle: (doc.querySelector('meta[property="og:title"]') || {}).content || '',
      },
      selection: String(win && win.getSelection ? win.getSelection() : '').slice(0, 2000),
      scroll: { x: Number(win && win.scrollX) || 0, y: Number(win && win.scrollY) || 0, height: doc.documentElement.scrollHeight, viewport: Number(win && win.innerHeight) || 0 },
    }
    if (picked && picked.frame) {
      out.frame = {
        auto: !opts.selector,
        src: String(picked.frame.src || ''),
        id: picked.frame.id || '',
        title: doc.title,
      }
    }
    if (!root) return { ok: false, errorCode: 'NOT_FOUND', error: '页面里没有可读的正文节点（可能还在加载）', url: out.url, title: out.title }

    // 选择器只给「能直接拿去用」的：有 id 就给 id，没有就短路径 + 到 3 层就停。
    // 老版本给 6 层 nth-of-type 全路径，单行 150+ 字符，纯烧 token 且改版就失效。
    const cssPath = (el, maxLen = 60) => {
      if (el.id) return '#' + CSS.escape(el.id)
      const bits = []
      let node = el
      let depth = 0
      while (node && node.nodeType === 1 && depth < 3) {
        let part = node.tagName.toLowerCase()
        if (node.classList && node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.')
        bits.unshift(part)
        node = node.parentElement
        depth++
      }
      const out = bits.join(' ')
      return out.length > maxLen ? out.slice(0, maxLen - 1) + '…' : out
    }
    // href 只留「路径 + 参数名」：URL 编码的中文 query 值对模型没信息量
    const shortHref = (raw, maxLen = 60) => {
      let href = String(raw == null ? '' : raw)
      try {
        const u = new URL(href, winLoc.href)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '#'   // javascript: / mailto: 之类一律当 #
        href = u.host === winLoc.host ? (u.pathname || '/') : (u.origin + u.pathname)
        const names = Array.from(u.searchParams.keys()).slice(0, 2)
        if (names.length) href += '?' + names.join('&')
      } catch { /* 不是合法 URL 就原样 */ }
      return href.length > maxLen ? href.slice(0, maxLen - 1) + '…' : href
    }
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…（共 ' + s.length + ' 字）' : s }
    // sections：默认只给正文 + 输入框（省 token）；'all' 才带链接/按钮/表单
    const wantAll = String(opts.sections || '').toLowerCase() === 'all'
    let text = String(root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
    // tables:"rows"：把表格按「一行一条记录」展开后再算正文。
    // 默认的 innerText 会把每个单元格各占一行，17 行的台账表能膨胀成一屏半（2026-11-24 读接口台账时踩到）。
    const tableMode = ['rows', 'compact', '1', 'true'].includes(String(opts.tables == null ? '' : opts.tables).toLowerCase())
    const tables = []
    if (tableMode) {
      try {
        const maxTables = Math.max(1, Math.min(20, Number(opts.tableLimit) || 8))
        const maxRows = Math.max(1, Math.min(200, Number(opts.tableRows) || 40))
        const tableEls = Array.from(root.querySelectorAll('table')).slice(0, maxTables)
        const clone = tableEls.length && typeof root.cloneNode === 'function' ? root.cloneNode(true) : null
        const cloneTables = clone ? Array.from(clone.querySelectorAll('table')).slice(0, maxTables) : []
        const cellText = (c) => String(c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
        tableEls.forEach((tb, i) => {
          const srcRows = Array.from(tb.rows || [])
          if (!srcRows.length) return
          const hasTh = Array.from(srcRows[0].cells || []).some((c) => String(c.tagName).toLowerCase() === 'th')
          const headerRow = hasTh ? srcRows[0] : null
          const bodyRows = (hasTh ? srcRows.slice(1) : srcRows).slice(0, maxRows)
          const headers = headerRow ? Array.from(headerRow.cells).map(cellText) : []
          const cols = Math.max(headers.length, ...bodyRows.map((r) => (r.cells || []).length), 0)
          // 空表格（纯布局用的 table）直接跳过，别在正文里留一行「0 行 × 0 列」
          if (!bodyRows.length && !headers.length) return
          const rowsData = bodyRows.map((r) => Array.from(r.cells || []).map(cellText))
          const totalBody = srcRows.length - (hasTh ? 1 : 0)
          tables.push({ index: i + 1, rows: bodyRows.length, totalRows: totalBody, cols, headers, truncated: totalBody > bodyRows.length })
          const ct = cloneTables[i]
          if (ct && ct.parentNode) {
            const doc = clone.ownerDocument || document
            const div = doc.createElement('div')
            // Element Plus / Ant Design 的表头是**独立的 <table>**：它 0 行但有表头，
            // 标成「表头」而不是「0 行」，跟紧挨着的数据表连起来读就是一张表。
            const label = bodyRows.length
              ? '[表格 ' + (i + 1) + '：' + bodyRows.length + ' 行 × ' + cols + ' 列' + (tables[tables.length - 1].truncated ? '（只列前 ' + maxRows + ' 行）' : '') + ']'
              : '[表格 ' + (i + 1) + '：表头 ' + cols + ' 列]'
            const lines = [label]
            if (headers.length) lines.push(headers.join(' | '))
            for (const row of rowsData) lines.push(row.join(' | '))
            // 必须显式 pre-wrap：textContent 里的 \n 在普通元素里会被折成空格，
            // innerText 读回来就成一整行了（实测第一版就是这样，17 行挤成一行）。
            try { div.style.whiteSpace = 'pre-wrap' } catch { /* 假 DOM */ }
            div.textContent = '\n' + lines.join('\n') + '\n'
            ct.parentNode.replaceChild(div, ct)
          }
        })
        if (clone) {
          // 关键：innerText 只有「在文档里」才算得对。离屏克隆的 innerText 等于 textContent，
          // 换行全没了（实测：甲乙12 vs 甲\n\n乙\n\n1\t2）。所以挂到一个离屏容器里读，
          // 读完立刻摘掉——不碰用户能看到的任何东西。
          const doc = root.ownerDocument || document
          const host = doc.createElement('div')
          host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1280px;pointer-events:none;'
          let mounted = false
          try {
            host.appendChild(clone)
            ;(doc.body || doc.documentElement).appendChild(host)
            mounted = true
            text = String(host.innerText || clone.innerText || clone.textContent || '')
          } finally {
            if (mounted) {
              try { host.parentNode.removeChild(host) } catch { /* 页面自己动了 DOM 就算了 */ }
            }
          }
          text = text.replace(/\n{3,}/g, '\n\n').trim()
        }
      } catch { /* 表格结构怪就退回普通正文 */ }
    }
    out.textLength = text.length
    if (tables.length) out.tables = tables
    // 起点如果正好落在代理对中间（低代理），把它连同前半一起留在上一页，
    // 别让本页开头吐出半个 emoji。
    let start = offset
    if (start > 0 && start < text.length) {
      const first = text.charCodeAt(start)
      if (first >= 0xDC00 && first <= 0xDFFF) start -= 1
    }
    out.offset = start
    // 切点别落在代理对中间：切一半 emoji 会让整条结果的 JSON 解析坏掉
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length && end > 0) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xD800 && code <= 0xDBFF) end -= 1
    }
    out.text = start >= text.length ? '' : text.slice(start, end)
    out.truncated = end < text.length
    out.hasMore = out.truncated
    out.nextOffset = out.truncated ? end : null

    // 同源 iframe 概况：没下沉时也告诉调用方「正文可能在哪个 frame 里」，
    // 省掉「read 只回菜单 → 再猜 → 再 eval」的一整轮。
    if (S) {
      const frames = S.frames()
      if (frames.length) {
        out.frames = frames
        if (!picked && text.length < 300) {
          out.framesHint = '顶层正文只有 ' + text.length + ' 字，同源 iframe 有 ' + frames.length + ' 个：' +
            frames.map((f) => (f.title || f.src || '?') + '（' + f.textLength + ' 字' + (f.visible ? '' : '，不可见') + '）').join('；') +
            '。去掉 selector 直接 read 会自动下沉到正文最长的可见 iframe；要指定别的帧，先 action=frames 查 frameId 再传 frame。'
        }
      }
    }

    out.links = Array.from(root.querySelectorAll('a[href]')).slice(0, 400).map((a) => ({
      text: clip(a.innerText || a.getAttribute('aria-label') || a.title, 120),
      href: shortHref(a.getAttribute('href')),
      target: a.target || '',
      selector: cssPath(a),
    }))

    // inputs：none 不列；summary 只列有值/有名字的少量；all 全列（老行为）
    const inputMode = String(opts.inputs || (opts.includeHtml ? 'all' : 'summary')).toLowerCase()
    const allFields = Array.from(root.querySelectorAll('input,textarea,select'))
    out.inputsTotal = allFields.length
    if (inputMode !== 'none') {
      const list = inputMode === 'all'
        ? allFields.slice(0, 200)
        : allFields.filter((el) => {
          // summary 模式只列「有信息量」的：一堆 value=on 的复选框除了烧 token 没别的用
          const t = String(el.type || '').toLowerCase()
          if (t === 'checkbox' || t === 'radio') return el.checked === true
          return String(el.value || '').trim() || el.name || el.id || el.placeholder
        }).slice(0, 40)
      out.inputs = list.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        valueLength: String(el.value == null ? '' : el.value).length,
        value: el.type === 'password' ? '***' : clip(el.value, inputMode === 'all' ? 4000 : 300),
        checked: el.checked === true,
        disabled: el.disabled === true,
        required: el.required === true,
        selector: cssPath(el),
      }))
    }
    out.buttons = wantAll ? Array.from(root.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a[role="button"]')).slice(0, 150).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: clip(el.innerText || el.value || el.getAttribute('aria-label'), 100),
      type: el.type || '',
      disabled: el.disabled === true,
      selector: cssPath(el),
    })) : []
    out.forms = wantAll ? Array.from(root.querySelectorAll('form')).slice(0, 30).map((f) => ({
      action: shortHref(f.action),
      method: (f.method || 'get').toLowerCase(),
      id: f.id || '',
      selector: cssPath(f),
      fields: f.querySelectorAll('input,textarea,select').length,
    })) : []
    // 默认不列链接（正文里已经能看到文字）；要 URL 再 sections:'all'
    if (!wantAll) out.links = []
    out.headings = Array.from(root.querySelectorAll('h1,h2,h3')).slice(0, 60).map((h) => ({ tag: h.tagName.toLowerCase(), text: clip(h.innerText, 120) }))
    if (opts.includeHtml) out.html = String(root.outerHTML || '').slice(0, maxChars * 2)
    return out
  }

  /* ------------------------------ 找元素 ------------------------------ */

  function inPageQuery(args) {
    const opts = args || {}
    const selector = opts.selector || '*'
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50))
    const cssPath = (el) => {
      if (el.id) return '#' + CSS.escape(el.id)
      const bits = []
      let node = el
      let depth = 0
      while (node && node.nodeType === 1 && depth < 6) {
        let part = node.tagName.toLowerCase()
        if (node.classList && node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.')
        bits.unshift(part)
        node = node.parentElement
        depth++
      }
      return bits.join(' > ')
    }
    let nodes
    let hits = []
    try {
      const S = globalThis.__dshScope
      const docs = S ? S.docs() : [{ doc: document, frame: null }]
      for (const item of docs) {
        for (const el of Array.from(item.doc.querySelectorAll(selector))) hits.push({ el, frame: item.frame })
      }
      nodes = hits.map((h) => h.el)
    } catch (e) { return { ok: false, errorCode: 'BAD_SELECTOR', error: '选择器不合法: ' + e.message } }
    const frameOf = new Map(hits.map((h) => [h.el, h.frame]))
    const rows = nodes.slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect()
      const text = String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      // 推荐定位方式：id 是动态生成的（如 Element Plus 的 el-id-1723-535）时别用 selector，
      // 文本 + 最近的可读祖先更稳。这里的 textHint 直接可以拿去填 click 的 text/label。
      const ancestorText = String((el.parentElement && el.parentElement.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      return {
        tag: el.tagName.toLowerCase(),
        text,
        id: el.id || '',
        name: el.name || '',
        visible: rect.width > 0 && rect.height > 0,
        selector: cssPath(el),
        textHint: text || ancestorText,
        frame: (() => { const f = frameOf.get(el); return f ? String(f.id || f.src || 'iframe').slice(0, 120) : '' })(),
        stable: el.id && !/^(el-id-|:r[0-9a-z]+:)/i.test(el.id) ? 'id' : (text ? 'text' : 'selector'),
      }
    })
    return { ok: true, count: nodes.length, shown: rows.length, rows, url: location.href, title: document.title }
  }

  /* ------------------------------ 点击 ------------------------------ */

  function inPageClick(args) {
    const opts = args || {}
    // 同源 iframe 也纳入查找范围：门户页的业务表格全在 iframe 里，跨帧点击是常态。
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => {
      const acc = []
      for (const item of docs) {
        try { for (const el of item.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 选择器不合法就跳过这个帧 */ }
      }
      return acc
    }
    const qs = (sel) => qsa(sel)[0] || null
    const frameOfEl = (el) => {
      for (const item of docs) if (item.doc === el.ownerDocument) return item.frame
      return null
    }
    const found = locate(opts)
    if (!found.el) return { ok: false, ...found }
    const el = found.el
    const frameEl = frameOfEl(el)
    const info = {
      tag: el.tagName.toLowerCase(),
      text: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      id: el.id || '',
      href: el.href || '',
      how: found.how,
      frame: frameEl ? String(frameEl.id || frameEl.src || 'iframe').slice(0, 120) : '',
    }
    if (opts.dryRun) return { ok: true, dryRun: true, wouldClick: info, how: found.how, url: location.href, disabled: isDisabled(el) }

    // 1.16.0：disabled 元素点下去是**无声失败**（不派发事件、页面没变化），
    // 以前回执照样写「已点击」，只能靠人肉对比页面变化才发现点不动。
    if (isDisabled(el) && opts.force !== true) {
      return {
        ok: false,
        errorCode: 'ELEMENT_DISABLED',
        error: '「' + (info.text || info.tag) + '」当前是禁用状态（disabled / aria-disabled），点击不会触发任何行为。'
          + '先满足它的前置条件（例如先在表格里选中一行、勾选一条），或用 action=vue + call 直接调组件方法；'
          + '确认要硬点再加 force:true。',
        clicked: info,
        disabled: true,
      }
    }

    const attemptsMax = Math.max(1, Math.min(5, Number(opts.retry) || 1) + 1)
    let attempts = 0
    let verified = null
    for (let i = 0; i < attemptsMax; i++) {
      const before = snapshotOf(el)
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.focus({ preventScroll: true })
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      el.click()
      attempts++
      if (!opts.expect) break
      const ok = waitForExpect(el, opts.expect, 600 + i * 300)
      if (ok) { verified = true; break }
      verified = false
      // 点击丢了的常见原因：动画期间行高变化、元素被重排。等一下再试。
      busyWait(200)
    }
    const out = { ok: true, clicked: info, how: found.how, attempts, url: location.href }
    if (found.autoVisible) out.autoVisible = true   // 多匹配但只有一个可见：告诉调用方这是自动选的
    if (found.matched != null) out.matched = found.matched   // selector 命中几个，让人能判断有没有歧义
    if (verified === false) {
      out.ok = false
      out.errorCode = 'CLICK_NOT_APPLIED'
      out.error = '点了 ' + attempts + ' 次，expect 条件仍未满足（页面可能在动画中，或用 click 点有状态元素——此时请改用 check）'
    } else if (verified === true) {
      out.verified = true
    }
    return out

    /* --- 自包含工具 --- */
    function busyWait(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* 页面侧同步等待，最多几百毫秒 */ } }

    // 元素或其祖先是否处于禁用态：Element 的按钮有时只是 div 包着 is-disabled，
    // 真正带 disabled 的是祖先 <button>，所以要 closest 一层。
    function isDisabled(node) {
      if (!node || typeof node.getAttribute !== 'function') return false
      if (node.disabled === true) return true
      if (node.getAttribute('aria-disabled') === 'true') return true
      const host = typeof node.closest === 'function' ? node.closest('[disabled],[aria-disabled="true"]') : null
      return !!(host && host !== node)
    }

    function snapshotOf(node) {
      return {
        text: String(node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        value: String(node.value == null ? '' : node.value).slice(0, 200),
        checked: node.checked === true,
        cls: node.className && typeof node.className === 'string' ? node.className.slice(0, 200) : '',
      }
    }

    function currentOf(node) {
      return {
        text: String(node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        value: String(node.value == null ? '' : node.value).slice(0, 200),
        checked: node.checked === true,
        cls: node.className && typeof node.className === 'string' ? node.className.slice(0, 200) : '',
        href: node.href || '',
      }
    }

    // expect: {changed:true} 或 {selector, attr?, value?, text?}
    function waitForExpect(node, expect, budgetMs) {
      const start = Date.now()
      const first = snapshotOf(node)
      while (Date.now() - start < budgetMs) {
        if (expect.changed) {
          const now = currentOf(node)
          if (now.text !== first.text || now.value !== first.value || now.checked !== first.checked || now.cls !== first.cls) return true
        }
        if (expect.selector) {
          const found = document.querySelector(expect.selector)
          if (found) {
            if (expect.attr && expect.value !== undefined) {
              if (String(found.getAttribute(expect.attr)) === String(expect.value)) return true
            } else if (expect.text !== undefined) {
              if (String(found.innerText || '').includes(String(expect.text))) return true
            } else {
              return true
            }
          }
        }
        if (expect.value !== undefined && !expect.selector && !expect.attr) {
          if (String(node.value) === String(expect.value)) return true
        }
        busyWait(50)
      }
      return false
    }

    function locate(o) {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      const lower = (s) => norm(s).toLowerCase()
      const idx = Math.max(0, Number(o.index) || 0)
      // 元素是不是真的可见：用来区分「teleport 到 body 的旧浮层」和「当前展开的那个」。
      // 判据取最保守的一组：display/visibility + 有非零尺寸的盒子。
      const isVisibleEl = (el) => {
        try {
          if (!el) return false
          if (el.isConnected === false) return false
          const doc = el.ownerDocument || document
          const view = doc.defaultView
          const style = view && view.getComputedStyle ? view.getComputedStyle(el) : null
          if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
          const rects = el.getClientRects ? el.getClientRects() : null
          if (rects && rects.length) {
            for (const r of rects) if (r.width > 0 && r.height > 0) return true
            return false
          }
          return Boolean(el.offsetWidth || el.offsetHeight)
        } catch { return false }
      }

      // ref 定位：outline 给元素打过 data-dsh-ref，页面没翻页前一直有效
      if (o.ref) {
        const hit = qs('[data-dsh-ref="' + String(o.ref).replace(/["\\\s]/g, '') + '"]')
        if (hit) return { el: hit, how: 'ref' }
        return { el: null, errorCode: 'REF_STALE', error: 'ref ' + o.ref + ' 找不到（页面变了，或又跑过一次 outline）。重新 action=outline 拿新 ref，或改用 selector/text/rowText。' }
      }

      // 行文本定位：先按容器文本找到行，再取行内的 target
      if (o.rowText) {
        const rowHit = findRow(o)
        if (rowHit.error) return rowHit
        const row = rowHit.el
        if (o.target) {
          const inner = row.querySelector(o.target)
          if (!inner) return { el: null, errorCode: 'NOT_FOUND', error: '在行「' + norm(row.innerText).slice(0, 60) + '」里没找到 ' + o.target }
          return { el: inner, how: 'rowText+target', row: norm(row.innerText).slice(0, 120) }
        }
        return { el: row, how: 'rowText', row: norm(row.innerText).slice(0, 120) }
      }

      if (o.selector) {
        const nodes = qsa(o.selector)
        if (!nodes.length) return { el: null, errorCode: 'NOT_FOUND', error: '没找到元素: ' + o.selector + frameTip() }
        // 写操作（点击/勾选）命中多个时不敢替人挑：以前静默取第 0 个，点错元素不留痕迹
        if (nodes.length > 1 && o.index == null) {
          // 例外：Element Plus / Ant Design 这类组件会把下拉浮层 teleport 到 body，
          // 页面上同时躺着好几个同 class 的浮层（只有一个是展开的），按选择器就是
          // MULTI_MATCH。只有「恰好一个可见」时才自动选中它——两个都可见仍然报错，
          // 绝不替人猜（2026-11-21 加）。
          const visible = nodes.filter((n) => isVisibleEl(n))
          if (visible.length === 1) {
            return { el: visible[0], how: 'selector+visible', matched: nodes.length, autoVisible: true }
          }
          const cands = nodes.slice(0, 6).map((n, k) => k + '. ' + String(n.innerText || n.value || n.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 40) + (isVisibleEl(n) ? '' : '（不可见）'))
          return {
            el: null,
            errorCode: 'MULTI_MATCH',
            error: '选择器「' + o.selector + '」命中 ' + nodes.length + ' 个元素' +
              (visible.length > 1 ? '（其中 ' + visible.length + ' 个都可见）' : '') +
              '，不敢乱点。候选：' + cands.join(' / ') + '。把选择器写细，或加 index 指定第几个。',
            candidates: cands,
            matched: nodes.length,
            visible: visible.length,
          }
        }
        return { el: nodes[idx], how: 'selector', matched: nodes.length }
      }
      if (o.name) {
        const needle = lower(o.name)
        const hit = qsa('[name]').find((el) => lower(el.getAttribute('name')) === needle)
        if (hit) return { el: hit, how: 'name' }
      }
      if (o.label) {
        const needle = lower(o.label)
        const labelled = qsa('label').find((l) => lower(l.innerText).includes(needle))
        if (labelled) {
          const control = labelled.control || labelled.querySelector('input,textarea,select,button') || (labelled.htmlFor ? qs('#' + CSS.escape(labelled.htmlFor)) : null)
          if (control) return { el: control, how: 'label' }
        }
      }
      if (o.placeholder) {
        const needle = lower(o.placeholder)
        const hit = qsa('[placeholder]').find((el) => lower(el.getAttribute('placeholder')).includes(needle))
        if (hit) return { el: hit, how: 'placeholder' }
      }
      if (o.role) {
        const role = String(o.role)
        const aria = o.ariaLabel ? lower(o.ariaLabel) : ''
        const pool = qsa('[role="' + role + '"]')
        const hit = pool.find((el) => {
          if (!aria) return true
          return lower([el.getAttribute('aria-label'), el.innerText, el.textContent].filter(Boolean).join(' ')).includes(aria)
        })
        if (hit) return { el: hit, how: 'role' }
      }
      if (o.ariaLabel) {
        const needle = lower(o.ariaLabel)
        const hit = qsa('[aria-label]').find((el) => lower(el.getAttribute('aria-label')).includes(needle))
        if (hit) return { el: hit, how: 'aria-label' }
      }
      if (o.text) {
        const needle = norm(o.text)
        const pool = qsa('button,a,[role="button"],input[type="submit"],input[type="button"],label,summary,li,div,span,td,th')
        const textOf = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label'))
        const clipText = (el) => String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 30)
        let pool2
        if (o.exact === true) {
          pool2 = pool.filter((el) => textOf(el) === needle)
        } else {
          const exact = pool.filter((el) => textOf(el) === needle)
          const starts = pool.filter((el) => textOf(el).startsWith(needle))
          const contains = pool.filter((el) => textOf(el).includes(needle))
          pool2 = exact.length ? exact : starts.length ? starts : contains
        }
        // 只在「命中的那些元素」内部往深处走：容器把整块文字都算进去，点容器等于点整行。
        // 以前是对 pool2 逐个判断 contains 就下沉，实际会顺着 DOM 挑到同一块区域里的
        // 另一个元素——2026-11-24 点「接口管理」点成了「首页」，就是这么来的。
        const leaves = pool2.filter((el) => !pool2.some((other) => other !== el && typeof el.contains === 'function' && el.contains(other)))
        const pickedList = leaves.length ? leaves : pool2
        if (pickedList.length > 1 && o.index == null) {
          // 多个候选：恰好只有一个可见时才自动选它（和 selector 口径一致），两个以上都可见就报出来
          const visible = pickedList.filter((el) => isVisibleEl(el))
          if (visible.length === 1) {
            return { el: visible[0], how: 'text+visible', textMatches: pickedList.length, autoVisible: true }
          }
          const cands = pickedList.slice(0, 8).map((el, k) => k + '. ' + el.tagName.toLowerCase() + '「' + clipText(el) + '」' + (isVisibleEl(el) ? '' : '（不可见）'))
          return {
            el: null,
            errorCode: 'MULTI_MATCH',
            error: '文字「' + norm(o.text) + '」命中 ' + pickedList.length + ' 个元素，不敢乱点。候选：' + cands.join(' / ') +
              '。加 index 指定第几个（从 0 开始），或加 exact:true 精确匹配，或改用 selector / ref / rowText。',
            candidates: cands,
            matched: pickedList.length,
            visible: visible.length,
          }
        }
        if (pickedList.length) return { el: pickedList[idx] || pickedList[0], how: 'text', textMatches: pickedList.length }
      }
      const tried = ['rowText', 'selector', 'name', 'label', 'placeholder', 'role', 'ariaLabel', 'text'].filter((k) => o[k])
      return { el: null, errorCode: 'NOT_FOUND', error: (tried.length ? '没找到元素（试过 ' + tried.join('、') + '）' : 'click 需要 selector / text / rowText / label / role / placeholder / name 之一') + frameTip() }
    }

    function frameTip() {
      if (!S) return ''
      const frames = S.frames()
      if (!frames.length) return ''
      return '（页面另有 ' + frames.length + ' 个同源 iframe：' + frames.map((f) => (f.title || f.src || '?').slice(0, 40) + (f.visible ? '' : '[不可见]')).join('；') + '。要精确指定：先 action=frames 查 frameId，再传 frame=N）'
    }

    // 在 o.in（默认 tbody tr、tr、li）里按文本找一行
    function findRow(o) {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      const needle = norm(o.rowText)
      const containers = o.in
        ? qsa(o.in)
        : qsa('tbody tr, tr, li, [role="row"]')
      if (!containers.length) return { el: null, errorCode: 'NOT_FOUND', error: '没找到行容器' + (o.in ? '：' + o.in : '（可以传 in 指定，如 "tbody tr"）') }
      const mode = String(o.rowMatch || 'auto').toLowerCase()
      const rowText = (row) => norm(row.innerText || row.textContent || '')
      const exact = []
      const prefix = []
      const include = []
      for (const row of containers) {
        const t = rowText(row)
        if (!t) continue
        if (t === needle) exact.push(row)
        else if (t.startsWith(needle)) prefix.push(row)
        else if (t.includes(needle)) include.push(row)
        // 行里有某个单元格的文字正好等于目标（树表的 .first-cell 这种）
        if (t !== needle) {
          const cell = Array.from(row.querySelectorAll('td,th,span,div,a')).find((c) => norm(c.innerText || c.textContent) === needle)
          if (cell) exact.push(row)
        }
      }
      const uniq = (arr) => Array.from(new Set(arr))
      let pick
      if (mode === 'equals' || mode === 'exact') pick = uniq(exact)
      else if (mode === 'startswith' || mode === 'prefix') pick = uniq(prefix.length ? prefix : exact)
      else if (mode === 'includes' || mode === 'contains') pick = uniq(include.length ? include : (prefix.length ? prefix : exact))
      else pick = uniq(exact.length ? exact : (prefix.length ? prefix : include))

      if (!pick.length) {
        const sample = containers.slice(0, 5).map((r) => rowText(r).slice(0, 40))
        return { el: null, errorCode: 'NOT_FOUND', error: '没有一行的文本匹配「' + needle + '」。候选前几行：' + sample.join(' / ') }
      }
      if (pick.length > 1) {
        // 1.16.0：rowText 命中多行时支持 index 指定第几个。
        // 以前错误文案让人「加 index」，但 findRow 根本不看 index —— 照着提示写还是同样的报错。
        if (o.index != null) {
          const idx = Math.max(0, Number(o.index) || 0)
          if (idx < pick.length) return { el: pick[idx], how: 'row+index', rowMatches: pick.length }
        }
        const cands = pick.slice(0, 6).map((r) => rowText(r).slice(0, 50))
        return {
          el: null,
          errorCode: 'MULTI_MATCH',
          error: '「' + needle + '」命中 ' + pick.length + ' 行，不敢乱点。候选：' + cands.join(' / ') +
            '。把 rowText 写全，或用 rowMatch:"equals"，或加 index 指定第几个（从 0 开始）。',
          candidates: cands,
          matched: pick.length,
        }
      }
      return { el: pick[0], how: 'row' }
    }
  }

  /* ------------------------------ 勾选（幂等） ------------------------------ */

  function inPageCheck(args) {
    const opts = args || {}
    const want = opts.checked === false ? false : true
    // 同源 iframe 一起找：门户页的表格在 iframe 里，不跨帧就永远 MULTI_MATCH/NOT_FOUND。
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => {
      const acc = []
      for (const item of docs) {
        try { for (const el of item.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 跳过非法选择器 */ }
      }
      return acc
    }
    const qs = (sel) => qsa(sel)[0] || null
    const frameTip = () => {
      if (!S) return ''
      const frames = S.frames()
      if (!frames.length) return ''
      return '（页面另有 ' + frames.length + ' 个同源 iframe：' + frames.map((f) => (f.title || f.src || '?').slice(0, 40) + (f.visible ? '' : '[不可见]')).join('；') + '。要精确指定：先 action=frames 查 frameId，再传 frame=N）'
    }
    const found = locate(opts)
    if (!found.el) return { ok: false, ...found }
    const el = found.el
    const before = readState(el)
    const out = {
      ok: true,
      checked: before.value,
      wanted: want,
      attempts: 0,
      before: before.value,
      how: found.how,
      stateSource: before.source,
      // 有行文本就用行的，没有才用元素自己的——检查结果时要一眼看出勾的是哪一行
      text: found.row || String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      url: location.href,
    }
    if (opts.dryRun) { out.dryRun = true; out.wouldClick = before.value !== want; return out }

    // 已经是目标状态：不动。这就是幂等——重复跑不会把勾选点掉。
    if (before.value === want) {
      out.skipped = true
      out.message = '已经是目标状态，没有点击'
      return out
    }

    // 注意：Number(undefined) 是 NaN，不能用 `Number(x) == null` 判空——上一版就是这么把
    // 重试次数写成 NaN、一次都不点、直接报 CHECK_FAILED 的。
    const rawRetry = opts.retry == null ? 3 : Number(opts.retry)
    const maxTries = Math.max(1, Math.min(5, Number.isFinite(rawRetry) ? rawRetry : 3))
    let current = before.value
    for (let i = 0; i < maxTries; i++) {
      clickLike(el)
      out.attempts++
      current = waitState(el, want, 500 + i * 250)
      if (current === want) break
      busyWait(150)
    }
    out.checked = current
    out.after = current
    // 业务模型校验：DOM 说选中了、原生 input.checked 却没变，说明只改了样式，
    // Vue/React 的 v-model 没收到 change——这种「假选中」必须报出来，别让调用方以为勾上了。
    const nativeInput = el.tagName === 'INPUT'
      ? el
      : ((el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]')) ||
        (el.closest && el.closest('label') ? el.closest('label').querySelector('input[type="checkbox"],input[type="radio"]') : null))
    if (nativeInput) {
      out.inputChecked = nativeInput.checked === true
      if (current === want && out.inputChecked !== want) {
        out.modelWarning = 'DOM 显示已' + (want ? '选中' : '取消') + '，但原生 input.checked 仍是 ' + out.inputChecked + '：可能只改了样式，业务模型没收到 change。改用 click 点 input 本体，或检查组件绑定。'
      }
    }
    if (current !== want) {
      out.ok = false
      out.errorCode = 'CHECK_FAILED'
      out.error = '点了 ' + out.attempts + ' 次，选中态还是 ' + current + '（想要 ' + want + '）。可能这个元素不是真正的勾选控件，试试 target 指到 input 或 .el-checkbox__inner。'
    }
    return out

    function busyWait(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* 同步等待 */ } }

    function clickLike(node) {
      // Element Plus / Ant 的勾选框：真正的状态在隐藏 input 上。只点外层 span/div
      // 可能只改样式、不触发 change——Vue 的 v-model 收不到，界面上勾了但业务模型
      // 仍是空的（2026-11-20 实测踩到）。优先点 input 本体，点不到再退回原节点。
      let target = node
      if (node.tagName !== 'INPUT') {
        const box = node.closest && node.closest('.el-checkbox,label,[role="checkbox"],.ant-checkbox-wrapper,.ant-checkbox')
        const input = (box && box.querySelector('input[type="checkbox"],input[type="radio"]')) ||
          (node.querySelector && node.querySelector('input[type="checkbox"],input[type="radio"]'))
        if (input) target = input
      }
      target.scrollIntoView({ block: 'center', inline: 'center' })
      if (target.focus) target.focus({ preventScroll: true })
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      target.click()
      return target
    }

    // 选中态读取顺序：input.checked → aria-checked → 类名 → 行内 input
    function readState(node) {
      if (node && node.tagName === 'INPUT' && (node.type === 'checkbox' || node.type === 'radio')) {
        return { value: node.checked === true, source: 'input.checked' }
      }
      const aria = node && node.getAttribute ? node.getAttribute('aria-checked') : null
      if (aria === 'true' || aria === 'false') return { value: aria === 'true', source: 'aria-checked' }
      const cls = String((node && node.className) || '')
      if (/\bis-checked\b|\bis-selected\b|\bselected\b|\bactive\b|\bchecked\b/.test(cls)) return { value: true, source: 'class' }
      const inner = node && node.querySelector ? node.querySelector('input[type="checkbox"],input[type="radio"]') : null
      if (inner) return { value: inner.checked === true, source: 'inner-input' }
      const box = node && node.closest ? node.closest('.el-checkbox,[role="checkbox"],.ant-checkbox,.van-checkbox') : null
      if (box) {
        const a2 = box.getAttribute('aria-checked')
        if (a2 === 'true' || a2 === 'false') return { value: a2 === 'true', source: 'box-aria' }
        const c2 = String(box.className || '')
        if (/\bis-checked\b|\bis-selected\b|\bchecked\b/.test(c2)) return { value: true, source: 'box-class' }
        const i2 = box.querySelector('input[type="checkbox"],input[type="radio"]')
        if (i2) return { value: i2.checked === true, source: 'box-input' }
      }
      return { value: false, source: 'unknown' }
    }

    function waitState(node, target, budgetMs) {
      const start = Date.now()
      let last = readState(node).value
      while (Date.now() - start < budgetMs) {
        last = readState(node).value
        if (last === target) return last
        busyWait(50)
      }
      return last
    }

    function locate(o) {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      // ref：outline 打过的 data-dsh-ref 直接用，不用猜选择器
      if (o.ref) {
        const hit = qs('[data-dsh-ref="' + String(o.ref).replace(/["\\\s]/g, '') + '"]')
        if (hit) return { el: hit, how: 'ref' }
        return { errorCode: 'REF_STALE', error: 'ref ' + o.ref + ' 找不到（页面变了，或又跑过一次 outline）。重新 action=outline 拿新 ref。' }
      }
      if (o.rowText) {
        const rowHit = findRow(o)
        if (rowHit.error) return rowHit
        const row = rowHit.el
        const target = o.target || 'input[type="checkbox"],input[type="radio"],[role="checkbox"],.el-checkbox,.el-checkbox__inner,.ant-checkbox-wrapper,.ant-checkbox'
        const inner = row.querySelector(target)
        if (!inner) return { errorCode: 'NOT_FOUND', error: '行「' + norm(row.innerText).slice(0, 60) + '」里没有可勾选元素（试过 ' + target + '）' }
        return { el: inner, how: 'rowText', row: norm(row.innerText).slice(0, 120) }
      }
      if (o.selector) {
        const nodes = qsa(o.selector)
        const idx = Math.max(0, Number(o.index) || 0)
        if (!nodes.length) return { errorCode: 'NOT_FOUND', error: '没找到元素: ' + o.selector + frameTip() }
        // 勾选同样是写操作：命中多个就报 MULTI_MATCH，别替人挑一个勾上
        if (nodes.length > 1 && o.index == null) {
          const cands = nodes.slice(0, 6).map((n) => String(n.innerText || n.value || n.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 40))
          return {
            el: null,
            errorCode: 'MULTI_MATCH',
            error: '选择器「' + o.selector + '」命中 ' + nodes.length + ' 个元素，不敢乱勾。候选：' + cands.join(' / ') + '。把选择器写细，或加 index 指定第几个。',
            candidates: cands,
            matched: nodes.length,
          }
        }
        return { el: nodes[idx], how: 'selector', matched: nodes.length }
      }
      if (o.name) {
        const hit = qsa('[name]').find((el) => norm(el.getAttribute('name')).toLowerCase() === norm(o.name).toLowerCase())
        if (hit) return { el: hit, how: 'name' }
      }
      if (o.label) {
        const needle = norm(o.label).toLowerCase()
        const labelled = qsa('label').find((l) => norm(l.innerText).toLowerCase().includes(needle))
        if (labelled) {
          const control = labelled.control || labelled.querySelector('input,button') || (labelled.htmlFor ? qs('#' + CSS.escape(labelled.htmlFor)) : null)
          if (control) return { el: control, how: 'label' }
        }
      }
      if (o.text) {
        const needle = norm(o.text)
        const pool = qsa('label,button,[role="checkbox"],[role="option"],li,div,span')
        const hit = pool.find((el) => norm(el.innerText) === needle)
        if (hit) {
          const box = hit.querySelector('input[type="checkbox"],input[type="radio"]') || hit.closest('label')
          return { el: box || hit, how: 'text' }
        }
      }
      const tried = ['rowText', 'selector', 'name', 'label', 'text'].filter((k) => o[k])
      return { errorCode: 'NOT_FOUND', error: (tried.length ? '没找到勾选元素（试过 ' + tried.join('、') + '）' : 'check 需要 selector / rowText / name / label / text 之一') + frameTip() }
    }

    function findRow(o) {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      const needle = norm(o.rowText)
      const containers = o.in
        ? qsa(o.in)
        : qsa('tbody tr, tr, li, [role="row"]')
      if (!containers.length) return { errorCode: 'NOT_FOUND', error: '没找到行容器' + (o.in ? '：' + o.in : '（可以传 in 指定，如 "tbody tr"）') }
      const rowText = (row) => norm(row.innerText || row.textContent || '')
      const exact = []
      const prefix = []
      const include = []
      for (const row of containers) {
        const t = rowText(row)
        if (!t) continue
        if (t === needle) exact.push(row)
        else if (t.startsWith(needle)) prefix.push(row)
        else if (t.includes(needle)) include.push(row)
        if (t !== needle) {
          const cell = Array.from(row.querySelectorAll('td,th,span,div,a')).find((c) => norm(c.innerText || c.textContent) === needle)
          if (cell) exact.push(row)
        }
      }
      const uniq = (arr) => Array.from(new Set(arr))
      const mode = String(o.rowMatch || 'auto').toLowerCase()
      let pick
      if (mode === 'equals' || mode === 'exact') pick = uniq(exact)
      else if (mode === 'startswith' || mode === 'prefix') pick = uniq(prefix.length ? prefix : exact)
      else if (mode === 'includes' || mode === 'contains') pick = uniq(include.length ? include : (prefix.length ? prefix : exact))
      else pick = uniq(exact.length ? exact : (prefix.length ? prefix : include))
      if (!pick.length) {
        const sample = containers.slice(0, 5).map((r) => rowText(r).slice(0, 40))
        return { errorCode: 'NOT_FOUND', error: '没有一行的文本匹配「' + needle + '」。候选前几行：' + sample.join(' / ') }
      }
      if (pick.length > 1) {
        if (o.index != null) {
          const idx = Math.max(0, Number(o.index) || 0)
          if (idx < pick.length) return { el: pick[idx], how: 'row+index', rowMatches: pick.length }
        }
        const cands = pick.slice(0, 6).map((r) => rowText(r).slice(0, 50))
        return {
          errorCode: 'MULTI_MATCH',
          error: '「' + needle + '」命中 ' + pick.length + ' 行，不敢乱点。候选：' + cands.join(' / ') + '。把 rowText 写全，或用 rowMatch:"equals"，或加 index 指定第几个（从 0 开始）。',
          candidates: cands,
          matched: pick.length,
        }
      }
      return { el: pick[0] }
    }
  }

  /* ------------------------------ 盘点选中态 ------------------------------ */

  function inPageIsChecked(args) {
    const opts = args || {}
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 300))
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const containers = opts.in
      ? qsa(opts.in)
      : (opts.selector ? qsa(opts.selector) : [])
    if (!containers.length) {
      return { ok: false, errorCode: 'BAD_ARGS', error: 'isChecked 需要 in（行容器，如 "tbody tr"）或 selector（逐个元素）' }
    }
    const target = opts.target || 'input[type="checkbox"],input[type="radio"],[role="checkbox"],.el-checkbox,.ant-checkbox-wrapper,.van-checkbox'

    const readState = (node) => {
      if (node && node.tagName === 'INPUT' && (node.type === 'checkbox' || node.type === 'radio')) return node.checked === true
      if (node && node.getAttribute) {
        const aria = node.getAttribute('aria-checked')
        if (aria === 'true' || aria === 'false') return aria === 'true'
        const cls = String(node.className || '')
        if (/\bis-checked\b|\bis-selected\b|\bselected\b|\bactive\b|\bchecked\b/.test(cls)) return true
      }
      const inner = node && node.querySelector ? node.querySelector('input[type="checkbox"],input[type="radio"]') : null
      if (inner) return inner.checked === true
      const box = node && node.closest ? node.closest('.el-checkbox,[role="checkbox"],.ant-checkbox,.van-checkbox') : null
      if (box) {
        const a2 = box.getAttribute('aria-checked')
        if (a2 === 'true' || a2 === 'false') return a2 === 'true'
        const c2 = String(box.className || '')
        if (/\bis-checked\b|\bis-selected\b|\bchecked\b/.test(c2)) return true
        const i2 = box.querySelector('input[type="checkbox"],input[type="radio"]')
        if (i2) return i2.checked === true
      }
      return false
    }

    const rows = []
    for (const row of containers.slice(0, limit)) {
      let el = null
      if (opts.selector && !opts.in) el = row
      else el = row.querySelector(target)
      const text = norm((el && el.closest && el.closest('tr')) ? el.closest('tr').innerText : (row.innerText || row.textContent || '')).slice(0, 120)
      rows.push({
        text,
        checked: el ? readState(el) : null,
        hasControl: Boolean(el),
      })
    }
    const checkedCount = rows.filter((r) => r.checked === true).length
    return { ok: true, total: rows.length, checkedCount, rows, url: location.href }
  }

  /* ------------------------------ 填输入框 ------------------------------ */

  function inPageType(args) {
    const opts = args || {}
    // 填错输入框比点错按钮更难发现：selector 命中多个时不替人挑
    if (opts.selector && opts.index == null) {
      const nodes = Array.from(document.querySelectorAll(opts.selector))
      if (nodes.length > 1) {
        const cands = nodes.slice(0, 6).map((n) => String(n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.name || n.id || n.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 40))
        return {
          ok: false,
          errorCode: 'MULTI_MATCH',
          error: '选择器「' + opts.selector + '」命中 ' + nodes.length + ' 个输入框，不敢乱填。候选：' + cands.join(' / ') + '。把选择器写细，或加 index 指定第几个。',
          candidates: cands,
          matched: nodes.length,
        }
      }
    }
    const el = findField(opts)
    if (!el) {
      if (opts.ref) return { ok: false, errorCode: 'REF_STALE', error: 'ref ' + opts.ref + ' 找不到（页面变了，或又跑过一次 outline）。重新 action=outline 拿新 ref。' }
      return { ok: false, errorCode: 'NOT_FOUND', error: describeFieldMiss(opts) }
    }
    const value = String(opts.value == null ? '' : opts.value)
    const fieldInfo = {
      tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
      label: labelOf(el), placeholder: el.placeholder || '',
    }
    if (opts.dryRun) {
      return { ok: true, dryRun: true, wouldFill: fieldInfo, valueLength: value.length, masked: el.type === 'password', url: location.href }
    }
    const nativeSetter = (node, val) => {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(node, val)
      else node.value = val
    }
    const before = el.value
    const maxTries = opts.verify === false ? 1 : 2
    let applied = false
    let node = el
    for (let i = 0; i < maxTries; i++) {
      // 组件重建会把 input 节点换掉：每轮重新找一次，别对着旧节点写
      if (i > 0) {
        const again = findField(opts)
        if (again) node = again
      }
      node.scrollIntoView({ block: 'center' })
      node.focus({ preventScroll: true })
      if (opts.clear !== false) {
        nativeSetter(node, '')
        node.dispatchEvent(new Event('input', { bubbles: true }))
      }
      nativeSetter(node, value)
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
      if (opts.verify === false) { applied = true; break }
      // 回读校验：写进去了没有？Vue/React 重建节点时这里是唯一能抓到的点。
      if (String(node.value) === value) { applied = true; break }
      busyWait(120)
    }

    const result = {
      ok: true,
      filled: fieldInfo,
      previousValue: el.type === 'password' ? '***' : String(before).slice(0, 120),
      valueLength: value.length,
      value: el.type === 'password' ? '***' : String(node.value).slice(0, 2000),
      verified: applied,
      submitted: null,
      url: location.href,
    }
    if (!applied) {
      result.ok = false
      result.errorCode = 'TYPE_NOT_APPLIED'
      result.error = '写了 ' + maxTries + ' 次，输入框的值还是没变（期望 ' + value.length + ' 字）。通常是组件在重建节点，先 wait 元素稳定再填，或用 selector 精确定位。'
      return result
    }

    if (opts.submit) {
      const mode = String(opts.submitMode || 'auto').toLowerCase()
      const form = node.form || node.closest('form')
      const submitter = form ? (form.querySelector('button[type="submit"],input[type="submit"],button:not([type])') || null) : null
      const isSearch = node.type === 'search' || /搜索|search|请输入点名|关键字/i.test((node.placeholder || '') + ' ' + labelOf(node))

      // Element Plus 的搜索框只认 keydown + keyup（且要 keyCode），只发一次 keydown 不生效。
      const pressEnter = () => {
        const fire = (kind) => node.dispatchEvent(new KeyboardEvent(kind, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }))
        fire('keydown')
        fire('keypress')
        fire('keyup')
      }

      if (mode === 'click' || mode === 'button') {
        if (submitter) { submitter.click(); result.submitted = 'button-click' }
        else if (opts.submitSelector) {
          const b = document.querySelector(opts.submitSelector)
          if (b) { b.click(); result.submitted = 'submitSelector-click' }
        }
        if (!result.submitted) { pressEnter(); result.submitted = 'enter-keydown-keyup' }
      } else if (mode === 'enter' || mode === 'enter-keyup') {
        pressEnter()
        result.submitted = 'enter-keydown-keyup'
      } else if (mode === 'form') {
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit(submitter && submitter.type === 'submit' ? submitter : undefined)
          result.submitted = 'form.requestSubmit'
        } else if (submitter) { submitter.click(); result.submitted = 'button-click' }
        else { pressEnter(); result.submitted = 'enter-keydown-keyup' }
      } else {
        // auto：搜索框走 keydown+keyup，普通表单走 requestSubmit
        if (isSearch) { pressEnter(); result.submitted = 'enter-keydown-keyup' }
        else if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit(submitter && submitter.type === 'submit' ? submitter : undefined)
          result.submitted = 'form.requestSubmit'
        } else if (submitter) { submitter.click(); result.submitted = 'button-click' }
        else { pressEnter(); result.submitted = 'enter-keydown-keyup' }
      }
    }
    return result

    function busyWait(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* 同步等待 */ } }

    function labelOf(n) {
      if (n.labels && n.labels.length) return String(n.labels[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const wrapping = n.closest && n.closest('label')
      if (wrapping) return String(wrapping.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      return n.getAttribute('aria-label') || ''
    }

    function findField(o) {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
      // 同源 iframe 一起找：表单常挂在 iframe 的业务页里
      const S = globalThis.__dshScope
      const docs = S ? S.docs() : [{ doc: document, frame: null }]
      const qsa = (sel) => {
        const acc = []
        for (const item of docs) {
          try { for (const el of item.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 跳过非法选择器 */ }
        }
        return acc
      }
      const qs = (sel) => qsa(sel)[0] || null
      // ref：outline 拿到 e7 就直接填它，不用编选择器
      if (o.ref) {
        const hit = qs('[data-dsh-ref="' + String(o.ref).replace(/["\\\s]/g, '') + '"]')
        if (hit) return hit
        return null
      }
      if (o.selector) {
        const found = qs(o.selector)
        if (found) return found
      }
      const fields = qsa('input:not([type="hidden"]),textarea,select')
      const byName = o.name ? fields.find((x) => norm(x.name) === norm(o.name) || norm(x.id) === norm(o.name)) : null
      if (byName) return byName
      const byPlaceholder = o.placeholder ? fields.find((x) => norm(x.placeholder).includes(norm(o.placeholder))) : null
      if (byPlaceholder) return byPlaceholder
      const byAria = o.ariaLabel ? fields.find((x) => norm(x.getAttribute('aria-label')).includes(norm(o.ariaLabel))) : null
      if (byAria) return byAria
      const byLabel = o.label ? fields.find((x) => {
        const l = (x.labels && x.labels[0] ? x.labels[0].innerText : '') + ' ' + (x.closest('label') ? x.closest('label').innerText : '')
        return norm(l).includes(norm(o.label))
      }) : null
      if (byLabel) return byLabel
      if (o.role) {
        const byRole = qsa('[role="' + String(o.role) + '"]').find((x) => x.tagName === 'INPUT' || x.tagName === 'TEXTAREA' || x.tagName === 'SELECT')
        if (byRole) return byRole
      }
      const hint = norm(o.hint)
      if (!hint) return null
      let best = null
      for (const x of fields) {
        const hay = [x.name, x.id, x.placeholder, x.getAttribute('aria-label'), x.type].map(norm).join(' ')
        let score = 0
        if (hay.includes(hint)) score = 50
        const label = x.labels && x.labels[0] ? norm(x.labels[0].innerText) : ''
        if (label.includes(hint)) score = Math.max(score, 70)
        if (score > (best ? best.score : 0)) best = { el: x, score }
      }
      return best ? best.el : null
    }

    function describeFieldMiss(o) {
      const tried = ['selector', 'name', 'label', 'placeholder', 'ariaLabel', 'role', 'hint'].filter((k) => o[k])
      if (!tried.length) return 'type 需要 selector / name / label / placeholder / ariaLabel / hint 之一'
      return '没找到输入框（试过 ' + tried.join('、') + '）'
    }
  }

  /* ------------------------------ 下拉 ------------------------------ */

  function inPageSelect(args) {
    const opts = args || {}
    if (!opts.selector) return { ok: false, errorCode: 'BAD_ARGS', error: 'select 需要 selector' }
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qs = (sel) => { for (const d of docs) { try { const el = d.doc.querySelector(sel); if (el) return el } catch { /* 非法选择器 */ } } return null }
    const el = qs(opts.selector)
    if (!el) return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个 select: ' + opts.selector }
    if (el.tagName !== 'SELECT') return { ok: false, errorCode: 'NOT_SELECT', error: '这个元素不是 <select>，是 ' + el.tagName }
    const want = String(opts.value == null ? '' : opts.value)
    const options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text, selected: o.selected }))
    let hit = options.find((o) => o.value === want) || options.find((o) => o.text.trim() === want) || options.find((o) => o.text.toLowerCase().includes(want.toLowerCase()))
    if (opts.index != null) hit = options[Number(opts.index)]
    if (!hit) return { ok: false, errorCode: 'NO_OPTION', error: '没有匹配的选项: ' + want, options }
    el.value = hit.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, selected: hit, options, url: location.href }
  }

  /* ------------------------------ 读值（长文本） ------------------------------ */

  function inPageValue(args) {
    const opts = args || {}
    if (!opts.selector) return { ok: false, errorCode: 'BAD_ARGS', error: 'value 需要 selector' }
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const nodes = qsa(opts.selector)
    if (!nodes.length) return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个元素: ' + opts.selector }
    const el = nodes[Math.max(0, Number(opts.index) || 0)] || nodes[0]
    const prop = String(opts.prop || 'auto')
    let raw
    let usedProp = prop
    if (prop === 'auto') {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') { raw = el.value; usedProp = 'value' }
      else if (el.href) { raw = el.href; usedProp = 'href' }
      else { raw = el.innerText != null ? el.innerText : el.textContent; usedProp = 'innerText' }
    } else if (prop === 'value') raw = el.value
    else if (prop === 'text') raw = el.innerText != null ? el.innerText : el.textContent
    else if (prop === 'html') { raw = el.outerHTML; usedProp = 'html' }
    else raw = el[prop]
    if (raw == null) return { ok: false, errorCode: 'NO_PROP', error: '这个元素没有 ' + prop + ' 属性' }
    let text = String(raw)
    if (opts.trim !== false) text = text.trim()
    if (el.type === 'password') {
      // 密码框永不回显；只给长度，够判断「填进去了没有」
      return { ok: true, prop: usedProp, length: text.length, value: '***（密码框，不回显）', truncated: false, tag: el.tagName.toLowerCase(), id: el.id || '', name: el.name || '', password: true, url: location.href }
    }
    const maxChars = Number(opts.maxChars)
    const limit = maxChars === 0 || opts.fullValue ? text.length : Math.max(1, Math.min(2000000, maxChars || 2000))
    return {
      ok: true,
      prop: usedProp,
      length: text.length,
      value: text.slice(0, limit),
      truncated: text.length > limit,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.name || '',
      password: el.type === 'password',
      url: location.href,
    }
  }

  /* ------------------------------ eval（带 CSP 判别） ------------------------------ */

  function inPageEval(args) {
    const opts = args || {}
    const code = String(opts.code || '')
    if (!code.trim()) return { ok: false, errorCode: 'BAD_ARGS', error: 'eval 需要 code' }
    const runId = String(opts.runId || '')
    const registry = (function () {
      if (!window.__dshEvalRuns) window.__dshEvalRuns = {}
      return window.__dshEvalRuns
    })()
    if (runId) registry[runId] = { startedAt: Date.now(), cancelled: false, done: false }

    // 给被执行的代码一个退出口子：长循环里调 window.__dshAborted(runId) 就能自己停。
    window.__dshAborted = function (id) {
      const slot = window.__dshEvalRuns && window.__dshEvalRuns[id || runId]
      return Boolean(slot && slot.cancelled)
    }

    const finish = (value) => {
      if (runId) registry[runId] = { ...(registry[runId] || {}), done: true, finishedAt: Date.now() }
      // pick：只要结果里的一条路径（a.b[0].c / rows[*].code），省掉「先回全量再自己筛」。
      // 解析失败就当没写 pick，别让一个手滑的路径把整个 eval 判成失败（2026-11-21 加）。
      if (opts.pick) {
        const parts = String(opts.pick).replace(/\[(\d+|\*)\]/g, '.$1').split('.').filter((s) => s !== '')
        const walk = (v, i) => {
          if (i >= parts.length) return v
          if (v == null) return undefined
          const key = parts[i]
          if (key === '*') {
            if (Array.isArray(v)) return v.map((x) => walk(x, i + 1))
            if (typeof v === 'object') {
              const out = {}
              for (const k of Object.keys(v)) out[k] = walk(v[k], i + 1)
              return out
            }
            return undefined
          }
          return walk(v[key], i + 1)
        }
        try { value = walk(value, 0) } catch { /* 路径不合法：按原值返回 */ }
      }
      const pickedField = opts.pick ? { picked: opts.pick } : {}
      if (value === undefined) return { ok: true, runId, value: undefined, type: 'undefined', ...pickedField }
      let json
      try { json = JSON.stringify(value) } catch { json = undefined }
      // 返回值体积上限：一次 eval 把 190 万字的页面配置灌进上下文，
      // 后面几轮都得还债。超限时做**深度裁剪**而不是直接切 JSON——直接 slice
      // 会切出半个键值对/丢结尾引号，下游 JSON.parse 必坏（2026-11-20 修）。
      // maxChars:0 表示「要全文」——和 value / read 的语义对齐。以前写成
      // `Number(opts.maxChars) || 12000`，0 是 falsy，于是「0=全文」在 eval 上
      // 静默失效，saveTo 落盘也只能拿到 12000 字的半截（2026-11-20 修）。
      const limit = Number(opts.maxChars) === 0
        ? 2000000
        : Math.max(500, Math.min(2000000, Number(opts.maxChars) || 12000))
      const trimValue = (v, budget, depth) => {
        if (depth > 12) return '…（嵌套过深）'
        if (typeof v === 'string') return v.length <= budget ? v : (v.slice(0, Math.max(1, budget - 1)) + '…')
        if (Array.isArray(v)) {
          const per = Math.max(1, Math.floor(budget / Math.max(1, v.length)))
          const out = []
          for (const x of v) { if (out.length * (per + 2) >= budget) break; out.push(trimValue(x, per, depth + 1)) }
          return out
        }
        if (v && typeof v === 'object') {
          const keys = Object.keys(v)
          const per = Math.max(1, Math.floor(budget / Math.max(1, keys.length)))
          const out = {}
          for (const k of keys) out[k] = trimValue(v[k], per, depth + 1)
          return out
        }
        return v
      }
      if (json !== undefined && json.length > limit) {
        const trimmed = trimValue(value, limit, 0)
        let trimmedJson = null
        try { trimmedJson = JSON.stringify(trimmed) } catch { trimmedJson = null }
        if (trimmedJson !== null) {
          return {
            ok: true, runId, type: typeof value, value: trimmed, truncated: true, valueLength: json.length,
            note: '返回值 ' + json.length + ' 字，超过 maxChars=' + limit + '，已按字段裁剪（字符串截断、容器递归），结构仍是合法 JSON。要全文：加大 maxChars，或加 saveTo 落盘。',
            ...pickedField,
          }
        }
        // 极端嵌套兜不住时再退化成字符串预览，但明确标注它不可解析
        return {
          ok: true, runId, type: typeof value,
          value: json.slice(0, limit),
          truncated: true,
          valueLength: json.length,
          note: '返回值 ' + json.length + ' 字，超过 maxChars=' + limit + '，且无法安全裁剪，只给前 ' + limit + ' 字（此为字符串预览，不是合法 JSON）。',
          ...pickedField,
        }
      }
      try {
        return { ok: true, runId, type: typeof value, value: json === undefined ? String(value) : JSON.parse(json), ...pickedField }
      } catch {
        return { ok: true, runId, type: typeof value, value: String(value), ...pickedField }
      }
    }

    let fn
    try {
      fn = new Function('"use strict"; return (' + code + '\n)')
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (/Content Security Policy|unsafe-eval|EvalError|blocked/i.test(msg)) {
        return {
          ok: false,
          errorCode: 'EVAL_CSP_BLOCKED',
          error: '这个执行环境禁止 eval（CSP：' + msg + '）。扩展会自动改用 DevTools 通道（via:"cdp"）再试一次；' +
            '如果还是失败，说明页面连注入都不允许，改用 flow 的声明式步骤（click/type/check/extract）。',
          world: 'ISOLATED',
        }
      }
      return { ok: false, errorCode: 'EVAL_SYNTAX', error: '代码有语法错误: ' + msg }
    }

    try {
      const value = fn()
      if (value && typeof value.then === 'function') {
        return value.then(finish, (e) => ({ ok: false, errorCode: 'EVAL_REJECTED', error: 'Promise 拒绝: ' + ((e && e.message) || e), runId }))
      }
      return finish(value)
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (/Content Security Policy|unsafe-eval/i.test(msg)) {
        return {
          ok: false,
          errorCode: 'EVAL_CSP_BLOCKED',
          error: '代码执行时被 CSP 挡了（' + msg + '）。扩展会自动改用 DevTools 通道（via:"cdp"）再试一次。',
          world: 'ISOLATED',
        }
      }
      return { ok: false, errorCode: 'EVAL_ERROR', error: '执行出错: ' + msg, runId, stack: String((error && error.stack) || '').slice(0, 800) }
    }
  }

  function inPageAbort(args) {
    const opts = args || {}
    const id = String(opts.runId || '')
    if (!window.__dshEvalRuns) return { ok: false, errorCode: 'NO_RUNS', error: '页面里没有在跑的任务（可能刷新过了）' }
    if (id) {
      if (!window.__dshEvalRuns[id]) return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个 runId：' + id }
      window.__dshEvalRuns[id].cancelled = true
      return { ok: true, cancelled: id, runs: Object.keys(window.__dshEvalRuns) }
    }
    const ids = Object.keys(window.__dshEvalRuns)
    for (const key of ids) window.__dshEvalRuns[key].cancelled = true
    return { ok: true, cancelledAll: ids.length, runs: ids }
  }

  /* ------------------------------ 重放 ------------------------------ */

  /**
   * 按记录原样重发一条请求（1.11.1）
   *
   * 为什么要有：排查「为什么页面调这个接口是空的、我调同样的参数有数据」时，
   * 差别往往只在请求头上（moduleCode / X-Function-Code / X-Operator 这类），
   * 以前只能手写 fetch、一个个补头，既慢又容易漏。
   *
   * 注意：这是**真发**一条请求，写操作会被真的执行；只想知道会发什么用 dryRun。
   * 走页面上下文的 fetch：cookie 自动带上，netBlock 的规则也照样生效。
   */
  function inPageReplay(args) {
    const o = args || {}
    const url = String(o.url || '')
    if (!url || url === 'about:blank') return { ok: false, errorCode: 'BAD_ARGS', error: '没有可重放的 URL' }
    const method = String(o.method || 'GET').toUpperCase()
    // maxChars:0 = 全文（上限 2MB），给 replay + saveTo 用；默认仍只回 2000 字预览。
    const max = Number(o.maxChars) === 0 ? 2000000 : Math.max(200, Math.min(2000000, Number(o.maxChars) || 2000))
    const started = Date.now()
    // 这些头浏览器不让改，带上会直接 TypeError
    const FORBIDDEN = /^(cookie|host|content-length|connection|origin|referer|accept-encoding|accept-language|user-agent|sec-.*|proxy-.*|te|trailer|upgrade)$/i
    const pick = (h) => {
      const out = {}
      for (const [k, v] of Object.entries(h || {})) if (!FORBIDDEN.test(String(k))) out[k] = String(v)
      return out
    }
    const headObj = pick(o.headers)
    const init = { method, headers: headObj, credentials: 'include', cache: 'no-store', redirect: 'follow' }
    if (!['GET', 'HEAD'].includes(method) && o.body != null && String(o.body) !== '') init.body = String(o.body)
    const finish = async (res) => {
      let text = ''
      let err = ''
      try { text = await res.text() } catch (e) { err = String((e && e.message) || e) }
      const headers = {}
      try {
        res.headers.forEach((v, k) => {
          headers[k] = /^(set-cookie|authorization)$/i.test(k) ? '***' : String(v).slice(0, 160)
        })
      } catch { /* 拿不到头就算了 */ }
      let json = null
      if (!err && text) {
        const t = text.trim()
        if (t.startsWith('{') || t.startsWith('[')) {
          try { json = JSON.parse(text) } catch { json = null }
        }
      }
      return {
        ok: true, status: res.status, statusText: res.statusText || '', url: res.url || url,
        headers, body: text.slice(0, max), bodyLength: text.length, bodyTruncated: text.length > max,
        jsonHead: json && typeof json === 'object' ? JSON.stringify(json).slice(0, max) : '',
        bodyError: err, ms: Date.now() - started,
      }
    }
    return fetch(url, init).then(finish, async (error) => {
      const msg = String((error && error.message) || error)
      // 头里有浏览器不认的：退一步，只留 content-type / x-* / moduleCode 这类常见业务头再试一次
      if (/invalid header|forbidden header|refused to set/i.test(msg)) {
        const keep = {}
        for (const [k, v] of Object.entries(headObj)) if (/^(content-type|x-.*|modulecode|accept)$/i.test(k)) keep[k] = v
        try {
          const res = await fetch(url, { ...init, headers: keep })
          const out = await finish(res)
          return { ...out, retriedWith: Object.keys(keep) }
        } catch (e2) {
          return { ok: false, errorCode: 'REPLAY_FAILED', error: String((e2 && e2.message) || e2), triedHeaders: Object.keys(keep) }
        }
      }
      return { ok: false, errorCode: 'REPLAY_FAILED', error: msg }
    })
  }

  /* ------------------------------ 通用请求 ------------------------------ */

  /**
   * 在页面上下文发一条任意 HTTP 请求（1.13.0）。
   *
   * 为什么要有：接口排查十次有八次要「带页面 cookie 再问一次、拿一份响应体」，
   * 以前只能手写 eval + fetch，再自己截断、自己拼头；拿一份 150KB 的配置要来回好几轮，
   * 稍不注意还把整个 JSON 灌进上下文。这里一次调用给到：状态码 + 全量长度 + 预览，
   * 要全文就 saveTo 落盘。credentials:'include'，cookie 自动带上，netBlock 规则也照样生效。
   */
  async function inPageFetch(args) {
    const o = args || {}
    const url = String(o.url || '').trim()
    if (!url) return { ok: false, errorCode: 'BAD_ARGS', error: 'fetch 需要 url（相对地址按当前帧解析）' }
    const method = String(o.method || 'GET').toUpperCase()
    const headers = {}
    for (const [k, v] of Object.entries(o.headers || {})) {
      if (v == null) continue
      headers[String(k)] = String(v)
    }
    let body
    if (o.body != null && !['GET', 'HEAD'].includes(method)) {
      const hasCt = () => Object.keys(headers).some((k) => /^content-type$/i.test(k))
      if (typeof o.body === 'string') {
        body = o.body
        // 1.16.0：字符串体但内容明显是 JSON 时补 Content-Type。
        // 之前传 '{"page":1}' 会按 text/plain 发，网关直接回 415 —— 与「对象体自动补头」不一致。
        if (/^\s*[\[{]/.test(body) && !hasCt()) {
          try { JSON.parse(body); headers['Content-Type'] = 'application/json;charset=utf-8' } catch { /* 不是合法 JSON，保持原样 */ }
        }
      } else {
        body = JSON.stringify(o.body)
        if (!hasCt()) headers['Content-Type'] = 'application/json;charset=utf-8'
      }
    }
    const timeoutMs = Math.max(1000, Math.min(120000, Number(o.timeoutMs) || 20000))
    const max = Number(o.maxChars) === 0 ? 2000000 : Math.max(200, Math.min(2000000, Number(o.maxChars) || 6000))
    const started = Date.now()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await fetch(url, {
        method, headers, body, credentials: 'include', cache: 'no-store', redirect: 'follow',
        ...(controller ? { signal: controller.signal } : {}),
      })
      let text = ''
      let readError = ''
      try { text = await res.text() } catch (e) { readError = String((e && e.message) || e) }
      const respHeaders = {}
      try {
        res.headers.forEach((v, k) => {
          if (!/^set-cookie$/i.test(k)) respHeaders[k] = String(v).slice(0, 200)
        })
      } catch { /* 拿不到响应头就算了 */ }
      let json
      let jsonError = ''
      if (o.json === true && !readError && text) {
        try { json = JSON.parse(text) } catch (e) { jsonError = String((e && e.message) || e) }
      }
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText || '',
        url: res.url || url,
        redirected: res.redirected === true,
        contentType: String(respHeaders['content-type'] || '').slice(0, 120),
        headers: respHeaders,
        length: text.length,
        body: text.slice(0, max),
        truncated: text.length > max,
        readError,
        ...(json === undefined ? {} : { json }),
        ...(jsonError ? { jsonError } : {}),
        frameUrl: location.href,
        ms: Date.now() - started,
      }
    } catch (error) {
      const msg = String((error && error.message) || error)
      const aborted = /abort/i.test(msg)
      return {
        ok: false,
        errorCode: aborted ? 'FETCH_TIMEOUT' : 'FETCH_FAILED',
        error: aborted ? '请求超时（' + timeoutMs + 'ms）：' + url : '请求失败：' + msg,
        url, method, ms: Date.now() - started,
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /* ------------------------------ 等待 ------------------------------ */

  function inPageWait(args) {
    const opts = args || {}
    const timeout = Math.max(200, Math.min(120000, Number(opts.timeoutMs) || 10000))
    const poll = Math.max(50, Math.min(1000, Number(opts.pollMs) || 200))
    const start = Date.now()
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    // 同源 iframe 一起找/一起看：门户壳页的正文和控件都在 iframe 里
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qs = (sel) => { for (const d of docs) { try { const el = d.doc.querySelector(sel); if (el) return el } catch { /* 非法选择器 */ } } return null }
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const bodyText = () => docs.map((d) => String(d.doc.body && d.doc.body.innerText || '')).join('\n')
    const firstSig = (function () {
      // changed:true 的基准：一开始先记下来（不带 selector 时看所有同源帧的正文）
      if (!opts.changed) return null

    const scope = opts.selector ? qs(opts.selector) : null
      if (scope) return norm(opts.prop === 'value' ? scope.value : scope.innerText)
      return norm(bodyText())
    })()
    return new Promise((resolve) => {
      const check = () => {
        if (opts.selector || opts.count) {
          const sel = opts.selector || opts.count.selector
          const found = qsa(sel)
          const wantCount = opts.count ? Math.max(1, Number(opts.count.atLeast || opts.count.exactly || 1)) : 1
          const enough = opts.count && opts.count.exactly != null ? found.length === Number(opts.count.exactly) : found.length >= wantCount
          if (enough) {
            const el = found[0]
            const visible = !opts.visible || (el && el.getBoundingClientRect().width > 0)
            if (visible) {
              return resolve({
                ok: true, matched: opts.count ? 'count' : 'selector',
                count: found.length,
                text: norm(el && el.innerText).slice(0, 200),
                url: location.href, ms: Date.now() - start,
              })
            }
          }
        }
        if (opts.text) {
          const body = norm(bodyText())
          const needle = norm(opts.text)
          // 默认精确到「独立出现」：不把 LT_V13219A 当成命中 LT_V13219A.AV 的理由（假成功的老坑）
          const hit = opts.exact === true
            ? body.split(/\s+/).includes(needle)
            : body.includes(needle)
          if (hit) return resolve({ ok: true, matched: opts.exact === true ? 'text-exact' : 'text', url: location.href, ms: Date.now() - start })
        }
        if (opts.textGone) {
          // 等「提示消失」：提交后的「保存成功」浮层、loading 遮罩都靠它
          const body = norm(bodyText())
          const needle = norm(opts.textGone)
          const hit = opts.exact === true ? body.split(/\s+/).includes(needle) : body.includes(needle)
          if (!hit) return resolve({ ok: true, matched: 'text-gone', url: location.href, ms: Date.now() - start })
        }
        if (opts.urlContains && location.href.includes(opts.urlContains)) return resolve({ ok: true, matched: 'url', url: location.href, ms: Date.now() - start })
        if (opts.value && opts.value.selector) {
          const el = qs(opts.value.selector)
          if (el) {
            const v = String(el.value == null ? el.innerText : el.value)
            if (opts.value.equals !== undefined && v === String(opts.value.equals)) return resolve({ ok: true, matched: 'value', value: v.slice(0, 200), url: location.href, ms: Date.now() - start })
            if (opts.value.includes !== undefined && v.includes(String(opts.value.includes))) return resolve({ ok: true, matched: 'value', value: v.slice(0, 200), url: location.href, ms: Date.now() - start })
          }
        }
        if (opts.changed) {

    const scope = opts.selector ? qs(opts.selector) : null
          const now = scope
            ? norm(opts.prop === 'value' ? scope.value : scope.innerText)
            : norm(bodyText())
          if (now && now !== firstSig) return resolve({ ok: true, matched: 'changed', url: location.href, ms: Date.now() - start })
        }
        if (opts.until && opts.until.selector) {
          const el = qs(opts.until.selector)
          if (el) {
            const attr = opts.until.attr
            const want = opts.until.equals
            const value = attr ? el.getAttribute(attr) : (el.innerText || '')
            if (want === undefined || String(value) === String(want) || String(value).includes(String(want))) {
              return resolve({ ok: true, matched: 'until', url: location.href, ms: Date.now() - start })
            }
          }
        }
        const any = opts.selector || opts.text || opts.textGone || opts.urlContains || opts.value || opts.changed || opts.count || opts.until
        if (!any) return resolve({ ok: false, errorCode: 'BAD_ARGS', error: 'wait 需要 selector / text / textGone / urlContains / value / changed / count / until 之一（纯等秒数用 time）' })
        if (Date.now() - start >= timeout) {
          return resolve({
            ok: false, errorCode: 'WAIT_TIMEOUT',
            error: '等待超时（' + timeout + 'ms）',
            hint: opts.textGone
              ? '「' + norm(opts.textGone) + '」一直没消失。确认提示真的会关掉；要等它出现再加 changed:true。'
              : (opts.text ? '没等到文字「' + norm(opts.text) + '」。如果它本来就在（旧内容残留），改用 changed:true 或 exact:true。' : ''),
            url: location.href, ms: Date.now() - start,
          })
        }
        setTimeout(check, poll)
      }
      check()
    })
  }

  /* ------------------------------ 滚动 ------------------------------ */

  function inPageScroll(args) {
    const opts = args || {}
    if (opts.selector) {
      const S = globalThis.__dshScope
      const docs = S ? S.docs() : [{ doc: document, frame: null }]
      const qs = (sel) => { for (const d of docs) { try { const el = d.doc.querySelector(sel); if (el) return el } catch { /* 非法选择器 */ } } return null }
      const el = qs(opts.selector)
      if (!el) return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个元素: ' + opts.selector }
      el.scrollIntoView({ block: opts.block || 'center', behavior: opts.smooth ? 'smooth' : 'auto' })
      return { ok: true, scrolledTo: opts.selector, url: location.href }
    }
    const dy = Number(opts.dy) || (opts.toBottom ? document.documentElement.scrollHeight : 0)
    const dx = Number(opts.dx) || 0
    window.scrollBy({ left: dx, top: dy, behavior: opts.smooth ? 'smooth' : 'auto' })
    return { ok: true, x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, url: location.href }
  }

  /* ------------------------------ 结构化提取 ------------------------------ */

  function inPageExtract(args) {
    const opts = args || {}
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const qs = (sel) => qsa(sel)[0] || null
    const root = opts.selector ? qs(opts.selector) : (document.body || document.documentElement)
    if (!root) return { ok: false, errorCode: 'NOT_FOUND', error: '容器没找到: ' + (opts.selector || '(body)') }
    const fields = Array.isArray(opts.fields) ? opts.fields : []
    if (!fields.length) return { ok: false, errorCode: 'BAD_ARGS', error: 'extract 需要 fields：[{name, selector, attr?, all?, regex?, number?}]' }
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50))
    const cap = Number(opts.maxChars) === 0 || opts.fullValues ? 2000000 : Math.max(50, Math.min(200000, Number(opts.maxChars) || 2000))
    // items:'self' 表示容器自己（老实现只查后代，写 items:'tr' 在 tr 容器里会得到 0 行）。
    // 注意 selector 匹配到多个时要全部用上，不然 "self" 只拿到第一个。
    let containers
    if (!opts.items) containers = [root]
    else if (String(opts.items).toLowerCase() === 'self') {
      containers = opts.selector ? qsa(opts.selector).slice(0, limit) : [root]
    } else containers = Array.from(root.querySelectorAll(opts.items)).slice(0, limit)

    const rows = containers.map((item) => {
      const row = {}
      for (const f of fields) {
        if (!f || !f.name) continue
        const els = f.selector ? (String(f.selector).toLowerCase() === 'self' ? [item] : Array.from(item.querySelectorAll(f.selector))) : [item]
        const pick = (el) => {
          if (!el) return null
          if (f.attr) return el.getAttribute(f.attr)
          if (f.prop) return el[f.prop]
          return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
        }
        let values = els.map(pick).filter((v) => v != null && v !== '')
        if (f.regex) {
          let re = null
          try { re = new RegExp(f.regex) } catch { re = null }
          values = re ? values.map((v) => { const m = String(v).match(re); return m ? (m[1] ?? m[0]) : null }).filter((v) => v != null) : []
        }
        if (f.number) {
          values = values.map((v) => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null }).filter((v) => v != null)
        }
        const shaped = values.map((v) => {
          const s = typeof v === 'string' ? v : v
          if (typeof s !== 'string') return s
          return s.length > cap ? s.slice(0, cap) + '…（共 ' + s.length + ' 字）' : s
        })
        row[f.name] = f.all ? shaped : (shaped[0] ?? null)
      }
      return row
    })
    return { ok: true, count: rows.length, rows, url: location.href, title: document.title }
  }

  /* ------------------------------ 快照 ------------------------------ */

  function inPageSnapshot(args) {
    const opts = args || {}
    const maxChars = Math.max(1000, Math.min(2000000, Number(opts.maxChars) || 20000))
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    // 默认只收「可见帧」：隐藏 iframe（display:none）的正文不算当前页面，
    // 否则 diff 快照会因隐藏内容抖动产生假差异；allFrames:true 才全收。
    const visibleDocs = opts.allFrames === true ? docs : docs.filter((d) => {
      if (!d.frame) return true
      try {
        const rect = d.frame.getBoundingClientRect()
        const style = getComputedStyle(d.frame)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      } catch { return false }
    })
    const qsa = (sel) => { const acc = []; for (const d of visibleDocs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const text = visibleDocs.map((d) => String(d.doc.body ? d.doc.body.innerText : '')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    return {
      ok: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      textLength: text.length,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      frames: visibleDocs.length,
      skippedFrames: docs.length - visibleDocs.length,
      headings: qsa('h1,h2,h3').slice(0, 80).map((h) => ({ tag: h.tagName.toLowerCase(), text: String(h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) })),
      links: qsa('a[href]').slice(0, 200).map((a) => ({ text: String(a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100), href: a.href })),
      forms: qsa('form').slice(0, 30).map((f) => ({ action: f.action || '', method: (f.method || 'get').toLowerCase(), fields: f.querySelectorAll('input,textarea,select').length })),
      inputs: qsa('input,textarea,select').slice(0, 200).map((el) => ({
        tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
        placeholder: el.placeholder || '', value: el.type === 'password' ? '***' : String(el.value || '').slice(0, 120),
        checked: el.checked === true,
      })),
      buttons: qsa('button,[role="button"],input[type="submit"]').slice(0, 100).map((el) => ({
        text: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80), disabled: el.disabled === true,
      })),
    }
  }

  /* ------------------------ 交互元素清单（带 ref） ------------------------ */
  // 给模型一张「这页上有什么能点/能填」的清单，一行一个元素。
  // click/type/check 传 ref 就行，不用猜 CSS、不用先 query 再点——省 token，也少报错。
  function inPageOutline(args) {
    const opts = args || {}
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 120))
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const qs = (sel) => { for (const d of docs) { try { const el = d.doc.querySelector(sel); if (el) return el } catch { /* 非法选择器 */ } } return null }
    const SELECTOR = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
      '[contenteditable="true"]', '[onclick]',
    ].join(',')

    // 上一轮的 ref 先清掉：旧编号绝不能指向屏幕上的另一个元素（含同源 iframe）
    for (const old of qsa('[data-dsh-ref]')) old.removeAttribute('data-dsh-ref')

    const roleOf = (el) => {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') return 'link'
      if (tag === 'button') return 'button'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'input') {
        const t = String(el.type || 'text').toLowerCase()
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
        if (t === 'checkbox' || t === 'radio' || t === 'range' || t === 'file' || t === 'search') return t
        return 'textbox'
      }
      return tag
    }
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
      if (aria) return norm(aria)
      const svg = typeof el.querySelector === 'function' ? el.querySelector('svg') : null
      if (svg) {
        const title = svg.querySelector('title')
        if (title) return norm(title.innerText)
      }
      if (el.labels && el.labels.length) return norm(el.labels[0].innerText)
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const t = String(el.type || '').toLowerCase()
        return norm(el.placeholder || el.name || el.id || (t === 'submit' || t === 'button' ? el.value : ''))
      }
      return norm(el.innerText || el.textContent || el.value || el.title || el.name)
    }
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect()
      if (!(rect.width > 0 && rect.height > 0)) return false
      const style = window.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
      return true
    }

    // href 只留路径 + 参数名（URL 编码的中文 query 值没信息量）
    const shortHref = (raw, maxLen = 50) => {
      let href = String(raw == null ? '' : raw)
      try {
        const u = new URL(href, location.href)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '#'   // javascript: / mailto: 之类一律当 #
        href = u.host === location.host ? (u.pathname || '/') : (u.origin + u.pathname)
        const names = Array.from(u.searchParams.keys()).slice(0, 2)
        if (names.length) href += '?' + names.join('&')
      } catch { /* 非法 URL 原样 */ }
      return href.length > maxLen ? href.slice(0, maxLen - 1) + '…' : href
    }
    const scope = opts.selector ? qs(opts.selector) : null
    if (opts.selector && !scope) {
      return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个容器: ' + opts.selector + '（outline 的 selector 只看容器内部；整页就别传）' }
    }
    const all = scope ? Array.from(scope.querySelectorAll(SELECTOR)) : qsa(SELECTOR)
    const rows = []
    const scanned = []
    let skipped = 0
    let examined = 0
    let hiddenInCollapsed = 0
    const collapsedTriggers = []
    // 折叠菜单里的元素看不见也查不到：只统计数量 + 记下「该点哪个去展开」。
    // 2026-11-24 找「接口管理」时，它是二级菜单，outline 里完全没有，
    // 只能靠猜父菜单再点一次——多花了两轮。
    const isInsideCollapsed = (el) => {
      let node = el
      let depth = 0
      while (node && node.nodeType === 1 && depth++ < 8) {
        try {
          if (node.getAttribute && node.getAttribute('aria-expanded') === 'false') return true
          const cls = typeof node.className === 'string' ? node.className : ''
          if (cls && /(^|\s)(is-collapsed|collapsed|el-menu--collapse|ant-menu-inline-collapsed)(\s|$)/.test(cls)) return true
        } catch { /* 忽略怪节点 */ }
        node = node.parentElement
      }
      return false
    }
    const groups = new Map()
    // 本轮的同名计数（跨调用不累加，否则每个元素每次换指纹）
    window.__dshRefNth = new Map()

    for (const el of all) {
      if (rows.length >= limit) break
      if (++examined > 6000) break
      const tag = el.tagName.toLowerCase()
      const t = String(el.type || '').toLowerCase()
      if (tag === 'input' && t === 'hidden') { skipped++; continue }
      if (!isVisible(el)) {
        skipped++
        if (hiddenInCollapsed < 500 && isInsideCollapsed(el)) hiddenInCollapsed++
        continue
      }

      const role = roleOf(el)
      const name = norm(nameOf(el)) || '(无名称)'
      // 折叠菜单的开关：记下名字，回执里提示「先展开它再 outline」。
      // 只认「能展开东西的」：输入框（搜索框）也会挂 aria-expanded=false，别把它当菜单。
      try {
        const canExpand = el.getAttribute('aria-haspopup') != null
          || role === 'menuitem' || role === 'button'
          || /^(li|a|div|span)$/.test(tag)
        if (canExpand && tag !== 'input' && el.getAttribute('aria-expanded') === 'false'
          && collapsedTriggers.length < 6
          && !collapsedTriggers.some((x) => x.name === name)) {
          collapsedTriggers.push({ name: name.slice(0, 40), role })
        }
      } catch { /* 忽略 */ }
      // 导航菜单里 menuitem 和 link 常常是同一个入口（名字一样），只留更能点的那个
      if (role === 'menuitem' && name !== '(无名称)') {
        const better = qsa('a[href],button')
          .some((x) => norm(x.innerText || x.getAttribute('aria-label')) === name)
        if (better) { skipped++; continue }
      }
      // 基线记「所有可见交互元素」，不是「列出来的那几行」——否则折叠掉的那些
      // 在下一次 delta 里会被当成「新增」冒出来。
      scanned.push({ role, name })
      const parent = el.parentNode
      const groupKey = `${parent ? parent.tagName : 'body'}_${role}_${name}`
      const group = groups.get(groupKey) || 0
      if (group >= 3) {
        if (group === 3) {
           rows.push({ ref: null, collapsed: true, name: `...（另有同类元素，用 rowText 定位）` })
        }
        groups.set(groupKey, group + 1)
        continue
      }
      groups.set(groupKey, group + 1)

      const ref = (function () {
        // 稳定编号：同一元素（同 role+name+本轮第几个同名）跨调用保持同一个 ref。
        // 以前每次 outline 都从 e1 重排，模型手上旧 ref 一刷新就全变，只能再 outline 一次。
        const map = window.__dshRefIndex || (window.__dshRefIndex = {})
        let next = window.__dshRefNext || 1
        // 同名计数必须「本轮重来」：跨调用累加会让每个元素每次换指纹
        const nthMap = window.__dshRefNth
        const seenKey = `k:${role}|${name}`
        const nth = (nthMap.get(seenKey) || 0) + 1
        nthMap.set(seenKey, nth)
        const fp = `f:${role}|${name}|${nth}`
        if (!map[fp]) {
          map[fp] = 'e' + next++
          if (next > 999) { for (const k of Object.keys(map)) if (k.startsWith('f:')) delete map[k]; next = 1 }
          window.__dshRefNext = next
        }
        return map[fp]
      })()
      el.setAttribute('data-dsh-ref', ref)
      const row = { ref, role, name: name.slice(0, 100), tag }
      if (t === 'checkbox' || t === 'radio' || el.getAttribute('role') === 'switch') {
        row.checked = el.checked === true || el.getAttribute('aria-checked') === 'true'
      }
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') row.disabled = true
      if (tag === 'a') row.href = shortHref(el.getAttribute('href'))
      if (tag === 'textarea' || ['text', 'search', 'email', 'password', 'tel', 'url', 'number'].includes(t)) {
        row.valueLength = String(el.value == null ? '' : el.value).length
        if (row.valueLength && t !== 'password') row.value = norm(el.value).slice(0, 60)
      }
      rows.push(row)
    }
    return {
      ok: true,
      // 与上一次 outline（或传进来的 lastRef）比，页面变了什么——只给名字，不给编号，紧凑
      delta: (function () {
        // 传了 lastRef：按 ref 编号比（模型手上就是编号）
        if (Array.isArray(opts.lastRef) && opts.lastRef.length) {
          const curRefs = rows.filter((r) => r.ref).map((r) => r.ref)
          const added = curRefs.filter((ref) => !opts.lastRef.includes(ref))
          const removed = opts.lastRef.filter((ref) => !curRefs.includes(ref))
          window.__dshRefMap = scanned
          return {
            added: added.slice(0, 8).map((ref) => ({ ref })),
            removed: removed.slice(0, 8).map((ref) => ({ ref })),
            addedCount: added.length, removedCount: removed.length,
            changed: added.length > 0 || removed.length > 0,
          }
        }
        // 没传：跟上次 outline 的可见元素集比（按 role+name）
        const diff = diffRefs(window.__dshRefMap || [], scanned)
        window.__dshRefMap = scanned
        return diff
      })(),
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      total: all.length,
      shown: rows.length,
      skippedInvisible: skipped,
      hiddenInCollapsed,
      collapsedTriggers,
      truncated: all.length > rows.length + skipped,
      rows,
    }

    // 比两份元素清单（按 role+name 做多重集），返回紧凑差异
    function diffRefs(prev, cur) {
      const keyOf = (r) => (r.role || '') + '|' + (r.name || '')
      const pool = new Map()
      for (const r of prev || []) {
        const k = keyOf(r)
        pool.set(k, (pool.get(k) || 0) + 1)
      }
      const added = []
      const same = []
      for (const r of cur || []) {
        const k = keyOf(r)
        const left = pool.get(k) || 0
        if (left > 0) { pool.set(k, left - 1); same.push(r) }
        else added.push({ role: r.role, name: r.name })
      }
      const removed = []
      for (const [k, count] of pool) {
        for (let i = 0; i < count; i++) {
          const [role, name] = k.split('|')
          removed.push({ role, name })
        }
      }
      return {
        added: added.slice(0, 8),
        removed: removed.slice(0, 8),
        addedCount: added.length,
        removedCount: removed.length,
        unchanged: same.length,
        changed: added.length > 0 || removed.length > 0,
      }
    }
  }

  /* ------------------------ 动作后的增量 Diff ------------------------ */
  // click/type/check 之后调一次：只回「新增/消失了什么」，不重发整张清单。
  function inPageDelta(args) {
    const opts = args || {}
    const SELECTOR = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
      '[contenteditable="true"]', '[onclick]',
    ].join(',')
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return false
      const st = window.getComputedStyle(el)
      return !(st.visibility === 'hidden' || st.display === 'none')
    }
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
      if (aria) return norm(aria)
      const svg = typeof el.querySelector === 'function' ? el.querySelector('svg') : null
      if (svg) { const t = svg.querySelector('title'); if (t) return norm(t.innerText) }
      if (el.labels && el.labels.length) return norm(el.labels[0].innerText)
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const t = String(el.type || '').toLowerCase()
        return norm(el.placeholder || el.name || el.id || (t === 'submit' || t === 'button' ? el.value : ''))
      }
      return norm(el.innerText || el.textContent || el.value || el.title || el.name)
    }
    const cur = []
    let examined = 0
    // role 必须和 outline 的口径一致，否则 delta 会把每个元素都当成「变了」
    const roleOf = (el) => {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') return 'link'
      if (tag === 'button') return 'button'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'input') {
        const t = String(el.type || 'text').toLowerCase()
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
        if (t === 'checkbox' || t === 'radio' || t === 'range' || t === 'file' || t === 'search') return t
        return 'textbox'
      }
      return tag
    }
    // 和 outline 同一套去重规则：导航菜单里 menuitem 与同名 link/button 是同一个入口
    const betterNames = new Set(Array.from(document.querySelectorAll('a[href],button')).map((x) => (nameOf(x) || '').trim()))
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (cur.length >= 400 || ++examined > 3000) break
      if (!visible(el)) continue
      const role = roleOf(el)
      const name = (nameOf(el) || '(无名称)')   // 和 outline 的基线同样不截断，否则名字长度不同会被当成变了
      if (role === 'menuitem' && betterNames.has(name)) continue
      cur.push({ role, name })
    }
    const prev = window.__dshRefMap || []
    const diff = (function () {
      const keyOf = (r) => (r.role || '') + '|' + (r.name || '')
      const pool = new Map()
      for (const r of prev) { const k = keyOf(r); pool.set(k, (pool.get(k) || 0) + 1) }
      const added = []
      for (const r of cur) {
        const k = keyOf(r)
        const left = pool.get(k) || 0
        if (left > 0) pool.set(k, left - 1)
        else added.push(r)
      }
      const removed = []
      for (const [k, count] of pool) for (let i = 0; i < count; i++) { const [role, name] = k.split('|'); removed.push({ role, name }) }
      return { added, removed }
    })()
    // 基线跟着走到当前：下一次动作只报「在那之后的变化」
    window.__dshRefMap = cur
    return {
      ok: true,
      changed: diff.added.length > 0 || diff.removed.length > 0,
      added: diff.added.slice(0, 8),
      removed: diff.removed.slice(0, 8),
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
      url: location.href,
      title: document.title,
      ...(opts.full ? { total: cur.length } : {}),
    }
  }

  /* ------------------------------ 存储（local / session） ------------------------------ */

  // 内网系统把 token 塞在 localStorage 里很常见：读它比读 cookie 还常用。
  function inPageStorage(args) {
    const opts = args || {}
    const kind = String(opts.kind || 'local').toLowerCase() === 'session' ? 'session' : 'local'
    const store = kind === 'session' ? window.sessionStorage : window.localStorage
    if (!store) return { ok: false, errorCode: 'STORAGE_UNAVAILABLE', error: '这个页面拿不到 ' + kind + 'Storage' }
    const op = String(opts.op || 'list').toLowerCase()
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…（共 ' + s.length + ' 字）' : s }
    if (op === 'list') {
      const rows = []
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        const value = store.getItem(key) || ''
        rows.push({ key, valueLength: value.length, value: clip(value, Number(opts.maxChars) || 300) })
      }
      const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
      return { ok: true, kind, op, count: rows.length, rows: rows.slice(0, limit), url: location.href }
    }
    if (op === 'get') {
      if (!opts.key) return { ok: false, errorCode: 'BAD_ARGS', error: 'storage get 需要 key' }
      const value = store.getItem(String(opts.key))
      if (value == null) return { ok: true, kind, op, key: opts.key, found: false, url: location.href }
      return { ok: true, kind, op, key: opts.key, found: true, valueLength: value.length, value: clip(value, Number(opts.maxChars) || 2000), url: location.href }
    }
    if (op === 'set') {
      if (!opts.key) return { ok: false, errorCode: 'BAD_ARGS', error: 'storage set 需要 key' }
      store.setItem(String(opts.key), String(opts.value == null ? '' : opts.value))
      return { ok: true, kind, op, key: opts.key, valueLength: String(opts.value == null ? '' : opts.value).length, url: location.href }
    }
    if (op === 'remove') {
      if (!opts.key) return { ok: false, errorCode: 'BAD_ARGS', error: 'storage remove 需要 key' }
      store.removeItem(String(opts.key))
      return { ok: true, kind, op, key: opts.key, url: location.href }
    }
    if (op === 'clear') {
      const cleared = store.length
      store.clear()
      return { ok: true, kind, op, cleared, url: location.href }
    }
    return { ok: false, errorCode: 'BAD_ARGS', error: 'storage op 只能是 list / get / set / remove / clear' }
  }

  /* ------------------------------ 高亮（给人看，不动数据） ------------------------------ */

  function inPageHighlight(args) {
    const opts = args || {}
    const clearAll = () => {
      for (const node of Array.from(document.querySelectorAll('[data-dsh-highlight]'))) {
        const prev = node.getAttribute('data-dsh-highlight-prev')
        if (prev) node.setAttribute('style', prev)
        else node.removeAttribute('style')
        node.removeAttribute('data-dsh-highlight')
        node.removeAttribute('data-dsh-highlight-prev')
      }
    }
    if (opts.clear) { clearAll(); return { ok: true, cleared: true, url: location.href } }
    let el = null
    if (opts.ref) el = document.querySelector('[data-dsh-ref="' + String(opts.ref).replace(/["\\\s]/g, '') + '"]')
    else if (opts.selector) el = document.querySelector(opts.selector)
    if (!el) return { ok: false, errorCode: opts.ref ? 'REF_STALE' : 'NOT_FOUND', error: '没有可高亮的元素' }
    clearAll()
    el.setAttribute('data-dsh-highlight', '1')
    el.setAttribute('data-dsh-highlight-prev', el.getAttribute('style') || '')
    el.style.outline = (opts.color || '#ff2d55') + ' 3px solid'
    el.style.outlineOffset = '2px'
    el.scrollIntoView({ block: 'center', inline: 'center' })
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      url: location.href,
    }
  }

  /* ------------------------------ 登录 ------------------------------ */

  function inPageDetectLogin(args) {
    const pwd = document.querySelector('input[type="password"]')
    const userCandidates = Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter((el) => {
      const t = (el.type || '').toLowerCase()
      if (t === 'password' || t === 'submit' || t === 'button' || t === 'checkbox' || t === 'radio') return false
      const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete].join(' ').toLowerCase()
      return t === 'email' || /user|account|email|phone|mobile|login|name|账号|用户名|邮箱|手机/.test(hay)
    })
    const submit = document.querySelector('button[type="submit"],input[type="submit"],form button:not([type="button"])')
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    return {
      ok: true,
      url: location.href,
      title: document.title,
      hasPassword: Boolean(pwd),
      usernameField: userCandidates[0] ? { name: userCandidates[0].name, id: userCandidates[0].id, type: userCandidates[0].type, placeholder: userCandidates[0].placeholder } : null,
      passwordField: pwd ? { name: pwd.name, id: pwd.id, placeholder: pwd.placeholder } : null,
      submitButton: submit ? norm(submit.innerText || submit.value) : null,
      looksLikeLogin: Boolean(pwd) || /login|signin|sign-in|登录|登入|账号/i.test(location.href + ' ' + document.title),
      hints: Array.from(document.querySelectorAll('input:not([type="hidden"])')).slice(0, 12).map((el) => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, autocomplete: el.autocomplete })),
    }
  }

  function inPageFillLogin(args) {
    const opts = args || {}
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
    const labelOf = (node) => {
      if (node.labels && node.labels.length) return String(node.labels[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const wrapping = node.closest && node.closest('label')
      if (wrapping) return String(wrapping.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      return node.getAttribute('aria-label') || ''
    }
    const pick = (selector, hintRe, typeRe) => {
      if (selector) {
        const el = document.querySelector(selector)
        if (el) return el
      }
      const fields = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
      let best = null
      for (const el of fields) {
        const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete, el.type].map(norm).join(' ')
        let score = 0
        if (typeRe.test(el.type || '')) score += 40
        if (hintRe.test(hay)) score += 60
        const label = el.labels && el.labels[0] ? norm(el.labels[0].innerText) : ''
        if (hintRe.test(label)) score += 30
        if (score > (best ? best.score : 0)) best = { el, score }
      }
      return best && best.score >= 40 ? best.el : null
    }
    const userEl = pick(opts.userSelector, /user|account|email|phone|mobile|login|账号|用户名|邮箱|手机|id/i, /^(email|text|tel|number|search|)$/i)
    const passEl = pick(opts.passSelector, /pass|pwd|password|密码/i, /^password$/i)
    if (opts.dryRun) {
      return {
        ok: true, dryRun: true,
        wouldFill: { username: opts.username != null, password: opts.password != null },
        userField: userEl ? { name: userEl.name, id: userEl.id, type: userEl.type, label: labelOf(userEl) } : null,
        passField: passEl ? { name: passEl.name, id: passEl.id, label: labelOf(passEl) } : null,
        wouldSubmit: opts.submit !== false, url: location.href,
      }
    }
    const fill = (el, value) => {
      el.scrollIntoView({ block: 'center' })
      el.focus({ preventScroll: true })
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, String(value))
      else el.value = String(value)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (opts.username != null) {
      if (!userEl) return { ok: false, errorCode: 'NOT_FOUND', error: '找不到账号输入框' }
      fill(userEl, opts.username)
    }
    if (opts.password != null) {
      if (!passEl) return { ok: false, errorCode: 'NOT_FOUND', error: '找不到密码输入框' }
      fill(passEl, opts.password)
    }
    let submitted = null
    if (opts.submit !== false) {
      const form = passEl && passEl.form ? passEl.form : (passEl ? passEl.closest('form') : null)
      const btn = opts.submitSelector ? document.querySelector(opts.submitSelector) : (form ? form.querySelector('button[type="submit"],input[type="submit"]') : null)
      if (btn) { btn.click(); submitted = 'button' }
      else if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = 'form.requestSubmit' }
      else if (passEl) {
        passEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }))
        submitted = 'enter'
      }
    }
    return {
      ok: true,
      filled: { username: opts.username != null, password: opts.password != null },
      userField: userEl ? { name: userEl.name, id: userEl.id, type: userEl.type } : null,
      passField: passEl ? { name: passEl.name, id: passEl.id } : null,
      submitted,
      url: location.href,
    }
  }

  /* ------------------------------ 聚焦（真实按键之前用） ------------------------------ */

  function inPageFocus(args) {
    const opts = args || {}
    const refSel = '[data-dsh-ref="' + String(opts.ref || '').replace(/["\\\s]/g, '') + '"]'
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qs = (sel) => { for (const d of docs) { try { const el = d.doc.querySelector(sel); if (el) return el } catch { /* 非法选择器 */ } } return null }
    let el = null
    if (opts.ref) el = qs(refSel)
    else if (opts.selector) el = qs(opts.selector)
    if (!el) {
      return {
        ok: false,
        errorCode: opts.ref ? 'REF_STALE' : 'NOT_FOUND',
        error: opts.ref ? 'ref ' + opts.ref + ' 找不到，重新 outline' : '没有这个元素: ' + (opts.selector || ''),
      }
    }
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.focus({ preventScroll: true })
    return {
      ok: true,
      focused: {
        tag: el.tagName.toLowerCase(), name: el.name || '', id: el.id || '',
        active: document.activeElement === el,
      },
      url: location.href,
    }
  }

  /* ------------------------------ 元素位置（截图裁剪用） ------------------------------ */

  function inPageRect(args) {
    const opts = args || {}
    if (!opts.selector && !opts.ref) return { ok: false, errorCode: 'BAD_ARGS', error: 'rect 需要 selector 或 ref' }
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const qsa = (sel) => { const acc = []; for (const d of docs) { try { for (const el of d.doc.querySelectorAll(sel)) acc.push(el) } catch { /* 非法选择器 */ } } return acc }
    const qs = (sel) => qsa(sel)[0] || null
    let el = null
    if (opts.ref) {
      el = qs('[data-dsh-ref="' + String(opts.ref).replace(/["\\\s]/g, '') + '"]')
      if (!el) return { ok: false, errorCode: 'REF_STALE', error: 'ref ' + opts.ref + ' 找不到，重新 outline' }
    } else {
      const nodes = qsa(opts.selector)
      el = nodes[Math.max(0, Number(opts.index) || 0)]
      if (!el) return { ok: false, errorCode: 'NOT_FOUND', error: '没有这个元素: ' + opts.selector }
    }
    if (opts.scroll !== false) el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return {
      ok: true,
      x: r.x, y: r.y, width: r.width, height: r.height,
      // CDP 截图的 clip 要的是「文档坐标」（含滚动），不是视口坐标
      pageX: r.x + window.scrollX, pageY: r.y + window.scrollY,
      scrollX: window.scrollX, scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      url: location.href,
    }
  }

  /* ------------------------------ 视口（整屏截图用） ------------------------------ */

  function inPageViewport() {
    return {
      ok: true,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      url: location.href,
    }
  }

  /* ------------------------------ 环境自检 ------------------------------ */

  function inPageDiag(args) {
    // 这个函数跑在 content script（ISOLATED world）里，所以探到的是扩展 CSP。
    // MAIN world 的能力由 executor 侧另外注入一次来探。
    let isolatedEval = 'ok'
    let isolatedError = ''
    try {
      // eslint-disable-next-line no-new-func
      const probe = new Function('return 1 + 1')
      if (probe() !== 2) isolatedEval = 'BROKEN'
    } catch (error) {
      isolatedEval = 'CSP_BLOCKED'
      isolatedError = String((error && error.message) || error)
    }
    return {
      ok: true,
      pageVersion: PAGE_VERSION,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      eval: { isolated: isolatedEval, isolatedError },
      frames: window.frames ? window.frames.length : 0,
      sameOriginFrames: (globalThis.__dshScope ? globalThis.__dshScope.frames() : []).length,
      hasBody: Boolean(document.body),
      elementCount: document.getElementsByTagName('*').length,
      activeElement: (document.activeElement && document.activeElement.tagName) || '',
    }
  }

  /* ------------------------------ 请求拦截（只登记 / 不发） ------------------------------
   * 生产环境排查时最怕「为了看请求，把数据写进去了」。netBlock 在页面世界里包一层
   * fetch / XHR：命中规则的请求只登记、不发给服务器（mode=block），或照发但登记
   * （mode=log）。dryRun=true 时连规则都不用写：所有非 GET/HEAD/OPTIONS 都拦。
   *
   * 状态挂在 window.__dshNetBlock，刷新页面即清；必须注入到「真正发请求的那一帧」。
   * 注意：这是页面世界里的一层包装，绕过 fetch/XHR 的请求（sendBeacon、WebSocket）
   * 拦不到，命中后会明确回 blocked:true，不会假装成功。
   */
  function inPageNetBlock(args) {
    const opts = args || {}
    const op = String(opts.op || 'set')
    const state = window.__dshNetBlock || (window.__dshNetBlock = {
      rules: [], mode: 'block', dryRun: false, hits: [], installed: false, installedAt: 0,
    })
    const clip = (s, n) => {
      s = String(s == null ? '' : s)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    const bodyOf = (body) => {
      try {
        if (body == null) return ''
        if (typeof body === 'string') return clip(body, 2000)
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return clip(body.toString(), 2000)
        if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]'
        if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' bytes]'
        return clip(String(body), 2000)
      } catch { return '' }
    }
    const matches = (method, url) => {
      const m = String(method || 'GET').toUpperCase()
      const u = String(url || '')
      if (state.dryRun) return !(m === 'GET' || m === 'HEAD' || m === 'OPTIONS')
      const rules = state.rules || []
      for (const rule of rules) {
        try { rule.lastIndex = 0; if (rule.test(u)) return true } catch { /* 坏正则跳过 */ }
      }
      return false
    }
    const record = (via, method, url, body) => {
      const row = { ts: Date.now(), via, method: String(method || '').toUpperCase(), url: clip(url, 500), body: bodyOf(body) }
      state.hits.push(row)
      if (state.hits.length > 100) state.hits.splice(0, state.hits.length - 100)
      return row
    }
    const install = () => {
      if (state.installed) return
      state.installed = true
      state.installedAt = Date.now()
      const origFetch = window.fetch
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : ((input && input.url) || '')
          const method = (init && init.method) || (input && input.method) || 'GET'
          if (matches(method, url)) {
            const row = record('fetch', method, url, init && init.body)
            if (state.mode !== 'log') {
              row.blocked = true
              return Promise.reject(new TypeError('Failed to fetch（被 DSH netBlock 拦下，未发往服务器）'))
            }
          }
          return origFetch.apply(this, arguments)
        }
      }
      const X = window.XMLHttpRequest
      if (X && X.prototype && typeof X.prototype.send === 'function') {
        const origOpen = X.prototype.open
        const origSend = X.prototype.send
        X.prototype.open = function (method, url) {
          try { this.__dshNetReq = { method, url } } catch { /* 只读对象也能用 */ }
          return origOpen.apply(this, arguments)
        }
        X.prototype.send = function (body) {
          const req = this.__dshNetReq || {}
          if (matches(req.method, req.url)) {
            const row = record('xhr', req.method, req.url, body)
            if (state.mode !== 'log') {
              row.blocked = true
              // 不能只是不发：XHR 永远不结束会把调用方挂死。派发 error + loadend，
              // 状态码保持 0，axios 之类会当成 Network Error 正常走失败分支。
              const xhr = this
              setTimeout(() => {
                try { xhr.dispatchEvent(new Event('error')) } catch { /* 老浏览器 */ }
                try { xhr.dispatchEvent(new ProgressEvent('loadend')) } catch { /* 没有 ProgressEvent 就算了 */ }
              }, 0)
              return
            }
          }
          return origSend.apply(this, arguments)
        }
      }
    }

    if (op === 'hits' || op === 'get') {
      return {
        ok: true, op: 'hits', mode: state.mode, dryRun: state.dryRun, installed: state.installed,
        total: state.hits.length, hits: state.hits.slice(-Math.max(1, Math.min(60, Number(opts.limit) || 20))),
        rules: (state.rules || []).map((r) => String(r)),
      }
    }
    if (op === 'clear') {
      const n = state.hits.length
      state.hits.length = 0
      return { ok: true, op: 'clear', cleared: n, mode: state.mode, dryRun: state.dryRun }
    }
    if (op === 'off') {
      const n = state.hits.length
      state.rules = []
      state.dryRun = false
      state.hits.length = 0
      return { ok: true, op: 'off', cleared: n, installed: state.installed, note: '已清空规则：包装还在，但不再拦任何请求（刷新页面可彻底移除）。' }
    }

    // op === 'set'
    const patterns = Array.isArray(opts.patterns) ? opts.patterns.filter((x) => String(x || '').trim()) : []
    const dryRun = opts.dryRun === true
    if (!patterns.length && !dryRun) {
      return { ok: false, errorCode: 'BAD_ARGS', error: 'netBlock 需要 patterns（URL 正则数组），或者传 dryRun:true 拦所有写请求' }
    }
    state.mode = String(opts.blockMode || 'block') === 'log' ? 'log' : 'block'
    state.dryRun = dryRun
    state.rules = patterns.map((p) => new RegExp(String(p), 'i'))
    install()
    return {
      ok: true, op: 'set', mode: state.mode, dryRun: state.dryRun,
      rules: state.rules.map((r) => String(r)), installedAt: state.installedAt,
      note: state.mode === 'block'
        ? '命中规则的请求只登记、不发送；用 op:"hits" 取记录，op:"off" 解除。'
        : '命中规则的请求照常发送，只登记；用 op:"hits" 取记录。',
    }
  }

  /* ------------------------------ iframe 清单 ------------------------------ */

  function inPageFrames(args) {
    const S = globalThis.__dshScope
    const frames = S ? S.frames() : []
    const topText = String((document.body && document.body.innerText) || '')
    return {
      ok: true,
      url: location.href,
      title: document.title,
      top: { textLength: topText.length, title: document.title },
      frames,
      hint: frames.length
        ? 'read/query/click/check/type 已经会自动跨这些同源 iframe；要精确指定就用 action=frames 查到的 frameId 传 frame 参数。'
        : '没有同源 iframe（跨域帧点不到，只能看 executor 的 frames 动作列出的帧表）。',
    }
  }

  /* ------------------------------ 表格行清单 ------------------------------ */

  function inPageRows(args) {
    const opts = args || {}
    // 大表格按行定位：outline 会折叠成「另有同类元素」，这里一行一条，带 ref + 勾选态。
    const S = globalThis.__dshScope
    const docs = S ? S.docs() : [{ doc: document, frame: null }]
    const limit = Math.max(1, Math.min(300, Number(opts.limit) || 40))
    const inSel = opts.in || 'tbody tr, tr, [role="row"]'
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    const rows = []
    for (const item of docs) {
      let list = []
      try { list = Array.from(item.doc.querySelectorAll(inSel)) } catch { list = [] }
      for (const row of list) {
        if (rows.length >= limit) break
        const text = norm(row.innerText || row.textContent)
        if (!text) continue
        const cells = Array.from(row.querySelectorAll('td,th')).map((c) => norm(c.innerText).slice(0, 80)).slice(0, 12)
        const box = row.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"]')
        const ref = 'r' + rows.length
        try { row.setAttribute('data-dsh-ref', ref) } catch { /* 设不上就退化成文本定位 */ }
        rows.push({
          ref,
          text: text.slice(0, 220),
          cells,
          hasCheckbox: Boolean(box),
          checked: box ? (box.checked === true || box.getAttribute('aria-checked') === 'true') : null,
          frame: item.frame ? String(item.frame.id || item.frame.src || 'iframe').slice(0, 100) : '',
        })
      }
    }
    return { ok: true, count: rows.length, rows, in: inSel, url: location.href, title: document.title }
  }

  globalThis.__dshPage = {
    VERSION: PAGE_VERSION,
    inPageRead, inPageQuery, inPageClick, inPageType, inPageSelect, inPageCheck,
    inPageIsChecked, inPageValue, inPageEval, inPageAbort, inPageWait, inPageScroll,
    inPageExtract, inPageSnapshot, inPageDetectLogin, inPageFillLogin, inPageDiag, inPageRect, inPageFocus, inPageViewport,
    inPageStorage, inPageHighlight, inPageDelta, inPageOutline, inPageFrames, inPageRows, inPageNetBlock,
    inPageReplay, inPageFetch,
  }
})()
