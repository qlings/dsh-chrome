/**
 * cdp.js —— 一条 Chrome DevTools Protocol 通道（扩展侧）。
 *
 * 为什么要它：MV3 的 content script 只能合成事件，做不了「真实键盘输入」、
 * 拦不住原生 alert/confirm、看不到 console/网络、导不出 PDF、点不了 file input、
 * 也判断不了导航到底落在哪一步。这些能力全在 CDP 后面，而 CDP 只要一个
 * debugger 权限 + 一条透传命令。
 *
 * 设计要点（照 angelky7/dsh-browser-control 的思路重写，代码自己写）：
 *  1. 每个 tab 一次性 attach，域按需 enable；attach 状态在内存里，SW 一被杀就没了，
 *     所以每次用之前都 ensure() 一次（已 attach 就是空操作）。
 *  2. 事件在模块加载时就把监听挂上——SW 冷启动后才挂会漏掉导航事件。
 *  3. 原生弹窗默认 accept，绝不让页面线程卡死到工具超时。
 *  4. console / 网络 / 弹窗各留一个环形缓冲，只在内存里，重启即清。
 *  5. 导航「到达」用事件判定（frameNavigated / domContentEventFired / loadEventFired），
 *     并且 dcl/load 必须发生在 commit 之后才算数；预算用完诚实报 loadPending。
 */

const PROTOCOL_VERSION = '1.3'
const MAX_CONSOLE = 300
// 1.12.0：300 → 600。实测同一页面上心跳 + unReadCount 每 10 秒各一条，300 行的环
// 只够 20 分钟；关键请求（比如一次点击触发的写接口）很容易被挤掉，后面怎么过滤都找不到。
const MAX_NETWORK = 600
const MAX_DIALOG = 10
const MAX_DOWNLOAD = 50

/** 需要 debugger 的命令面：插件侧拿它判断扩展够不够新。 */
export const CAPABILITIES = [
  'cdp', 'press', 'hover', 'dialog', 'logs', 'networkLog', 'networkDetail', 'networkClear',
  'pdf', 'mhtml', 'upload', 'drag', 'emulate', 'metrics', 'screenshotFull',
]

// 版本号单一来源 = manifest.json：从 manifest 读，不再手写（2026-11-20 收敛）。
export const VERSION = (() => {
  try { return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '1.9.0' } catch { return '1.9.0' }
})()

/** 超时预算：协议层不回话时必须能失败，绝不能把 SW 挂死。测试会改小它。 */
export const CFG = {
  sendTimeoutMs: 15000,
  attachTimeoutMs: 8000,
  screenshotTimeoutMs: 20000,
  pdfTimeoutMs: 40000,
  mhtmlTimeoutMs: 30000,
}

const attached = new Set()
const attaching = new Map()
const enabled = new Map()          // tabId -> Set('Page'|'Runtime'|...)
const consoleBuf = new Map()       // tabId -> row[]
const networkBuf = new Map()
const networkIndex = new Map()     // tabId -> Map(requestId -> row)
const dialogBuf = new Map()
const downloadBuf = new Map()       // tabId -> 下载事件（Browser.downloadWillBegin/Progress）
const downloadsEnabled = new Set()  // tabId -> 已经开过 Browser.setDownloadBehavior
const policies = new Map()         // tabId -> { mode, promptText }
const navWatchers = new Map()      // tabId -> watcher
// tabId -> Map(frameId -> executionContextId)：只有默认世界。eval 绕 CSP 时要用它
// 定位子 frame 的执行上下文（Runtime.evaluate 默认落在主 frame）。
const contexts = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdpError(code, message) {
  const error = new Error(message)
  error.errorCode = code
  return error
}

function ring(map, tabId, row, max) {
  const rows = map.get(tabId) || []
  rows.push(row)
  if (rows.length > max) rows.splice(0, rows.length - max)
  map.set(tabId, rows)
  return rows
}

/* ------------------------------------------------------------------ */
/* attach / 域 / 发命令                                                */
/* ------------------------------------------------------------------ */

export function isAttached(tabId) {
  return attached.has(tabId)
}

export function capabilityList() {
  return CAPABILITIES.slice()
}

export function attachedTabs() {
  return [...attached]
}

const DEFAULT_DOMAINS = ['Page', 'Runtime', 'Log', 'Network']

/**
 * 保证这个 tab 有 CDP 会话。
 * @param {number} tabId
 * @param {{domains?: string[]}} opts
 */
export async function ensure(tabId, opts = {}) {
  const requested = opts.domains || []
  if (attached.has(tabId)) {
    await enableDomains(tabId, requested)
    await enableDownloads(tabId)
    return { via: 'reuse' }
  }
  if (attaching.has(tabId)) {
    await attaching.get(tabId).catch(() => {})
    if (attached.has(tabId)) { await enableDomains(tabId, requested); await enableDownloads(tabId); return { via: 'joined' } }
  }
  const task = (async () => {
    if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
      throw cdpError('DEBUGGER_UNAVAILABLE', '扩展拿不到 debugger 权限：manifest 新增了 debugger，需要在 chrome://extensions 里重载扩展。')
    }
    try {
      await withTimeout(chrome.debugger.attach({ tabId }, PROTOCOL_VERSION), CFG.attachTimeoutMs, 'debugger.attach')
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (/already attached/i.test(msg)) {
        // 可能是自己的会话还没散（SW 刚重载），也可能是 DevTools 占着。
        // 发一条只读探针：通了就认领，不通就老实报「关掉 F12」。
        try {
          await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {}), 6000, 'Page.getFrameTree')
          attached.add(tabId)
          return
        } catch (probeError) {
          throw cdpError(
            'DEBUGGER_ATTACH_FAILED',
            msg + '\n（这个标签被 DevTools 或别的调试扩展占着：关掉 F12 / 停掉那个扩展再试。）',
          )
        }
      }
      throw cdpError(
        'DEBUGGER_ATTACH_FAILED',
        msg + '\n（同一个标签开着 DevTools / 被别的扩展占着时也会这样：关掉 F12 或换个标签再试。）',
      )
    }
    attached.add(tabId)
  })()
  attaching.set(tabId, task)
  try { await task } finally { attaching.delete(tabId) }
  // 新会话先把基础域都打开：console/网络只在「开着的那段时间」能抓，
  // 等你要用的时候再开，之前发生的事就抓不到了。
  await enableDomains(tabId, [...DEFAULT_DOMAINS, ...requested])
  await enableDownloads(tabId)
  return { via: 'attach' }
}

