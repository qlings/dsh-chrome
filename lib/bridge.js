/**
 * bridge.js —— DSH 侧和 Chrome 扩展之间的本地桥。
 *
 * 为什么是 HTTP 长轮询，不是 WebSocket：
 *   MV3 的 service worker 30 秒空闲就被杀。WebSocket 能续命，但服务端要自己
 *   实现 RFC6455 帧解析（Node 只内置客户端，没有 server），一个 bug 就断线。
 *   长轮询用扩展侧的 fetch 挂起 25 秒，fetch 在途本身就是扩展活动，SW 不会
 *   被回收；桥这边就是普通 http server，零依赖、可单测。
 *
 * 协议（全部 JSON）：
 *   POST /hello              扩展报到，{extId, version}
 *   GET  /poll?ext=&wait=25  取一条命令；没有就挂起，超时返回 {cmd:null}
 *   POST /result             回传执行结果 {cmdId, ok, data, error, ms}
 *   GET  /status             给人和自检看：连没连上、队列多长、最后活动
 *   POST /cmd                外部直接塞一条命令（调试用）
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_PORT = 18765
const MAX_WAIT_MS = 12000
// 扩展每 10 秒轮询一次；超过这个时间没动静就认为 SW 被回收了，别假装还连着。
const STALE_MS = 45000

/**
 * 进程级的在册桥：插件热重载（bundle 关→开）时模块会被重新 import，
 * 模块作用域里的变量会重置，但 globalThis 不会。上一实例没来得及 stop 的桥
 * 就是「僵尸桥」——它还占着 18765，扩展继续轮询它，新实例被挤到 18766，
 * 于是工具说「扩展未连接」（2026-11-25 连着两次热重载踩到）。
 */
const LIVE_BRIDGES = (globalThis.__dshChromeLiveBridges ||= new Map())

