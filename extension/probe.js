/**
 * probe.js —— 页面世界的「黑匣子」（1.9.0）。
 *
 * 为什么需要它：CDP 只能看到「挂上之后」的请求和 console。用户点了一下报错、
 * 再来问「为什么」，那时 CDP 还没挂，什么证据都没有。这个脚本在 document_start
 * 用 MAIN world 注入，hook fetch / XHR / console，把最近 200 条留在
 * window.__dshProbe 里；executor 的 networkLog / logs 在 CDP 缓冲为空（或不全）时
 * 通过 MAIN 世界读它补齐历史。
 *
 * 记录内容：方法/URL/状态/耗时/请求体（截断）/请求头（脱敏）/日志文本；**不记响应体**，
 * 避免把页面数据常驻在内存里；也不改页面行为，调用原函数。
 *
 * 请求体为什么要记（2026-11-21 加）：排查「保存了但没生效」时，第一问题永远是
 * 「到底提交了什么」，此前只能自己 patch XHR 去抓。只存前 BODY_MAX 字符（默认
 * 1200），超过截断并标 truncated；FormData/Blob 只记类型和大小，不读文件内容。
 * 想关掉：在页面里设 window.__dshProbeBodyLimit = 0。
 *
 * 请求头为什么要记（1.11.1 加，2026-11-21 排查 LIMS 检验报告子表）：那次结论完全
 * 由请求头决定——`moduleCode` / `X-Function-Code` 在，后端才挂数据权限；不在就返回
 * 全量。探针只记请求体，CDP 又只在挂上之后才有，于是「为什么同一个接口我调有数据、
 * 页面调没数据」绕了十几轮。现在头也存，但**凭据一律不落地**：authorization / cookie
 * 这类直接丢，Bearer 和 JWT 形状的值打成 ***。
 * 想关掉：在页面里设 window.__dshProbeHeaderLimit = 0。
 */