/** 下载事件：点了「下载日志/导出」没有任何回执时，靠这个看下载到底发生没发生。 */
async function enableDownloads(tabId) {
  if (downloadsEnabled.has(tabId)) return
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true })
    downloadsEnabled.add(tabId)
  } catch { /* 老版 Chrome/权限不足：抓不到下载事件就算了，不影响其它动作 */ }
}

async function enableDomains(tabId, domains) {
  let set = enabled.get(tabId)
  if (!set) { set = new Set(); enabled.set(tabId, set) }
  for (const domain of domains) {
    if (set.has(domain)) continue
    try {
      await chrome.debugger.sendCommand({ tabId }, domain + '.enable', {})
      set.add(domain)
    } catch (error) {
      const msg = String((error && error.message) || error)
      // 已经 enable 过不算错；CDP 里有些域压根没有 enable 方法（Emulation 就是），
      // 报 "wasn't found" 时按「不需要开」处理，别整条命令失败。
      if (/already enabled|wasn't found|-32601/i.test(msg)) { set.add(domain); continue }
      throw cdpError('CDP_ENABLE_FAILED', domain + '.enable 失败：' + msg)
    }
  }
}

/** 给 sendCommand 套一层超时：协议层不回话时必须能失败，不能把整个 SW 挂住。 */
function withTimeout(promise, ms, method) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(cdpError('CDP_TIMEOUT', method + ' 超过 ' + ms + 'ms 没回音（页面/协议卡住）。命令可能仍在浏览器里执行，别直接重试写操作——先 read / screenshot 看一眼状态。'))
    }, Math.max(500, ms))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 发一条 CDP 命令。会话掉了自动重连一次（SW 被回收的常见后果）。 */
export async function send(tabId, method, params = {}, opts = {}) {
  if (!attached.has(tabId)) await ensure(tabId, { domains: [] })
  const timeoutMs = Number(opts.timeoutMs) || CFG.sendTimeoutMs
  try {
    return await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), timeoutMs, method)
  } catch (error) {
    if (error && error.errorCode) throw error      // 超时/业务错误原样往上抛
    const msg = String((error && error.message) || error)
    if (/not attached|No debugger/i.test(msg)) {
      reset(tabId)
      await ensure(tabId, { domains: [] })
      return await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), timeoutMs, method)
    }
    throw cdpError('CDP_FAILED', method + ' 失败：' + msg)
  }
}

/**
 * 硬停：让渲染进程把「正在跑的脚本」直接终止（1.11.1）。
 *
 * 为什么需要：abort 以前只标记 window.__dshEvalRuns，得靠页面代码自己查
 * __dshAborted 才退得出来；如果代码是同步死循环（比如在整棵 vnode 树上裸递归），
 * 主线程被占死，content script 注入也跟着超时，连 abort 命令都送不进去，只能 F5。
 *
 * Runtime.terminateExecution 是协议层唯一的「不讲道理但有效」的开关：它不需要页面
 * 配合，也不需要主线程空闲。代价是会把当时所有在跑的脚本一起打断（包括页面自己的
 * 后台任务），所以只在 abort 走不通、或用户显式 hard:true 时用。
 */
export async function terminate(tabId) {
  await ensure(tabId, { domains: [] })
  try {
    await send(tabId, 'Runtime.terminateExecution', {}, { timeoutMs: 5000 })
    return { ok: true, terminated: true }
  } catch (error) {
    return { ok: false, terminated: false, error: String((error && error.message) || error) }
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return { ok: true, alreadyGone: true }
  try { await chrome.debugger.detach({ tabId }) } catch { /* 已经没了 */ }
  reset(tabId)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 执行页面代码（DevTools 通道，绕开页面 CSP 的 unsafe-eval）           */
/* ------------------------------------------------------------------ */

/**
 * 数字 frameId（webNavigation）→ CDP 执行上下文。
 *
 * 两个坑（2026-11-21 都踩了）：
 *  1. `Runtime.executionContextCreated` 里的 `auxData.frameId` 是 CDP 的**字符串** frame id，
 *     和动作里的 `frame`（webNavigation 数字 id）不是一套编号，按数字查永远查不到；
 *  2. 一个帧可能有多个执行上下文（默认世界 + 隔离世界），`isDefault` 的取值在各版本
 *     不完全一致，按字段过滤容易把默认世界也漏掉。
 *
 * 所以改成「标记探测」：先在目标帧的页面世界里写一个随机串，再逐个上下文问
 * `window.__dshEvalMark === "<随机串>"`——答 true 的就是这一帧的页面世界。
 * 隔离世界有独立的 window，看到的是 undefined，天然被排除。
 */
async function findFrameContext(tabId, frameId, timeoutMs) {
  const token = 'dsh' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const mark = (t) => { try { window.__dshEvalMark = t; return true } catch { return false } }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [Number(frameId)] },
      world: 'MAIN',
      func: mark,
      args: [token],
    })
  } catch (error) {
    throw cdpError('FRAME_CONTEXT_NOT_FOUND', 'frame ' + frameId + ' 注入标记失败（这一帧可能已被移除/正在导航）：' +
      String((error && error.message) || error))
  }
  const deadline = Date.now() + Math.max(300, Number(timeoutMs) || 1500)
  // 有些版本只在 enable 的那一刻广播上下文：一个都没有时重启一次 Runtime 域补一轮
  const map0 = contexts.get(tabId)
  if (!map0 || map0.size === 0) {
    try {
      await send(tabId, 'Runtime.disable', {}, { timeoutMs: 3000 })
      await send(tabId, 'Runtime.enable', {}, { timeoutMs: 3000 })
      await sleep(200)
    } catch { /* 重启失败就按现有上下文试 */ }
  }
  const probe = 'window.__dshEvalMark === ' + JSON.stringify(token)
  for (;;) {
    const map = contexts.get(tabId)
    const ids = map ? [...map.keys()] : []
    for (const id of ids) {
      try {
        const res = await send(tabId, 'Runtime.evaluate', {
          expression: probe, contextId: id, returnByValue: true, silent: true,
        }, { timeoutMs: 2500 })
        if (res && res.result && res.result.value === true) return id
      } catch { /* 这个上下文已经没了，继续试下一个 */ }
    }
    if (Date.now() >= deadline) return null
    await sleep(120)
  }
}