export class Bridge {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', logger = null, version = '1.0.0' } = {}) {
    this.port = port
    this.host = host
    this.logger = logger
    this.version = version
    this.server = null
    this.startedAt = Date.now()
    this.queue = []                 // 待发命令
    this.waiters = []               // 挂起的 poll（每个扩展一条）
    this.inflight = new Map()       // cmdId -> {resolve, reject, timer, startedAt}
    this.lastPollAt = 0
    this.lastResultAt = 0
    this.lastHelloAt = 0
    this.lastError = null
    this.ext = { id: '', version: '' }
    this.traces = []   // 扩展上报的执行轨迹，诊断「命令去哪了」用
    this.seq = 0
    this.sweeper = null
    this.token = null            // 只有存在 ~/.dsh/chrome/bridge.token 时才启用 /cmd 鉴权
    this.droppedCount = 0        // 因为扩展掉线被直接判死的命令数
  }

  async start() {
    if (this.server) return this.info()
    // 先把上一实例留下的桥停掉：不然扩展还挂在旧端口上，新实例只能往后挪，
    // 表现就是「桥起来了但扩展未连接」。
    for (const [port, other] of [...LIVE_BRIDGES]) {
      if (other === this) continue
      try {
        await other.stop()
        this.logger?.warn?.(`[dsh-chrome] 已停掉上一实例留在 ${port} 的桥`)
      } catch { /* 停不掉就让它继续占着，下面按端口顺延 */ }
      LIVE_BRIDGES.delete(port)
    }
    // 端口被非本进程的旧实例占着时往后挪。
    // 扩展侧按 /status 的 version 认桥，认不到就继续试下一个端口。
    const candidates = [this.port]
    for (let i = 1; i <= 4; i++) candidates.push(this.port + i)
    let lastError = null
    for (const port of candidates) {
      const server = this.#createServer()
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { server.removeListener('listening', onListening); reject(error) }
          const onListening = () => { server.removeListener('error', onError); resolve() }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, this.host)
        })
        this.server = server
        this.port = port
        LIVE_BRIDGES.set(port, this)
        this.logger?.info?.(`[dsh-chrome] 桥已启动 http://${this.host}:${this.port}`)
        await this.#loadToken()
        this.#startSweeper()
        return this.info()
      } catch (error) {
        lastError = error
        try { server.close() } catch { /* 没起来 */ }
        if (error.code !== 'EADDRINUSE') break
        this.logger?.warn?.(`[dsh-chrome] 端口 ${port} 被占用，试下一个`)
      }
    }
    throw lastError || new Error('桥没能启动')
  }

  #createServer() {
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.lastError = String(error && error.message || error)
        this.#json(res, 500, { ok: false, error: this.lastError })
      })
    })
    server.keepAliveTimeout = 65000
    return server
  }

  async stop() {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null }
    for (const waiter of this.waiters.splice(0)) {
      this.#json(waiter.res, 200, { ok: true, cmd: null })
    }
    for (const [cmdId, slot] of this.inflight) {
      clearTimeout(slot.timer)
      slot.reject(new Error('桥已关闭，命令未完成'))
      this.inflight.delete(cmdId)
    }
    this.queue.length = 0
    if (!this.server) return
    const server = this.server
    const port = this.port
    this.server = null
    if (LIVE_BRIDGES.get(port) === this) LIVE_BRIDGES.delete(port)
    // keep-alive 连接会让 server.close 一直等下去，热重载时端口就释放不掉。
    // 先掐掉所有连接，close 才会立刻回调（Node 18.2+ 有 closeAllConnections）。
    try { server.closeAllConnections?.() } catch { /* 老 Node 没有就算了 */ }
    await new Promise((resolve) => server.close(() => resolve()))
    this.logger?.info?.('[dsh-chrome] 桥已关闭')
  }

  info() {
    const idleFor = this.lastPollAt ? Date.now() - this.lastPollAt : Infinity
    const connected = this.waiters.length > 0 && idleFor < STALE_MS
    let hint = ''
    if (!connected) {
      hint = idleFor > STALE_MS
        ? (this.lastPollAt
          // 1.11.1：以前一口咬定「Chrome 被关了/崩了」，但实测最常见的是 MV3 的
          // Service Worker 被回收（大结果、长时间 eval 之后），Chrome 好端端的，
          // 半分钟到一分钟后自己就回来了。两种情况的处置完全不同，别再误导。
          ? `扩展 ${Math.round(idleFor / 1000)} 秒没轮询。两种情况：① 扩展的 Service Worker 被 Chrome 回收了（最常见，尤其是刚跑过大结果 eval / 长时间任务）——Chrome 还在，点一下扩展图标「重连」，或随便刷新一个标签页就能把它唤醒，通常几十秒内自己也会恢复；② Chrome 真的被关了或崩了——先看 chrome.exe 在不在。`
          : '扩展还没连上过：确认扩展已启用，并点扩展图标看是否「已连上 DSH」。')
        : '扩展在但没挂着轮询：可能正卡在上一条命令里。'
    }
    return {
      ok: true,
      bridge: 'dsh-chrome',
      version: this.version,
      running: Boolean(this.server?.listening),
      url: `http://${this.host}:${this.port}`,
      port: this.port,
      startedAt: this.startedAt,
      connected,
      waitingPolls: this.waiters.length,
      queued: this.queue.length,
      inflight: this.inflight.size,
      lastPollAt: this.lastPollAt,
      lastResultAt: this.lastResultAt,
      lastHelloAt: this.lastHelloAt,
      idleFor: Number.isFinite(idleFor) ? idleFor : null,
      droppedCount: this.droppedCount,
      tokenRequired: Boolean(this.token),
      hint,
      ext: this.ext,
      lastError: this.lastError,
      traces: this.traces.slice(-15),
    }
  }

  /** 给工具层用：发一条命令并等扩展执行完。 */
  call(action, params = {}, { timeoutMs = 30000, retryMs = 6000 } = {}) {
    if (!this.server?.listening) return Promise.reject(new Error('桥还没启动'))
    // 扩展已经很久没轮询：这条命令根本投不出去，别让调用方陪着等超时
    const idleFor = this.lastPollAt ? Date.now() - this.lastPollAt : Infinity
    if (idleFor > STALE_MS) {
      this.#dropQueue()
      return Promise.reject(this.#offlineError(idleFor))
    }
    const id = `c${Date.now().toString(36)}-${(++this.seq).toString(36)}-${randomUUID().slice(0, 6)}`
    const cmd = { id, action, params, ts: Date.now() }
    return new Promise((resolve, reject) => {
      const slot = {
        resolve, reject, cmd,
        startedAt: Date.now(),
        deadline: Date.now() + timeoutMs,
        attempts: 0,
        timer: null,
      }
      this.inflight.set(id, slot)
      this.queue.push(cmd)
      this.#flush()
      const arm = () => {
        slot.timer = setTimeout(() => {
          if (this.inflight.get(id) !== slot) return
          if (Date.now() >= slot.deadline) {
            this.inflight.delete(id)
            const open = this.waiters.length > 0
            const idleFor = this.lastPollAt ? Date.now() - this.lastPollAt : Infinity
            // 没有挂起的 poll 有两种情况，别混成一句「没连上」：
            //  - 扩展刚还在轮询（idle 短）：它大概率卡在上一条命令里，不是掉线；
            //  - 很久没轮询：真掉线。
            const busy = !open && idleFor < 90000
            const error = new Error(
              open
                ? `命令超时（${timeoutMs}ms）：扩展连着但没在时限内回话`
                : busy
                  ? `命令超时（${timeoutMs}ms）：扩展可能卡在上一条命令里（页面/协议不响应），不是掉线。先 status 看队列；必要时 chrome://extensions 里重载扩展`
                  : `命令超时（${timeoutMs}ms）：Chrome 扩展没连上桥。请确认扩展已加载并处于启用状态（chrome://extensions）`,
            )
            error.errorCode = open || busy ? 'COMMAND_TIMEOUT' : 'EXT_OFFLINE'
            error.detail = { open, idleFor, lastPollAt: this.lastPollAt }
            reject(error)
            return
          }
          // 没回音就当上次投递落在了一条废弃连接上：重新入队再发一次。
          // 扩展按 cmd.id 去重，重发不会把写操作执行两遍。
          slot.attempts++
          this.queue.push(slot.cmd)
          this.#flush()
          arm()
        }, retryMs)
      }
      arm()
    })
  }

  /** 扩展掉线时的统一错误：说清「是扩展挂了，还是整个 Chrome 被关了」。 */
  #offlineError(idleFor) {
    const secs = Number.isFinite(idleFor) ? Math.round(idleFor / 1000) : null
    const error = new Error(
      secs == null
        ? 'Chrome 扩展从来没连上过桥。确认扩展已启用（chrome://extensions），再点扩展图标看是否「已连上 DSH」。'
        : `Chrome 扩展已经 ${secs} 秒没轮询了，命令发不出去（不是超时，是根本没投递）。` +
          // 1.11.1：别再把「SW 被回收」说成「Chrome 崩了」——实测大结果 eval 之后 SW 被回收，
          // Chrome 好端端的，几十秒后自己就回来。两种情况的处置不一样，要分开说。
          '最可能是扩展的 Service Worker 被 Chrome 回收了（跑过大结果 eval / 长任务之后常见）：Chrome 还在，' +
          '点一下扩展图标的「重连」或随便刷新一个标签页就能唤醒它，通常几十秒内自己也会恢复。' +
          '如果 chrome.exe 确实不在了，那才是浏览器被关掉/崩了。',
    )
    error.errorCode = 'EXT_OFFLINE'
    error.detail = { idleFor, lastPollAt: this.lastPollAt, serviceWorkerLikelyRecycled: secs != null && secs > STALE_MS / 1000 }
    return error
  }

  /** 把排队里发不出去的命令一次性判死，别让每条各自等 90 秒。 */
  #dropQueue() {
    const dropped = this.queue.splice(0)
    for (const cmd of dropped) {
      const slot = this.inflight.get(cmd.id)
      if (!slot) continue
      clearTimeout(slot.timer)
      this.inflight.delete(cmd.id)
      slot.reject(this.#offlineError(this.lastPollAt ? Date.now() - this.lastPollAt : Infinity))
    }
    if (dropped.length) {
      this.droppedCount += dropped.length
      this.logger?.warn?.(`[dsh-chrome] 扩展掉线，直接判死 ${dropped.length} 条排队命令`)
    }
    return dropped.length
  }

  /** 扩展掉线后队列可能还会堆：每 5 秒扫一次，别再等各自的超时。 */
  #startSweeper() {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = setInterval(() => {
      if (!this.queue.length) return
      const idleFor = this.lastPollAt ? Date.now() - this.lastPollAt : Infinity
      if (idleFor > STALE_MS) this.#dropQueue()
    }, 5000)
    this.sweeper.unref?.()
  }

  /** /cmd 的鉴权 token：文件存在才启用（默认不启用，保持老用法不变）。 */
  async #loadToken() {
    const file = path.join(process.env.DSH_CHROME_HOME || path.join(os.homedir(), '.dsh', 'chrome'), 'bridge.token')
    try {
      const text = (await readFile(file, 'utf8')).trim()
      this.token = text || null
    } catch {
      this.token = null
    }
  }

  #tokenOk(req, body) {
    if (!this.token) return true
    const header = String(req.headers['x-dsh-token'] || '')
    const inline = String((body && body.token) || '')
    return header === this.token || inline === this.token
  }

  #flush() {    while (this.queue.length && this.waiters.length) {
      // 只把命令交给还活着的连接。扩展刷新/休眠时旧的长轮询 res 可能已经销毁，
      // 往它上面写会抛错——命令已经从队列拿走就丢了（2026-11-17 实测踩到）。
      let waiter = null
      while (this.waiters.length) {
        const candidate = this.waiters.shift()
        clearTimeout(candidate.timer)
        const res = candidate.res
        if (res && !res.destroyed && !res.writableEnded) { waiter = candidate; break }
      }
      if (!waiter) return   // 没有活连接：命令留在队列里，等下一次 poll
      const cmd = this.queue.shift()
      this.traces.push({ ts: new Date().toISOString(), stage: 'flush', id: cmd.id, action: cmd.action, attempts: this.inflight.get(cmd.id)?.attempts ?? 0 })
      if (this.traces.length > 100) this.traces.splice(0, this.traces.length - 100)
      this.#json(waiter.res, 200, { ok: true, cmd })
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
    const route = `${req.method} ${url.pathname}`

    // CORS 预检：扩展发的 POST 带 application/json，浏览器先问 OPTIONS。
    // 不处理的话预检回 404，POST /result、/trace、/hello 全被拦下来——
    // 表现就是「轮询正常、命令发出去、结果回不来」（2026-11-17 排查了半天）。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,x-dsh-token',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }

    if (route === 'GET /status') {
      return this.#json(res, 200, this.info())
    }

    // 自托管更新源：企业策略强制安装时 Chrome 来这里取 update.xml 和 CRX。
    if (req.method === 'GET' && (url.pathname === '/crx/update.xml' || url.pathname === '/crx/dsh-chrome.crx')) {
      const file = path.join(process.env.DSH_CHROME_HOME || path.join(os.homedir(), '.dsh', 'chrome'), 'crx', path.basename(url.pathname))
      try {
        const data = await readFile(file)
        res.writeHead(200, {
          'Content-Type': url.pathname.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'application/x-chrome-extension',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(data)
      } catch (error) {
        return this.#json(res, 404, { ok: false, error: `没有这个文件：${file}（${error.code || error.message}）` })
      }
      return
    }

    if (route === 'POST /hello') {
      const body = await readJson(req)
      this.ext = { id: String(body.extId || ''), version: String(body.version || '') }
      this.lastHelloAt = Date.now()
      return this.#json(res, 200, { ok: true, bridge: 'dsh-chrome', port: this.port })
    }

    // 扩展上报「收到命令 / 执行完 / 回传失败」，定位投递断点用
    if (route === 'POST /trace') {
      const body = await readJson(req)
      this.traces.push({ ts: new Date().toISOString(), ...body })
      if (this.traces.length > 100) this.traces.splice(0, this.traces.length - 100)
      return this.#json(res, 200, { ok: true })
    }

    if (route === 'GET /poll') {
      const extId = url.searchParams.get('ext') || ''
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get('wait')) || MAX_WAIT_MS))
      if (extId) this.ext.id = extId
      this.lastPollAt = Date.now()
      this.traces.push({ ts: new Date().toISOString(), stage: 'poll', wait, queued: this.queue.length })
      if (this.traces.length > 100) this.traces.splice(0, this.traces.length - 100)

      if (this.queue.length) {
        const cmd = this.queue.shift()
        this.traces.push({ ts: new Date().toISOString(), stage: 'flush', id: cmd.id, action: cmd.action, attempts: this.inflight.get(cmd.id)?.attempts ?? 0, via: 'poll-reply' })
        return this.#json(res, 200, { ok: true, cmd })
      }

      // 同一扩展只留一条挂起的 poll，旧的先放掉，避免请求堆积
      for (const old of this.waiters.splice(0)) {
        clearTimeout(old.timer)
        this.#json(old.res, 200, { ok: true, cmd: null })
      }
      const waiter = { res, timer: null }
      // 连接断了就从队列里摘掉，不然命令会被投给一条废弃的 socket
      res.on('close', () => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
      })
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        this.#json(res, 200, { ok: true, cmd: null })
      }, wait)
      this.waiters.push(waiter)
      return
    }

    if (route === 'POST /result') {
      const body = await readJson(req)
      const cmdId = String(body.cmdId || '')
      const slot = this.inflight.get(cmdId)
      this.lastResultAt = Date.now()
      if (!slot) return this.#json(res, 200, { ok: true, note: '没有在等的命令（可能已超时）' })
      clearTimeout(slot.timer)
      this.inflight.delete(cmdId)
      if (body.ok === false) {
        const error = new Error(String(body.error || '扩展执行失败'))
        // 错误码要一路带回去：扩展 → 桥 → actions → 模型，少一环就退化成
        // 「扩展执行失败」这种废话（2026-11-17 实测踩过）。
        error.errorCode = body.errorCode || (body.data && body.data.errorCode) || ''
        error.detail = body.data
        slot.reject(error)
      } else {
        // data 里的 ok 来自页面函数；body.ok 来自扩展对整条命令的判断。两个都为真才算成功。
        slot.resolve({ ...(body.data || {}), ok: body.ok !== false && body.data?.ok !== false })
      }
      return this.#json(res, 200, { ok: true })
    }

    if (route === 'POST /cmd') {
      const body = await readJson(req)
      if (!this.#tokenOk(req, body)) {
        return this.#json(res, 401, { ok: false, error: '这个桥开了 token 校验：请求要带 x-dsh-token 头（内容见 ~/.dsh/chrome/bridge.token）', errorCode: 'UNAUTHORIZED' })
      }
      if (!body.action) return this.#json(res, 400, { ok: false, error: '缺少 action' })
      try {
        const result = await this.call(body.action, body.params || {}, { timeoutMs: Number(body.timeoutMs) || 30000 })
        const saved = body.saveTo ? await this.#externalise(result, String(body.saveTo)) : []
        return this.#json(res, 200, saved.length ? { ...result, saved } : result)
      } catch (error) {
        return this.#json(res, 200, {
          ok: false,
          error: String(error.message || error),
          errorCode: error.errorCode || undefined,
          retryable: Boolean(error.retryable),
        })
      }
    }

    return this.#json(res, 404, { ok: false, error: `没有这个路由：${route}` })
  }

  /**
   * /cmd 的大字段落盘：脚本拿 screenshot/dataUrl 时不用整包 base64 过一遍内存。
   * 超过 2000 字的 dataUrl / value / html / text 写成文件，回执里只留路径和长度。
   */
  async #externalise(payload, name) {
    const dir = path.join(process.env.DSH_CHROME_HOME || path.join(os.homedir(), '.dsh', 'chrome'), 'out')
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'cmd'
    const saved = []
    const fields = ['dataUrl', 'value', 'html', 'text', 'body']
    let wrote = 0
    for (const field of fields) {
      const value = payload?.[field]
      if (typeof value !== 'string' || value.length <= 2000) continue
      const ext = field === 'dataUrl' ? '.b64' : '.txt'
      const file = path.join(dir, `${safe}-${field}${ext}`)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, value, 'utf8')
        payload[field] = `（${value.length} 字，已落盘：${file}${ext === '.b64' ? '，base64 文本' : ''}）`
        saved.push({ field, file, length: value.length })
        wrote++
      } catch (error) {
        this.logger?.warn?.(`[dsh-chrome] /cmd 落盘失败：${error.message}`)
      }
    }
    if (wrote) this.logger?.info?.(`[dsh-chrome] /cmd saveTo=${safe} 落盘 ${wrote} 个字段`)
    return saved
  }

  #json(res, status, payload) {
    if (!res || res.writableEnded || res.destroyed) return
    try {
      const text = JSON.stringify(payload)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,x-dsh-token',
        'Cache-Control': 'no-store',
      })
      res.end(text)
    } catch (error) {
      // 连接已经断了：不往上抛，调用方按「没发出去」处理
      this.lastError = `写响应失败：${error.message}`
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      text += chunk
    })
    req.on('end', () => {
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) }
    })
    req.on('error', reject)
  })
}