;(function () {
  'use strict'
  if (typeof window === 'undefined' || window.__dshProbe) return

  const MAX = 200
  const net = []
  const con = []
  const push = (arr, row) => {
    arr.push(row)
    if (arr.length > MAX) arr.splice(0, arr.length - MAX)
  }
  const clip = (s, n) => {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }
  const abs = (u) => {
    try { return new URL(String(u || ''), location.href).href } catch { return String(u || '') }
  }
  // 请求体预览：只截断保存，绝不解析业务语义；文件内容一律不读。
  const bodyLimit = () => {
    const v = Number(window.__dshProbeBodyLimit)
    return Number.isFinite(v) ? Math.max(0, Math.min(20000, v)) : 1200
  }
  const bodyText = (body) => {
    const max = bodyLimit()
    if (!max || body == null) return null
    try {
      const wrap = (text, rawLen, extra) => Object.assign({ text: clip(text, max), rawLen, truncated: String(text).length > max }, extra || {})
      if (typeof body === 'string') return wrap(body, body.length)
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        const s = body.toString()
        return wrap(s, s.length)
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = []
        let n = 0
        try {
          for (const pair of body.entries()) {
            const [k, v] = pair
            const val = typeof v === 'string' ? v : '[file:' + String((v && v.name) || '?') + ']'
            parts.push(k + '=' + val)
            if (++n >= 20) break
          }
        } catch { /* 老浏览器没有 entries */ }
        const s = '[FormData] ' + parts.join('&')
        return wrap(s, s.length, { form: true })
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return { text: '[Blob ' + body.size + ' bytes]', rawLen: body.size, truncated: false, blob: true }
      if (typeof Document !== 'undefined' && body instanceof Document) return { text: '[Document]', rawLen: 0, truncated: false }
      if (typeof body === 'object') return { text: '[object ' + String((body.constructor && body.constructor.name) || '?') + ']', rawLen: 0, truncated: false }
      return wrap(String(body), String(body).length)
    } catch { return null }
  }
  // 行里只放非空字段：大多数请求没有 body，别让每条记录都多三个空键。
  const bodyFields = (info) => {
    if (!info || !info.text) return {}
    const out = { body: info.text, bodyLen: info.rawLen }
    if (info.truncated) out.bodyTruncated = true
    if (info.form) out.bodyKind = 'form'
    if (info.blob) out.bodyKind = 'blob'
    return out
  }

  /* 请求头：只留「看得懂这次调用」的部分，凭据绝不落地。
     - 名字命中 DROP 的直接丢（authorization / cookie / set-cookie / proxy-*）
     - 值像 Bearer / JWT 的，不管叫什么名字都打成 ***
     - 最多 20 个、每个截 120 字，别把长 token 常驻内存 */
  const H_MAX = 120
  const H_COUNT = 20
  const H_DROP = /^(authorization|proxy-authorization|cookie|set-cookie)$/i
  const H_SECRET = /^bearer\s/i
  const looksSecret = (v) => H_SECRET.test(v) || /^ey[a-z0-9_-]{8,}\./i.test(v)
  const headerLimit = () => {
    const v = Number(window.__dshProbeHeaderLimit)
    return Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : H_COUNT
  }
  const putHeader = (into, name, value) => {
    const n = String(name == null ? '' : name).trim()
    if (!n || H_DROP.test(n)) return
    if (Object.keys(into).length >= headerLimit()) return
    const v = String(value == null ? '' : value)
    into[n] = looksSecret(v) ? '***（凭据，已脱敏）' : clip(v, H_MAX)
  }
  /** 把 fetch 的 init.headers / Request.headers 摊平成普通对象。 */
  const headersOf = (input, init) => {
    const out = {}
    try {
      const source = (init && init.headers) || (input && input.headers) || null
      if (!source) return out
      if (typeof source.forEach === 'function' && !Array.isArray(source)) source.forEach((v, k) => putHeader(out, k, v))
      else if (Array.isArray(source)) source.forEach((pair) => putHeader(out, pair && pair[0], pair && pair[1]))
      else if (typeof source === 'object') Object.keys(source).forEach((k) => putHeader(out, k, source[k]))
    } catch { /* 拿不到头不影响请求 */ }
    return out
  }
  const headerFields = (h) => (h && Object.keys(h).length ? { headers: h } : {})

  // fetch
  const origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const started = Date.now()
      const url = abs(typeof input === 'string' ? input : (input && input.url) || '')
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      const reqBody = bodyFields(bodyText(init && init.body))
      const reqHead = headerFields(headersOf(input, init))
      let p
      try {
        p = origFetch.apply(this, arguments)
      } catch (e) {
        push(net, Object.assign({ ts: started, ms: 0, method, url: clip(url, 500), status: null, failed: String((e && e.message) || e), type: 'fetch', via: 'probe' }, reqHead, reqBody))
        throw e
      }
      p.then(
        (res) => {
          let mime = ''
          let len = 0
          try { mime = res.headers.get('content-type') || '' } catch { /* 拿不到就算了 */ }
          try { len = Number(res.headers.get('content-length')) || 0 } catch { /* 拿不到就算了 */ }
          push(net, Object.assign({ ts: started, ms: Date.now() - started, method, url: clip(url, 500), status: res.status, type: 'fetch', via: 'probe', mime: clip(mime, 80), length: len }, reqHead, reqBody))
        },
        (err) => push(net, Object.assign({ ts: started, ms: Date.now() - started, method, url: clip(url, 500), status: null, failed: String((err && err.message) || err), type: 'fetch', via: 'probe' }, reqHead, reqBody)),
      )
      return p
    }
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
    const origOpen = XMLHttpRequest.prototype.open
    const origSend = XMLHttpRequest.prototype.send
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__dshProbeReq = { method: String(method || 'GET').toUpperCase(), url: abs(url), started: Date.now() } } catch { /* ignore */ }
      return origOpen.apply(this, arguments)
    }
    // XHR 的头只能一个个 setRequestHeader 攒，open 之后才能记
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        const info = this.__dshProbeReq
        if (info) {
          info.headers = info.headers || {}
          putHeader(info.headers, name, value)
        }
      } catch { /* ignore */ }
      return origSetHeader.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function (body) {
      const info = this.__dshProbeReq
      if (info) {
        // 请求体在 send 时就抓：等 loadend 再读 this.body 已经拿不到了。
        info.body = bodyFields(bodyText(body))
        const done = () => {
          let status = null
          let mime = ''
          let len = 0
          try { status = this.status || null } catch { status = null }
          try { mime = (this.getResponseHeader && this.getResponseHeader('content-type')) || '' } catch { mime = '' }
          try { len = Number((this.getResponseHeader && this.getResponseHeader('content-length')) || 0) } catch { len = 0 }
          push(net, Object.assign({
            ts: info.started, ms: Date.now() - info.started, method: info.method,
            url: clip(info.url, 500), status, type: 'xhr', via: 'probe',
            mime: clip(mime, 80), length: len,
            failed: status ? '' : 'network-error',
          }, headerFields(info.headers), info.body || {}))
        }
        try { this.addEventListener('loadend', done) } catch { /* 老浏览器没有 loadend 就算了 */ }
      }
      return origSend.apply(this, arguments)
    }
  }

  // console
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level]
    if (typeof orig !== 'function') continue
    console[level] = function () {
      try {
        const text = Array.from(arguments).map((a) => {
          if (typeof a === 'string') return a
          if (a instanceof Error) return a.message
          try { return JSON.stringify(a) } catch { return String(a) }
        }).join(' ')
        push(con, { ts: Date.now(), level: level === 'log' ? 'log' : level, text: clip(text, 1000), via: 'probe' })
      } catch { /* 记日志不能影响页面 */ }
      return orig.apply(this, arguments)
    }
  }

  // 捕获未处理异常：用户看到的「报错」很多时候只在这里
  window.addEventListener('error', (e) => {
    try {
      push(con, { ts: Date.now(), level: 'error', text: clip('未捕获异常: ' + ((e && e.message) || '') + ' @ ' + ((e && e.filename) || ''), 1000), via: 'probe' })
    } catch { /* ignore */ }
  })
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e && e.reason
      push(con, { ts: Date.now(), level: 'error', text: clip('未处理的 Promise 拒绝: ' + ((r && (r.message || r)) || ''), 1000), via: 'probe' })
    } catch { /* ignore */ }
  })

  window.__dshProbe = { net, con, version: 3, startedAt: Date.now() }
})()