async function clearFrameMark(tabId, contextId) {
  if (contextId == null) return
  try {
    await send(tabId, 'Runtime.evaluate', {
      expression: 'try { delete window.__dshEvalMark } catch (e) {}', contextId, returnByValue: true, silent: true,
    }, { timeoutMs: 2000 })
  } catch { /* 清理失败不影响结果 */ }
}

/**
 * 用 Runtime.evaluate 在页面里执行表达式。
 *
 * 为什么不复用 page.js 的 eval：那边是 `new Function` 编译代码，隔离世界（content
 * script）的 CSP 一定挡它；页面世界也禁 unsafe-eval 时同样跑不了（2026-11-21 在带 CSP
 * 的流程设计器上踩到，整个排查只能绕到父页面跨窗口读 iframe）。DevTools 的
 * Runtime.evaluate 不受页面 CSP 约束，是最后一条稳的路。
 *
 * 返回 {value, type, contextId}；异常统一抛 EVAL_ERROR（带页面给的堆栈描述）。
 */
export async function evaluate(tabId, opts = {}) {
  const expression = String(opts.expression || '')
  if (!expression.trim()) throw cdpError('BAD_ARGS', 'evaluate 需要 expression')
  await ensure(tabId, { domains: ['Runtime'] })
  const frameId = Number(opts.frameId || 0)
  let contextId = null
  if (frameId !== 0) {
    contextId = await findFrameContext(tabId, frameId, opts.contextTimeoutMs)
    if (contextId == null) {
      throw cdpError(
        'FRAME_CONTEXT_NOT_FOUND',
        'frame ' + frameId + ' 找不到默认执行上下文（可能正在导航/已被移除/是沙箱帧）。先 action=frames 确认这一帧还在；' +
        '等页面加载完再试；也可以去掉 frame 参数在主帧跑。',
      )
    }
  } else {
    // 主帧：不传 contextId 时 Runtime.evaluate 默认就落在页面的默认上下文里
    contextId = null
  }
  try {
    const params = {
      expression,
      awaitPromise: opts.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: false,
    }
    if (contextId != null) params.contextId = contextId
    const res = await send(tabId, 'Runtime.evaluate', params, { timeoutMs: opts.timeoutMs || 20000 })
    if (res && res.exceptionDetails) {
      const detail = res.exceptionDetails
      const text = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || '执行出错'
      throw cdpError('EVAL_ERROR', String(text).slice(0, 800))
    }
    return {
      value: res && res.result ? res.result.value : undefined,
      type: res && res.result ? res.result.type : 'undefined',
      contextId,
    }
  } finally {
    if (frameId !== 0) await clearFrameMark(tabId, contextId)
  }
}

function reset(tabId) {
  attached.delete(tabId)
  enabled.delete(tabId)
  downloadsEnabled.delete(tabId)
  navWatchers.delete(tabId)
  contexts.delete(tabId)
}

/* ------------------------------------------------------------------ */
/* 事件：console / 网络 / 原生弹窗 / 导航                              */
/* ------------------------------------------------------------------ */

function argText(arg) {
  if (!arg) return ''
  if ('value' in arg) {
    const value = arg.value
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  if (arg.unserializableValue) return String(arg.unserializableValue)
  return arg.description || arg.type || ''
}

function clip(text, n) {
  const s = String(text == null ? '' : text)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function handleEvent(tabId, method, params) {
  switch (method) {
    case 'Page.frameNavigated': {
      const frame = params.frame || {}
      if (frame.parentId) return                       // 子 frame 不算整页到达
      notifyWatcher(tabId, 'commit', frame.url || '')
      return
    }
    case 'Page.navigatedWithinDocument':
      // hash/锚点跳转：文档没换，但地址确实动了。算到达，标 sameDocument。
      notifyWatcher(tabId, 'samedoc', params.url || '')
      return
    case 'Page.domContentEventFired':
      notifyWatcher(tabId, 'dcl')
      return
    case 'Page.loadEventFired':
      notifyWatcher(tabId, 'load')
      return
    case 'Page.javascriptDialogOpening': {
      const row = {
        ts: Date.now(), type: params.type || 'alert', message: clip(params.message || '', 500),
        defaultPrompt: params.defaultPrompt || '', answered: '',
      }
      const policy = policies.get(tabId) || { mode: 'accept', promptText: '' }
      row.answered = policy.mode === 'manual' ? 'manual' : policy.mode
      ring(dialogBuf, tabId, row, MAX_DIALOG)
      if (policy.mode !== 'manual') {
        send(tabId, 'Page.handleJavaScriptDialog', {
          accept: policy.mode !== 'dismiss',
          promptText: policy.mode === 'accept' ? (policy.promptText || undefined) : undefined,
        }).catch(() => {})
      }
      return
    }
    case 'Runtime.consoleAPICalled': {
      const text = (params.args || []).map(argText).join(' ')
      ring(consoleBuf, tabId, {
        ts: Date.now(), level: params.type || 'log', text: clip(text, 1000),
        url: clip((params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0] && params.stackTrace.callFrames[0].url) || '', 200),
      }, MAX_CONSOLE)
      return
    }
    case 'Runtime.exceptionThrown': {
      const detail = params.exceptionDetails || {}
      const text = [detail.text, detail.exception && (detail.exception.description || detail.exception.value)].filter(Boolean).join(' ')
      ring(consoleBuf, tabId, { ts: Date.now(), level: 'error', text: clip(text, 1000), url: clip(detail.url || '', 200) }, MAX_CONSOLE)
      return
    }
    case 'Runtime.executionContextCreated': {
      const context = params.context || {}
      const aux = context.auxData || {}
      let map = contexts.get(tabId)
      if (!map) { map = new Map(); contexts.set(tabId, map) }
      // 全都存（默认世界 + 隔离世界）：各版本 Chrome 的 isDefault 不一定给 true，
      // 按字段筛会把默认世界漏掉。区分留到 findFrameContext 用标记探测做。
      map.set(context.id, {
        frameId: aux.frameId != null ? String(aux.frameId) : '',
        isDefault: aux.isDefault === true,
        type: aux.type || '',
      })
      return
    }
    case 'Runtime.executionContextDestroyed': {
      const map = contexts.get(tabId)
      if (map) map.delete(params.executionContextId)
      return
    }
    case 'Runtime.executionContextsCleared':
      contexts.delete(tabId)
      return
    case 'Log.entryAdded': {
      const entry = params.entry || {}
      ring(consoleBuf, tabId, { ts: Date.now(), level: entry.level || 'info', text: clip(entry.text || '', 1000), url: clip(entry.url || '', 200) }, MAX_CONSOLE)
      return
    }
    case 'Network.requestWillBeSent': {
      const req = params.request || {}
      const row = {
        id: params.requestId, ts: Date.now(), method: req.method || '', url: clip(req.url || '', 500),
        type: params.type || '', status: null, mimeType: '', fromCache: false, failed: '',
        requestHeaders: req.headers || {},
        postData: clip(req.postData || '', 2000),
      }
      ring(networkBuf, tabId, row, MAX_NETWORK)
      let index = networkIndex.get(tabId)
      if (!index) { index = new Map(); networkIndex.set(tabId, index) }
      index.set(params.requestId, row)
      if (index.size > MAX_NETWORK * 2) {
        const first = index.keys().next().value
        index.delete(first)
      }
      return
    }
    case 'Network.responseReceived': {
      const index = networkIndex.get(tabId)
      const row = index && index.get(params.requestId)
      if (!row) return
      const res = params.response || {}
      row.status = res.status ?? null
      row.mimeType = res.mimeType || ''
      row.statusText = res.statusText || ''
      row.responseHeaders = res.headers || {}
      row.fromCache = Boolean(res.fromDiskCache || res.fromMemoryCache)
      return
    }
    case 'Network.loadingFailed': {
      const index = networkIndex.get(tabId)
      const row = index && index.get(params.requestId)
      if (row) row.failed = params.errorText || 'failed'
      return
    }
    case 'Browser.downloadWillBegin': {
      ring(downloadBuf, tabId, {
        ts: Date.now(), guid: params.guid || '', url: clip(params.url || '', 500),
        file: String(params.suggestedFilename || ''), state: 'started', received: 0, total: 0,
      }, MAX_DOWNLOAD)
      return
    }
    case 'Browser.downloadProgress': {
      const rows = downloadBuf.get(tabId) || []
      let hit = rows.find((r) => r.guid && r.guid === params.guid)
      if (!hit) {
        ring(downloadBuf, tabId, { ts: Date.now(), guid: params.guid || '', url: '', file: '', received: 0, total: 0 }, MAX_DOWNLOAD)
        hit = (downloadBuf.get(tabId) || []).slice(-1)[0]
      }
      if (hit) {
        hit.state = params.state || hit.state
        hit.received = Number(params.receivedBytes) || hit.received || 0
        hit.total = Number(params.totalBytes) || hit.total || 0
        hit.ts = Date.now()
      }
      return
    }
    default:
  }
}

function notifyWatcher(tabId, kind, url) {
  const watcher = navWatchers.get(tabId)
  if (!watcher) return
  if (kind === 'samedoc') {
    watcher.sameDocument = true
    watcher.sameDocumentUrl = url || watcher.committedUrl || ''
    return
  }
  if (kind === 'commit') {
    watcher.commit = true
    watcher.committedAt = Date.now()
    watcher.committedUrl = url || ''
    // 提交之前到的 dcl/load 是旧文档的，不算数
    if (watcher.earlyDcl) watcher.dcl = true
    if (watcher.earlyLoad) watcher.load = true
    return
  }
  if (kind === 'dcl') {
    if (watcher.commit) watcher.dcl = true
    else watcher.earlyDcl = true
    return
  }
  if (kind === 'load') {
    if (watcher.commit) watcher.load = true
    else watcher.earlyLoad = true
  }
}

if (chrome.debugger && typeof chrome.debugger.onEvent === 'object' && chrome.debugger.onEvent.addListener) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source && source.tabId
    if (tabId == null || !method) return
    try { handleEvent(tabId, method, params || {}) } catch { /* 一条事件坏了不连坐 */ }
  })
}

if (chrome.debugger && chrome.debugger.onDetach && chrome.debugger.onDetach.addListener) {
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source && source.tabId
    if (tabId == null) return
    const watcher = navWatchers.get(tabId)
    if (watcher) watcher.detached = true
    reset(tabId)
  })
}

/* ------------------------------------------------------------------ */
/* 导航到达：事件判定                                                  */
/* ------------------------------------------------------------------ */

export const NAV_BUDGET = { load: 15000, domcontentloaded: 4000, commit: 4000, none: 0 }

export function navBudget(waitUntil, explicit) {
  if (explicit != null && Number(explicit) > 0) return Math.max(100, Math.min(120000, Number(explicit)))
  return NAV_BUDGET[normaliseWaitUntil(waitUntil)] ?? 15000
}

export function normaliseWaitUntil(value) {
  const v = String(value || 'load').toLowerCase()
  if (v === 'none' || v === 'false' || v === 'off') return 'none'
  if (v === 'commit') return 'commit'
  if (v === 'domcontentloaded' || v === 'dcl') return 'domcontentloaded'
  return 'load'
}

/**
 * 在导航**之前**注册监听。返回的 waiter 交给 arrive() 用。
 * 同一 tab 只保留一个：新的来了就把旧的标成 superseded。
 */
export function watchNavigation(tabId, opts = {}) {
  const previous = navWatchers.get(tabId)
  if (previous) previous.superseded = true
  const waiter = {
    tabId,
    waitUntil: normaliseWaitUntil(opts.waitUntil),
    startedAt: Date.now(),
    commit: false, dcl: false, load: false,
    earlyDcl: false, earlyLoad: false,
    sameDocument: false, sameDocumentUrl: '',
    committedUrl: '', committedAt: 0,
    detached: false, superseded: false,
  }
  navWatchers.set(tabId, waiter)
  return waiter
}

const sameAddress = (a, b) => {
  const norm = (u) => String(u || '').split('#')[0].replace(/\/+$/, '')
  return norm(a) !== '' && norm(a) === norm(b)
}

/**
 * 等到「到达」或者预算用完。
 * @param {object} waiter watchNavigation 的返回
 * @param {{timeoutMs?:number, pendingUrl?:string, getTab?:Function}} opts
 */
export async function arrive(waiter, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : navBudget(waiter.waitUntil)
  const pendingUrl = String(opts.pendingUrl || '')
  const getTab = typeof opts.getTab === 'function' ? opts.getTab : null
  const want = waiter.waitUntil
  const startedAt = Date.now()

  const done = async (landed, extra = {}) => {
    navWatchers.delete(waiter.tabId)
    let tab = null
    if (getTab) { try { tab = await getTab() } catch { tab = null } }
    const url = (tab && tab.url) || waiter.committedUrl || pendingUrl
    const errorPage = /^chrome-error:\/\//.test(url)
    return {
      landed,
      waitUntil: want,
      waitedMs: Date.now() - startedAt,
      commit: waiter.commit,
      dcl: waiter.dcl,
      load: waiter.load,
      committedUrl: waiter.committedUrl || '',
      url,
      readyState: (tab && tab.status) || '',
      loadPending: landed ? false : true,
      pendingUrl: landed ? '' : url,
      sameDocument: Boolean(extra.sameDocument),
      detached: Boolean(waiter.detached),
      superseded: Boolean(waiter.superseded),
      siteUnreachable: errorPage ? { reason: 'unreachable' } : undefined,
      ...extra,
    }
  }

  if (want === 'none') {
    const tab = getTab ? await getTab().catch(() => null) : null
    return { landed: true, waitUntil: 'none', waitedMs: 0, loadPending: true, pendingUrl: (tab && tab.url) || pendingUrl, readyState: (tab && tab.status) || '' }
  }

  const deadline = startedAt + Math.max(100, timeoutMs)
  let lastUrlCheck = 0
  while (Date.now() < deadline) {
    if (waiter.detached) return done(false, { reason: 'debugger-detached' })
    if (waiter.superseded) return done(false, { reason: 'superseded' })
    // 同文档跳转：文档没换，地址换了——事件到了就算到达
    if (waiter.sameDocument) return done(true, { sameDocument: true })
    const hit = want === 'commit' ? waiter.commit
      : want === 'domcontentloaded' ? (waiter.commit && waiter.dcl)
        : (waiter.commit && waiter.load)
    if (hit) return done(true)
    // 兜底：压根不提交的导航（下载、被 Chrome 拒载）里，地址其实已经落对了。
    // 给 600ms 宽限再比对，避免刚 update 完地址就「看起来对了」的假到达。
    if (!waiter.commit && getTab && Date.now() - startedAt > 600 && Date.now() - lastUrlCheck > 200) {
      lastUrlCheck = Date.now()
      try {
        const tab = await getTab()
        if (pendingUrl && sameAddress(tab && tab.url, pendingUrl)) {
          return done(true, { sameDocument: true, sameDocumentUrl: (tab && tab.url) || '' })
        }
      } catch { /* 拿不到就继续等事件 */ }
    }
    await sleep(40)
  }

  // 预算用完。三种「其实到了」的兜底，都不许 0ms 伪装成成功：
  let tab = null
  if (getTab) { try { tab = await getTab() } catch { tab = null } }
  const url = (tab && tab.url) || ''
  if (waiter.commit) return done(false, { reason: 'budget-spent' })
  if (pendingUrl && sameAddress(url, pendingUrl)) {
    // 同文档跳转（hash/锚点）或「本来就停在这个地址」：算到达，但标明 sameDocument
    return done(true, { sameDocument: true })
  }
  return done(false, { reason: 'no-commit' })
}

/* ------------------------------------------------------------------ */
/* 键盘                                                                */
/* ------------------------------------------------------------------ */

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  F1: { key: 'F1', code: 'F1', vk: 112 }, F2: { key: 'F2', code: 'F2', vk: 113 },
  F3: { key: 'F3', code: 'F3', vk: 114 }, F4: { key: 'F4', code: 'F4', vk: 115 },
  F5: { key: 'F5', code: 'F5', vk: 116 }, F6: { key: 'F6', code: 'F6', vk: 117 },
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 }

/** "Ctrl+Shift+A" / "Enter" / ["ctrl","a"] → { key, code, vk, text, modifiers } */
export function parseKey(input, extraModifiers) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) throw cdpError('BAD_ARGS', 'press 需要 key（如 "Enter"、"Ctrl+A"、"ArrowDown"）')
  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean)
  let modifiers = 0
  const mods = []
  for (const m of (Array.isArray(extraModifiers) ? extraModifiers : [])) {
    const bit = MODIFIER_BITS[String(m).toLowerCase()]
    if (bit == null) throw cdpError('BAD_ARGS', '不认识的修饰键：' + m + '（可用 ctrl / alt / shift / meta）')
    if (!(modifiers & bit)) { modifiers |= bit; mods.push(String(m).toLowerCase()) }
  }
  let keyPart = raw
  if (parts.length > 1) {
    keyPart = parts[parts.length - 1]
    for (const part of parts.slice(0, -1)) {
      const bit = MODIFIER_BITS[part.toLowerCase()]
      if (bit == null) {
        throw cdpError('BAD_ARGS', '不认识的修饰键：' + part + '（可用 Ctrl / Alt / Shift / Meta，例如 "Ctrl+A"）')
      }
      if (!(modifiers & bit)) { modifiers |= bit; mods.push(part.toLowerCase()) }
    }
  }
  const named = KEYMAP[keyPart] || KEYMAP[keyPart.charAt(0).toUpperCase() + keyPart.slice(1).toLowerCase()]
  if (named) return { ...named, modifiers, mods, described: (mods.length ? mods.join('+') + '+' : '') + named.key }
  if ([...keyPart].length === 1) {
    const ch = keyPart
    const upper = ch.toUpperCase()
    const isLetter = /[A-Za-z]/.test(ch)
    // 快捷键里的字母按浏览器语义是小写 key（Ctrl+A → key 'a' / code 'KeyA'）；
    // 不带修饰键就原样保留大小写，免得想打「A」打出「a」。
    const shortcut = (modifiers & 7) !== 0
    return {
      key: shortcut && isLetter ? ch.toLowerCase() : ch,
      code: isLetter ? 'Key' + upper : (ch === ' ' ? 'Space' : ''),
      vk: upper.charCodeAt(0),
      text: ch, modifiers, mods,
      described: (mods.length ? mods.join('+') + '+' : '') + ch,
    }
  }
  throw cdpError('BAD_ARGS', '不认识的键名：' + keyPart + '。可用：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space/F1-F6，单个字符，或 "Ctrl+A" 这种组合。')
}

export async function press(tabId, key, modifiers) {
  const spec = parseKey(key, modifiers)
  // Ctrl/Meta/Alt 组合是快捷键，不能带 text——带了就变成「插入一个字母」，
  // 页面收到的是 ctrl+a 插字而不是全选。用 rawKeyDown，让渲染器自己解释快捷键。
  const suppress = (spec.modifiers & 7) !== 0
  const text = suppress ? '' : (spec.text || '')
  const down = {
    type: text ? 'keyDown' : 'rawKeyDown',
    modifiers: spec.modifiers,
    key: spec.key,
    code: spec.code || undefined,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    ...(text ? { text, unmodifiedText: text } : {}),
  }
  await ensure(tabId, { domains: [] })
  await send(tabId, 'Input.dispatchKeyEvent', down)
  // keyDown 带 text 时 Chrome 已经插过字符了，再补 char 会变成 xx / Enter 提交两次
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: spec.modifiers, key: spec.key, code: spec.code || undefined,
    windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk,
  })
  return { key: spec.described, inserted: Boolean(text), modifiers: spec.mods, suppressedText: suppress }
}

/* ------------------------------------------------------------------ */
/* 悬停                                                                */
/* ------------------------------------------------------------------ */

/** 悬停：有些菜单/提示只在 :hover 下出现，合成事件骗不过导航项。 */
export async function hover(tabId, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw cdpError('BAD_ARGS', 'hover 需要元素坐标（先量 rect）')
  }
  await ensure(tabId, { domains: [] })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
  // 有的组件要两次 mousemove 才认（第一次进元素、第二次才算 hover 稳定）
  await sleep(30)
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 1, y: point.y + 1, buttons: 0 })
  return { ok: true, x: point.x, y: point.y }
}

/* ------------------------------------------------------------------ */
/* 请求详情                                                            */
/* ------------------------------------------------------------------ */

/**
 * filter 的匹配规则。默认 contains 是子串匹配——`routeActivity/query` 会同时命中
 * `routeActivity/queryActivityInfo`（2026-11-25 排查投料量时差点拿错接口）。
 *   - contains：子串（默认，向后兼容）
 *   - path：忽略 query 后 pathname 相等（内网接口常带 ?typecodes=... 之类）
 *   - regex：filter 当正则（大小写不敏感）
 */
export function urlMatcher(filter, match) {
  if (!filter) return () => true
  const needle = String(filter)
  if (match === 'regex') {
    let re = null
    try { re = new RegExp(needle, 'i') } catch { re = null }
    return (url) => (re ? re.test(String(url || '')) : false)
  }
  if (match === 'path') {
    const want = (() => {
      try { return new URL(needle, 'http://x').pathname.toLowerCase() } catch { return needle.toLowerCase() }
    })()
    return (url) => {
      let p = String(url || '')
      try { p = new URL(p, 'http://x').pathname } catch { /* 保持原样 */ }
      return p.toLowerCase() === want || p.toLowerCase().endsWith(want)
    }
  }
  const low = needle.toLowerCase()
  return (url) => String(url || '').toLowerCase().includes(low)
}

/** 抓某条请求的请求头 / 响应头 / 响应体（排查内网接口用）。 */
export async function networkDetail(tabId, opts = {}) {
  await ensure(tabId, { domains: ['Network'] })
  const rows = networkBuf.get(tabId) || []
  const test = urlMatcher(opts.filter, String(opts.match || '').toLowerCase())
  let row = null
  if (opts.requestId) row = rows.find((r) => r.id === opts.requestId) || null
  else if (opts.index != null) row = rows[rows.length - 1 - Math.max(0, Number(opts.index) || 0)] || null
  else if (opts.filter) row = [...rows].reverse().find((r) => test(r.url)) || null
  else row = rows[rows.length - 1] || null
  if (!row) {
    throw cdpError('NOT_FOUND', '网络缓冲里没有匹配的请求。先 networkLog 看一眼——只抓 CDP 挂上之后的请求。')
  }
  // 命中多条时把候选带回去：filter 是子串匹配，很容易点到隔壁接口。
  let candidates = []
  if (opts.filter && !opts.requestId) {
    const hit = rows.filter((r) => test(r.url))
    if (hit.length > 1) {
      candidates = hit.slice(-8).reverse().map((r, i) => ({
        index: i, requestId: r.id, method: r.method, status: r.status, url: r.url,
      }))
    }
  }
  let body = ''
  let bodyError = ''
  try {
    const res = await send(tabId, 'Network.getResponseBody', { requestId: row.id }, { timeoutMs: 8000 })
    body = res && res.body ? String(res.body) : ''
    if (res && res.base64Encoded) body = '[base64] ' + body
  } catch (error) {
    bodyError = String((error && error.message) || error)
  }
  // maxChars:0 = 全文（上限 2MB，给 saveTo 用）；默认仍只回 4000 字预览。
  const cap = Number(opts.maxChars) === 0 ? 2000000 : Math.max(200, Math.min(2000000, Number(opts.maxChars) || 4000))
  return {
    ok: true,
    requestId: row.id,
    method: row.method,
    url: row.url,
    status: row.status,
    statusText: row.statusText || '',
    mimeType: row.mimeType,
    failed: row.failed || '',
    requestHeaders: row.requestHeaders || {},
    postData: row.postData || '',
    postDataTruncated: row.postDataTruncated === true,
    responseHeaders: row.responseHeaders || {},
    bodyLength: body.length,
    body: body.length > cap ? body.slice(0, cap) : body,
    bodyTruncated: body.length > cap,
    candidates,
    bodyError,
  }
}

/* ------------------------------------------------------------------ */
/* 弹窗策略                                                            */
/* ------------------------------------------------------------------ */

export function getDialogPolicy(tabId) {
  return policies.get(tabId) || { mode: 'accept', promptText: '' }
}

export function setDialogPolicy(tabId, mode, promptText) {
  const m = String(mode || 'accept').toLowerCase()
  if (!['accept', 'dismiss', 'manual'].includes(m)) {
    throw cdpError('BAD_ARGS', 'mode 只能是 accept / dismiss / manual')
  }
  policies.set(tabId, { mode: m, promptText: String(promptText == null ? '' : promptText) })
  return { mode: m, promptText: String(promptText == null ? '' : promptText) }
}

export function recentDialogs(tabId, limit = MAX_DIALOG) {
  const rows = (dialogBuf.get(tabId) || []).slice(-Math.max(1, Math.min(MAX_DIALOG, Number(limit) || MAX_DIALOG)))
  return { rows, total: (dialogBuf.get(tabId) || []).length, policy: getDialogPolicy(tabId) }
}

/* ------------------------------------------------------------------ */
/* console / 网络                                                      */
/* ------------------------------------------------------------------ */

export function consoleRows(tabId, limit) {
  const cap = Math.max(1, Math.min(MAX_CONSOLE, Number(limit) || 80))
  const rows = consoleBuf.get(tabId) || []
  return { rows: rows.slice(-cap), total: rows.length, returned: Math.min(cap, rows.length) }
}

export function networkRows(tabId, limit) {
  const cap = Math.max(1, Math.min(MAX_NETWORK, Number(limit) || 80))
  const rows = networkBuf.get(tabId) || []
  return { rows: rows.slice(-cap), total: rows.length, returned: Math.min(cap, rows.length) }
}

export function clearNetwork(tabId) {
  const had = (networkBuf.get(tabId) || []).length
  networkBuf.delete(tabId)
  networkIndex.delete(tabId)
  return { cleared: had }
}

/** 最近的下载事件（Browser.downloadWillBegin / downloadProgress）。 */
export function downloadRows(tabId, limit) {
  const cap = Math.max(1, Math.min(MAX_DOWNLOAD, Number(limit) || 20))
  const rows = downloadBuf.get(tabId) || []
  return { rows: rows.slice(-cap), total: rows.length, returned: Math.min(cap, rows.length) }
}

/* ------------------------------------------------------------------ */
/* 导出 / 上传 / 拖拽 / 模拟 / 指标                                     */
/* ------------------------------------------------------------------ */

export async function printPdf(tabId, opts = {}) {
  await ensure(tabId, { domains: ['Page'] })
  const result = await send(tabId, 'Page.printToPDF', {
    printBackground: opts.printBackground !== false,
    paperWidth: Number(opts.paperWidth) || 8.27,
    paperHeight: Number(opts.paperHeight) || 11.69,
    marginTop: Number(opts.margin) || 0.4,
    marginBottom: Number(opts.margin) || 0.4,
    marginLeft: Number(opts.margin) || 0.4,
    marginRight: Number(opts.margin) || 0.4,
  }, { timeoutMs: CFG.pdfTimeoutMs })
  return { ok: true, data: result.data, format: 'pdf' }
}

export async function captureMhtml(tabId) {
  await ensure(tabId, { domains: ['Page'] })
  // 和截图一样：被遮挡的标签可能一直不返回，先激活再说。
  try { await send(tabId, 'Page.bringToFront', {}, { timeoutMs: 5000 }) } catch { /* 不行也照试 */ }
  const result = await send(tabId, 'Page.captureSnapshot', { format: 'mhtml' }, { timeoutMs: CFG.mhtmlTimeoutMs })
  return { ok: true, data: result.data, format: 'mhtml' }
}

/**
 * 截一块区域（视口 / 元素 / 自定义 clip）。
 * 为什么不用 chrome.tabs.captureVisibleTab：窗口被别的窗口压住、或 GPU 回读失败时，
 * 它直接报 "image readback failed"（本机实测复现），而且必须把窗口抢到最前。
 * CDP 的 Page.captureScreenshot 在 bringToFront 之后稳定得多。
 */
export async function captureRegion(tabId, opts = {}) {
  await ensure(tabId, { domains: ['Page'] })
  try { await send(tabId, 'Page.bringToFront', {}, { timeoutMs: 5000 }) } catch { /* 照截 */ }
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png'
  const params = { format, fromSurface: true, captureBeyondViewport: true }
  if (format === 'jpeg' && opts.quality) params.quality = Math.max(1, Math.min(100, Number(opts.quality)))
  if (opts.clip) {
    params.clip = {
      x: Number(opts.clip.x) || 0,
      y: Number(opts.clip.y) || 0,
      width: Math.max(1, Math.round(Number(opts.clip.width) || 1)),
      height: Math.max(1, Math.round(Number(opts.clip.height) || 1)),
      scale: Math.max(0.05, Math.min(3, Number(opts.scale) || 1)),
    }
  }
  const result = await send(tabId, 'Page.captureScreenshot', params, { timeoutMs: CFG.screenshotTimeoutMs })
  return {
    ok: true,
    data: result.data,
    format,
    clip: params.clip || null,
    width: params.clip ? Math.round(params.clip.width * params.clip.scale) : null,
    height: params.clip ? Math.round(params.clip.height * params.clip.scale) : null,
  }
}

export async function captureFullScreenshot(tabId, opts = {}) {
  await ensure(tabId, { domains: ['Page'] })
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png'
  const base = { format, fromSurface: true }
  if (opts.quality) base.quality = Math.max(1, Math.min(100, Number(opts.quality)))
  // 实测：标签被别的窗口盖住 / 在后台时，Page.captureScreenshot 会一直不返回
  // （不是慢，是永远不回）。bringToFront 只激活这个标签、不动窗口几何，
  // 之后截图就是毫秒级。这一步不能省，否则又要靠超时兜底。
  let broughtToFront = false
  try {
    await send(tabId, 'Page.bringToFront', {}, { timeoutMs: 5000 })
    broughtToFront = true
  } catch { /* 激活失败也照截，还有下面的超时+回退 */ }
  try {
    const result = await send(tabId, 'Page.captureScreenshot', { ...base, captureBeyondViewport: true }, { timeoutMs: CFG.screenshotTimeoutMs })
    return { ok: true, data: result.data, format, fullPage: true, broughtToFront }
  } catch (error) {
    // 整页截不动（巨长的页面/合成层卡住）时退回视口截图：宁可给一张，
    // 也别把整条命令挂死——没有超时的版本就是这么把 SW 卡到掉线的。
    if (error && error.errorCode === 'CDP_TIMEOUT') {
      const fallback = await send(tabId, 'Page.captureScreenshot', base, { timeoutMs: CFG.screenshotTimeoutMs })
      return { ok: true, data: fallback.data, format, fullPage: false, broughtToFront, note: '整页截图超时，退回视口截图' }
    }
    throw error
  }
}

/** 把本机文件设到 <input type=file>：不弹系统选择器。 */
export async function setFiles(tabId, selector, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map(String)
  if (!list.length) throw cdpError('BAD_ARGS', 'upload 需要 files（一个或多个绝对路径）')
  if (list.length > 20) throw cdpError('BAD_ARGS', '一次最多 20 个文件')
  await ensure(tabId, { domains: ['DOM'] })
  const doc = await send(tabId, 'DOM.getDocument', { depth: 0 })
  const hit = await send(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!hit || !hit.nodeId) {
    throw cdpError('NOT_FOUND', '页面上没有匹配 ' + selector + ' 的元素（要指向 input[type=file]）')
  }
  await send(tabId, 'DOM.setFileInputFiles', { files: list, nodeId: hit.nodeId })
  return { ok: true, files: list, nodeId: hit.nodeId }
}

/** 真的鼠标拖拽：按下 → 插值移动 → 抬起；中途失败一定补发 mouseReleased。 */
export async function drag(tabId, from, to, steps = 12) {
  await ensure(tabId, { domains: [] })
  const press = (x, y, extra = {}) => send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, ...extra })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 })
  await press(from.x, from.y)
  let released = false
  try {
    const n = Math.max(2, Math.min(60, Number(steps) || 12))
    for (let i = 1; i <= n; i++) {
      const x = from.x + ((to.x - from.x) * i) / n
      const y = from.y + ((to.y - from.y) * i) / n
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 })
      await sleep(12)
    }
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
    released = true
  } finally {
    if (!released) {
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
    }
  }
  return { ok: true, from, to }
}

const NETWORK_PRESETS = {
  slow3g: { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  fast3g: { latency: 150, downloadThroughput: 200 * 1024, uploadThroughput: 94 * 1024 },
  offline: { latency: 0, downloadThroughput: 0, uploadThroughput: 0, offline: true },
  reset: { latency: 0, downloadThroughput: -1, uploadThroughput: -1, offline: false },
}

export async function emulate(tabId, opts = {}) {
  // Emulation 域没有 enable 方法，别往 domains 里塞
  await ensure(tabId, { domains: ['Page', 'Network'] })
  const applied = {}

  const device = opts.device ? String(opts.device).toLowerCase() : ''
  if (device === 'reset') {
    await send(tabId, 'Emulation.clearDeviceMetricsOverride')
    applied.device = 'reset'
  } else if (device) {
    const preset = device === 'mobile'
      ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
      : device === 'desktop'
        ? { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
        : {
          width: Number(opts.width) || 390,
          height: Number(opts.height) || 844,
          deviceScaleFactor: Number(opts.deviceScaleFactor) || 1,
          mobile: opts.mobile !== false,
        }
    await send(tabId, 'Emulation.setDeviceMetricsOverride', preset)
    applied.device = { name: device, ...preset }
  }

  const network = opts.network ? String(opts.network).toLowerCase() : ''
  if (network) {
    const preset = NETWORK_PRESETS[network]
    if (!preset) throw cdpError('BAD_ARGS', 'network 只能是 slow3g / fast3g / offline / reset')
    await send(tabId, 'Network.emulateNetworkConditions', {
      offline: preset.offline === true,
      latency: preset.latency,
      downloadThroughput: preset.downloadThroughput,
      uploadThroughput: preset.uploadThroughput,
    })
    applied.network = { name: network, ...preset }
  }

  if (opts.cpuThrottlingRate != null) {
    const rate = Math.max(1, Math.min(20, Number(opts.cpuThrottlingRate) || 1))
    await send(tabId, 'Emulation.setCPUThrottlingRate', { rate })
    applied.cpuThrottlingRate = rate
  }

  if (!Object.keys(applied).length) {
    throw cdpError('BAD_ARGS', 'emulate 需要 device / network / cpuThrottlingRate 至少一项')
  }
  return { ok: true, applied }
}

const METRIC_NAMES = ['Nodes', 'Documents', 'Frames', 'JSEventListeners', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize']

export async function metrics(tabId) {
  await ensure(tabId, { domains: ['Performance'] })
  const result = await send(tabId, 'Performance.getMetrics')
  const map = {}
  for (const row of (result && result.metrics) || []) {
    if (METRIC_NAMES.includes(row.name)) map[row.name] = row.value
  }
  return {
    ok: true,
    nodes: map.Nodes ?? null,
    documents: map.Documents ?? null,
    frames: map.Frames ?? null,
    listeners: map.JSEventListeners ?? null,
    layouts: map.LayoutCount ?? null,
    layoutMs: Math.round((map.LayoutDuration || 0) * 1000),
    recalcStyles: map.RecalcStyleCount ?? null,
    scriptMs: Math.round((map.ScriptDuration || 0) * 1000),
    taskMs: Math.round((map.TaskDuration || 0) * 1000),
    heapMB: map.JSHeapUsedSize != null ? Math.round(map.JSHeapUsedSize / 1048576) : null,
  }
}

/** 通用透传：给没有专门动作的 CDP 方法留一个口子。 */
export async function raw(tabId, method, params) {
  if (!method) throw cdpError('BAD_ARGS', 'cdp 需要 method，例如 "Page.getNavigationHistory"')
  if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(String(method))) {
    throw cdpError('BAD_ARGS', 'method 要写成 Domain.method，例如 "Page.getNavigationHistory"')
  }
  const domains = [String(method).split('.')[0]]
  await ensure(tabId, { domains })
  return { ok: true, method, result: await send(tabId, method, params || {}) }
}
