/**
 * executor.js —— 扩展侧真正干活的地方（service worker）。
 *
 * 页面函数不在这里了：全在 page.js，import 一次拿到 globalThis.__dshPage。
 * 以前这里抄了一份、content.js 又抄一份，改一处忘另一处，才出现
 * 「eval 刷新前能用、刷新后不能用」这种鬼故事。
 *
 * 两条铁律没变：
 *  1. 注入页面的函数必须**完全自包含**（page.js 里的每个函数都是）。
 *  2. 返回值必须可结构化克隆：只回纯数据。
 *
 * 执行策略（2026-11-17 实测教训）：
 *  - world=MAIN 的请求（eval 默认）**直接**注入页面世界，别先去 ISOLATED
 *    绕一圈——MV3 的扩展世界禁 unsafe-eval，绕过去必然 CSP 报错。
 *  - ISOLATED 的请求先走常驻 content script（毫秒级），失败再 executeScript。
 *  - 超时按调用方给的 timeoutMs 走，超时明确报 PAGE_SCRIPT_TIMEOUT，
 *    并提示页面脚本可能还在跑（这是真的：超时只是我们不等了）。
 */

import './page.js'
import * as cdp from './cdp.js'
import { selectRows, ALL_ROWS, MAX_MERGE } from './netlog.js'
import { readTabEvents } from './tabevents.js'

const P = globalThis.__dshPage || {}
// 版本号单一来源 = manifest.json：这里从 manifest 读，不再手写（2026-11-20 收敛）。
// 测试里没有 chrome 环境时退回 '1.9.0'。
const EXT_VERSION = (() => {
  try { return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '1.9.0' } catch { return '1.9.0' }
})()

/** '1.12.0' vs '1.13.0' → -1 / 0 / 1（版本错位时决定提示「刷页面」还是「重载扩展」）。 */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* 执行：content script / executeScript 两条路 + 统一错误码              */
/* ------------------------------------------------------------------ */

const ERR = {
  NO_HANDLER: 'NO_HANDLER',
  NO_CONTENT_SCRIPT: 'NO_CONTENT_SCRIPT',
  PAGE_SCRIPT_TIMEOUT: 'PAGE_SCRIPT_TIMEOUT',
  INJECT_TIMEOUT: 'INJECT_TIMEOUT',
  INJECT_FAILED: 'INJECT_FAILED',
  PAGE_BUSY: 'PAGE_BUSY',
  PAGE_ERROR: 'PAGE_ERROR',
  NO_RESULT: 'NO_RESULT',
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  FRAME_STALE: 'FRAME_STALE',
}

/**
 * 注入没抢到主线程时，先分清「页面还在加载」和「页面忙」——
 * 以前这两种一律报成 EVAL_UNAVAILABLE，还劝人改用 flow，方向全错了：
 * 实际只要等一两秒就又能 eval（2026-11-18 在 Cloudflare 验证页上踩到两次）。
 */
async function pageBusyError(tabId) {
  let status = ''
  try { status = String((await chrome.tabs.get(tabId))?.status || '') } catch { /* 标签可能已经没了 */ }
  const loading = status === 'loading'
  return {
    ok: false,
    errorCode: ERR.PAGE_BUSY,
    retryable: true,
    tabStatus: status,
    error: loading
      ? '页面还在加载（tab.status=loading），注入没抢到。这不是 CSP 限制——等 1~2 秒重试就行。'
      : '页面主线程被占着，注入没抢到（tab.status=' + (status || '?') + '，常见于 Cloudflare 验证、大图/长渲染）。' +
        '这不是 CSP 限制，等 1~2 秒重试；连着几次都这样，再考虑 flow 的声明式步骤。',
  }
}

function timeoutError(ms, extra) {
  return {
    ok: false,
    errorCode: ERR.PAGE_SCRIPT_TIMEOUT,
    error: '页面脚本超时（' + ms + 'ms）。注意：脚本可能**仍在页面里执行**，别直接重试写操作；' +
      '先 read/extract 看一眼当前状态，或用 repeat 把长任务拆小。' + (extra ? ' ' + extra : ''),
    ms,
  }
}

/** 走常驻 content script（最快，主 frame 和装了 content script 的子 frame 都行）。 */
function viaContentScript(tabId, fnName, args, timeoutMs, frameId = 0) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => finish(timeoutError(timeoutMs)), Math.max(1000, timeoutMs))
    try {
      chrome.tabs.sendMessage(tabId, { type: 'dsh-chrome-page', name: fnName, args: args || {} }, { frameId: Number(frameId) || 0 }, (res) => {
        if (chrome.runtime.lastError) {
          const msg = String(chrome.runtime.lastError.message || '')
          // "Could not establish connection. Receiving end does not exist." = 页面没注入过
          finish({ ok: false, errorCode: ERR.NO_CONTENT_SCRIPT, error: msg })
          return
        }
        finish(res || { ok: false, errorCode: ERR.NO_RESULT, error: '页面没返回结果' })
      })
    } catch (error) {
      finish({ ok: false, errorCode: ERR.NO_CONTENT_SCRIPT, error: String((error && error.message) || error) })
    }
  })
}

/** 走 chrome.scripting.executeScript（页面世界 / 子 frame 只能走这条）。 */
async function viaInject(tabId, func, args, world, timeoutMs, frameId) {
  const target = { tabId }
  if (frameId != null) target.frameIds = [Number(frameId)]
  try {
    const pending = chrome.scripting.executeScript({ target, func, args: [args || {}], world })
    // 注入本身卡住（Chrome 157 偶发）时给个硬上限，别让调用方干等到天荒地老
    const hardStop = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('executeScript 注入超时'), { __injectTimeout: true })), Math.max(3000, timeoutMs + 5000)))
    const [result] = await Promise.race([pending, hardStop])
    if (!result) return { ok: false, errorCode: ERR.NO_RESULT, error: '页面没有返回结果' }
    if (result.error) return { ok: false, errorCode: ERR.PAGE_ERROR, error: String(result.error) }
    const payload = result.result
    // 把「实际执行在哪个帧」带回去（1.13.0）：frame 参数被忽略 / 落错帧时，
    // 以前只能看到一句莫名其妙的 ReferenceError，猜半天。
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { ...payload, execFrameId: result.frameId }
    }
    return payload
  } catch (error) {
    const msg = cleanError(error)
    if (error && error.__injectTimeout) {
      return {
        ok: false,
        errorCode: ERR.INJECT_TIMEOUT,
        error: 'executeScript 注入没返回（' + msg + '）。页面可能禁止注入、或这个标签是 chrome:// 内置页。刷新页面再试。',
      }
    }
    // 帧/标签已经不存在（页面导航过、子帧被移除）：Chrome 的原文是
    // "No frame with id N in tab with id M"。以前一律归成 INJECT_FAILED，回执说
    // 「这个页面不让注入扩展脚本」，排查方向直接被带到 CSP 上——2026-11-27 在
    // MOM 审批页点完「同意」触发 goBack 跳转后，对旧 frameId 调 outline 就中了这一枪。
    if (/No frame with id|Frame .*(?:not found|removed|detached)|frame .*was removed/i.test(msg)) {
      return {
        ok: false,
        errorCode: ERR.FRAME_STALE,
        error: `frame ${frameId == null ? '(未指定)' : frameId} 已经不存在了：${msg}。` +
          'iframe 里的页面一跳转，frameId 就变了（旧编号作废）。先 action=frames 重新拿帧表再操作。',
      }
    }
    if (/No tab with id/i.test(msg)) {
      return { ok: false, errorCode: 'TAB_NOT_FOUND', error: msg }
    }
    return { ok: false, errorCode: ERR.INJECT_FAILED, error: msg }
  }
}

/**
 * 统一执行入口。
 * @param {number} tabId
 * @param {string} fnName page.js 里的函数名
 * @param {object} args
 * @param {{world?:'MAIN'|'ISOLATED', timeoutMs?:number, frameId?:number}} opts
 */
async function exec(tabId, fnName, args, opts = {}) {
  const func = P[fnName]
  if (typeof func !== 'function') {
    return { ok: false, errorCode: ERR.NO_HANDLER, error: '扩展版本不匹配：page.js 里没有 ' + fnName + '。在 chrome://extensions 里重载扩展。' }
  }
  const world = opts.world === 'ISOLATED' ? 'ISOLATED' : (opts.world === 'MAIN' ? 'MAIN' : 'ISOLATED')
  const timeoutMs = Math.max(1000, Math.min(600000, Number(opts.timeoutMs) || 15000))
  const frameId = opts.frameId

  // 子 frame：先试该帧的 content script（1.9.0 起 all_frames:true，iframe 里也有），
  // 没有再走 executeScript。
  // 子 frame：world=MAIN 时必须直接注入页面世界——以前这里无条件先走常驻
  // content script（ISOLATED），而 ISOLATED 的 new Function 被扩展自己的 CSP 挡死，
  // 于是「子帧 eval 永远报 EVAL_CSP_BLOCKED」，看起来像页面 CSP（2026-11-21 修）。
  if (frameId != null && Number(frameId) !== 0) {
    if (world === 'MAIN') return viaInject(tabId, func, args, 'MAIN', timeoutMs, frameId)
    const viaCs = await viaContentScript(tabId, fnName, args, timeoutMs, frameId)
    if (viaCs && viaCs.ok !== false) return { ...viaCs, via: 'content-script@frame', execFrameId: Number(frameId) }
    if (viaCs && viaCs.errorCode && viaCs.errorCode !== ERR.NO_CONTENT_SCRIPT && viaCs.errorCode !== ERR.NO_RESULT) return viaCs
    return viaInject(tabId, func, args, world, timeoutMs, frameId)
  }

  // eval 类：直接进页面世界
  if (world === 'MAIN') {
    const r = await viaInject(tabId, func, args, 'MAIN', timeoutMs, null)
    if (r && r.ok !== false) return r
    if (r && r.errorCode !== 'EVAL_CSP_BLOCKED' && r.errorCode !== ERR.INJECT_FAILED && r.errorCode !== ERR.INJECT_TIMEOUT) return r
    // 页面世界也进不去/也禁 eval：退到常驻 content script 试一次（扩展世界也许允许）
    const r2 = await viaContentScript(tabId, fnName, args, timeoutMs)
    if (r2 && r2.ok !== false) return { ...r2, fellBack: 'content-script' }
    if (r2 && r2.errorCode === ERR.NO_CONTENT_SCRIPT) return r || r2
    // 两边都是「注入没抢到」：说成页面忙，别误报成 CSP 禁 eval
    if (r && r.errorCode === ERR.INJECT_TIMEOUT) return await pageBusyError(tabId)
    return {
      ...(r || r2),
      errorCode: 'EVAL_UNAVAILABLE',
      error: '这个页面两个世界都执行不了 JS：页面世界 ' + (r && r.errorCode || '失败') + '，扩展世界 ' + (r2 && r2.errorCode || '失败') +
        '。页面有严格 CSP 时这是预期的——eval 会自动改走 DevTools 通道（via:"cdp"）再试；如果还是不行，改用 flow 的声明式步骤（click/type/check/extract）。',
      triedMain: r && { errorCode: r.errorCode, error: r.error },
      triedIsolated: r2 && { errorCode: r2.errorCode, error: r2.error },
    }
  }

  // ISOLATED：先常驻 content script
  const r = await viaContentScript(tabId, fnName, args, timeoutMs)
  if (r && r.ok !== false) return r
  if (r && r.errorCode === 'EVAL_CSP_BLOCKED') {
    // 扩展 CSP 挡了 eval：自动退回页面世界（2026-11-17 的坑，必须自动回退）
    const r2 = await viaInject(tabId, func, args, 'MAIN', timeoutMs, null)
    if (r2) return { ...r2, fellBackTo: 'MAIN', isolatedError: r.error }
    return r
  }
  if (r && r.errorCode === ERR.PAGE_SCRIPT_TIMEOUT) return r
  if (r && r.errorCode && r.errorCode !== ERR.NO_CONTENT_SCRIPT && r.errorCode !== ERR.NO_RESULT) return r

  // 页面没注入过（扩展刷新前就开着的标签）：executeScript 兜底
  const r3 = await viaInject(tabId, func, args, 'ISOLATED', timeoutMs, null)
  if (r3 && r3.ok !== false) return { ...r3, via: 'executeScript' }
  if (r3 && r3.errorCode === ERR.INJECT_TIMEOUT) return await pageBusyError(tabId)
  return r3 || r
}

function cleanError(error) {
  const msg = String((error && error.message) || error)
  if (/Cannot access|The extensions gallery cannot be scripted|chrome:\/\//i.test(msg)) {
    return '这个页面不允许扩展注入（chrome://、扩展商店、部分内置页）：' + msg
  }
  return msg
}

function isRealTab(tab) {
  // Chrome 157 的普通标签 type 不再固定是 'tab'，用排除法：
  // 只剔除 devtools / app 这类不是网页的，剩下的都算。
  if (!tab || tab.id == null) return false
  const kind = String(tab.type || '')
  return kind !== 'devtools' && kind !== 'app'
}

/** 返回 { tab, via }：via 说明这个标签是怎么选出来的（调用方看不到 tabId 时很重要）。 */
let lastTabId = null   // 1.9.0：sticky 模式用的「上一次操作的标签」

async function resolveTab2(params = {}) {
  if (params.tabId != null && params.tabId !== '') {
    try {
      const tab = await chrome.tabs.get(Number(params.tabId))
      lastTabId = tab.id
      return { tab, via: 'tabId' }
    } catch {
      // 显式指定 tabId 就绝不能静默换标签：以前传入一个已关闭的 tabId，命令会悄悄
      // 落到「当前活动标签」上，请求甚至写操作打到别的页面（2026-11-20 实测）。
      throw Object.assign(
        new Error('tabId=' + params.tabId + ' 不存在（可能已经关掉了）。用 action=tabs 看当前标签，或改用 urlContains；确认要用活动标签就别传 tabId。'),
        { errorCode: 'TAB_NOT_FOUND' },
      )
    }
  }
  // sticky：多标签排查时不想每次都带 tabId，又不想被活动标签带走
  if (params.sticky === true && lastTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastTabId)
      return { tab, via: 'sticky' }
    } catch { lastTabId = null }
  }
  if (params.urlContains) {
    const needle = String(params.urlContains)
    const tabs = await chrome.tabs.query({})
    const pool = tabs.filter(isRealTab)
    const hit = pool.find((t) => (t.url || '').includes(needle)) || pool.find((t) => (t.title || '').includes(needle))
    if (hit) { lastTabId = hit.id; return { tab: hit, via: 'urlContains' } }
  }
  if (params.index != null) {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const pool = tabs.filter(isRealTab).sort((a, b) => a.index - b.index)
    if (pool[Number(params.index)]) { lastTabId = pool[Number(params.index)].id; return { tab: pool[Number(params.index)], via: 'index' } }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active) { lastTabId = active.id; return { tab: active, via: 'active' } }
  const [any] = await chrome.tabs.query({ active: true })
  if (any) { lastTabId = any.id; return { tab: any, via: 'active' } }
  throw new Error('没有可用的标签页（Chrome 是不是所有窗口都关了）')
}

async function resolveTab(params = {}) {
  return (await resolveTab2(params)).tab
}

function tabBrief(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    title: tab.title || '',
    url: tab.url || '',
    status: tab.status || '',
    audible: tab.audible === true,
    favIconUrl: tab.favIconUrl || '',
  }
}

/**
 * 动作后附一段「页面变化」：只回新增/消失的元素名，不重发整张清单。
 * 省的是「模型点完不知道变没变、再调一次 outline/read」的那一整轮上下文。
 * 失败一律静默——点击导致导航时页面上下文已经没了，这时候没有 delta 才是对的。
 */
async function attachDelta(tabId, data, opts = {}) {
  if (!data || data.ok === false) return data
  // flow 里每步都算 delta 是纯浪费：那些中间变化没人看
  if (opts.noDelta) return data
  try {
    const d = await exec(tabId, 'inPageDelta', {}, { timeoutMs: 2500 })
    if (d && d.ok !== false && (d.addedCount || d.removedCount)) {
      data.delta = { added: d.added, removed: d.removed, addedCount: d.addedCount, removedCount: d.removedCount }
    }
  } catch { /* 页面跳走了 / 没有 content script：不报错，也不假装没变化 */ }
  return data
}

/* ------------------------------------------------------------------ */
/* 页面探针：CDP 挂上之前的请求 / 日志（probe.js 在 MAIN world 记的）      */
/* ------------------------------------------------------------------ */

/** 读页面黑匣子；页面没有 probe.js（旧标签/旧扩展）时返回 null，不报错。 */
async function readProbe(tabId, timeoutMs = 4000) {
  const fn = () => {
    const p = window.__dshProbe
    if (!p) return null
    return {
      net: Array.isArray(p.net) ? p.net.slice(-200) : [],
      con: Array.isArray(p.con) ? p.con.slice(-200) : [],
      version: p.version || 0,
      startedAt: p.startedAt || 0,
    }
  }
  const r = await viaInject(tabId, fn, {}, 'MAIN', timeoutMs, null).catch(() => null)
  if (!r || r.ok === false || !r) return null
  return r.result || r
}

/* 探针是 per-window 的：主帧一份，每个 iframe 各一份。门户类系统真正的业务请求
 * 几乎都在 iframe 里，只读主帧等于什么都看不到（2026-11-21 排查流程设计器时踩到：
 * networkLog 只剩门户页的轮询，保存请求一条都没有）。下面三个读取器会被
 * executeScript 序列化进每个帧，必须完全自包含。 */
const probeReader = () => {
  const p = window.__dshProbe
  if (!p) return null
  return {
    net: Array.isArray(p.net) ? p.net.slice(-200) : [],
    con: Array.isArray(p.con) ? p.con.slice(-200) : [],
    version: p.version || 0,
    startedAt: p.startedAt || 0,
  }
}

const netBlockReader = () => {
  const s = window.__dshNetBlock
  if (!s) return null
  return {
    mode: s.mode || '',
    dryRun: Boolean(s.dryRun),
    installed: Boolean(s.installed),
    rules: Array.isArray(s.rules) ? s.rules.map((r) => String(r)) : [],
    total: Array.isArray(s.hits) ? s.hits.length : 0,
    hits: Array.isArray(s.hits) ? s.hits.slice(-60) : [],
  }
}

/** 列帧；拿不到就退回主帧，别让 networkLog 因为 webNavigation 失败整条挂掉。 */
async function frameList(tabId) {
  let frames = []
  try {
    const nav = chrome.webNavigation
    if (nav && typeof nav.getAllFrames === 'function') {
      frames = (await nav.getAllFrames({ tabId })) || []
    }
  } catch { frames = [] }
  const list = (frames || []).filter((f) => f && !f.errorOccurred)
  return list.length ? list : [{ frameId: 0, url: '' }]
}

/** 回执里标「这条命令在哪个帧跑的」（1.13.0）：frame 传了没生效时，人和模型都得看得出来。 */
async function frameUrlOf(tabId, frameId) {
  if (frameId == null) return ''
  try {
    const hit = (await frameList(tabId)).find((f) => Number(f.frameId) === Number(frameId))
    return hit ? String(hit.url || '') : ''
  } catch { return '' }
}

/** 逐帧注入读取器，返回 [{frameId, url, data}]。单帧失败不影响其它帧。 */
async function readInFrames(tabId, fn, timeoutMs = 2500) {
  let frames = []
  try { frames = await frameList(tabId) } catch { frames = [{ frameId: 0, url: '' }] }
  const out = []
  await Promise.all(frames.map(async (f) => {
    try {
      const r = await viaInject(tabId, fn, {}, 'MAIN', timeoutMs, f.frameId)
      if (r == null || (r && r.ok === false)) return
      out.push({ frameId: f.frameId, url: String(f.url || ''), data: r })
    } catch { /* 这一帧读不到就算了 */ }
  }))
  out.sort((a, b) => a.frameId - b.frameId)
  return out
}

/**
 * 聚合所有帧的页面黑匣子（主帧 + 每个 iframe）。
 * 每行带 frameId，调用方可以据此判断「这条请求是谁发的」。
 */
async function readProbeAll(tabId) {
  const parts = await readInFrames(tabId, probeReader)
  const net = []
  const con = []
  for (const part of parts) {
    const d = part.data
    if (!d || typeof d !== 'object') continue
    const frameUrl = String(part.url || '').slice(0, 200)
    for (const row of d.net || []) {
      if (row && typeof row === 'object') net.push({ ...row, frameId: part.frameId, frameUrl })
    }
    for (const row of d.con || []) {
      if (row && typeof row === 'object') con.push({ ...row, frameId: part.frameId })
    }
  }
  net.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  con.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  return {
    net,
    con,
    frames: parts.length,
    perFrame: parts.map((p) => ({
      frameId: p.frameId,
      url: String(p.url || '').slice(0, 120),
      net: (p.data && p.data.net) ? p.data.net.length : 0,
      con: (p.data && p.data.con) ? p.data.con.length : 0,
    })),
  }
}

/**
 * 合并「CDP 缓冲」和「页面探针」：按 key 去重，按时间排序，取最后 limit 条。
 * CDP 的行优先（状态更准），探针只补 CDP 挂上之前那段。
 */
function mergeProbeRows(cdpRows, probeRows, limit, keyOf) {
  const key = typeof keyOf === 'function' ? keyOf : (r) => `${r.method || ''}|${r.url || ''}|${r.status == null ? '' : r.status}`
  const cdp = cdpRows || []
  // CDP 挂上时刻：比它早的 probe 记录一定是历史，绝不参与去重——否则同一接口的
  // 多次轮询会因 url+status 相同被当成一条吞掉（2026-11-20 修）。
  const ts = cdp.map((r) => Number(r.ts) || 0)
  const cdpMinTs = ts.length ? Math.min.apply(null, ts) : Infinity
  const seen = new Set(cdp.map(key))
  const extra = (probeRows || []).filter((r) => {
    if (!r) return false
    if ((Number(r.ts) || 0) < cdpMinTs) return true   // 挂上之前的历史：全保留
    return !seen.has(key(r))                          // 同期才按 key 去重
  })
  const merged = [...extra, ...cdp].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  const cap = Math.max(1, Math.min(400, Number(limit) || 80))
  return {
    rows: merged.slice(-cap),
    source: extra.length ? (cdp.length ? 'mixed' : 'probe') : 'cdp',
    probeAdded: extra.length,
  }
}

/**
 * 网络行合并：CDP 优先，探针补「CDP 挂上之前」那段。
 *
 * 1.11.1：为什么不能照搬 mergeProbeRows 的 key ——Network 事件里没有 frameId，
 * CDP 行只有 method/url/status；探针行有 frameId。用 `frameId|method|url|status`
 * 当 key，同一条请求就会在列表里出现两行（一行带 f26、一行不带），排查时让人
 * 以为接口被调了两次。这里改成：两边都有 frameId 才比帧，没有就按时间窗口比。
 */
function mergeNetworkRows(cdpRows, probeRows, limit) {
  const cdp = cdpRows || []
  const keyOf = (r) => `${r.method || ''}|${r.url || ''}|${r.status == null ? '' : r.status}`
  const cdpKeys = cdp.map(keyOf)
  const cdpTs = cdp.map((r) => Number(r.ts) || 0)
  const cdpMinTs = cdpTs.length ? Math.min.apply(null, cdpTs) : Infinity
  const extra = (probeRows || []).filter((r) => {
    if (!r) return false
    const ts = Number(r.ts) || 0
    if (ts < cdpMinTs) return true // 挂上之前的历史：全保留
    const k = keyOf(r)
    for (let i = 0; i < cdp.length; i++) {
      if (cdpKeys[i] !== k) continue
      const c = cdp[i]
      const cf = Number(c.frameId || 0)
      const pf = Number(r.frameId || 0)
      if (cf && pf && cf !== pf) continue // 两个都有帧号且不同：确实是两件事
      if (Math.abs((Number(c.ts) || 0) - ts) <= 2000) return false // 同一条，CDP 已经有了
    }
    return true
  })
  const merged = [...extra, ...cdp].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  // 1.12.0：上限抬到 MAX_MERGE。原来是 400，环本身有 600 行时「合并阶段」就已经
  // 截掉了一截，过滤再看就永远看不到更早的那些（和 networkRows 的 limit 是两个坑）。
  const cap = Math.max(1, Math.min(MAX_MERGE, Number(limit) || 80))
  return { rows: merged.slice(-cap), source: extra.length ? (cdp.length ? 'mixed' : 'probe') : 'cdp', probeAdded: extra.length }
}

/* ------------------------------------------------------------------ */
/* CSP 兜底：用 DevTools 的 Runtime.evaluate 跑 eval                    */
/* ------------------------------------------------------------------ */

/**
 * 把用户的代码包成一条自包含表达式：同步/异步都吃，返回值统一序列化成 {t,s}。
 * pick 在页面里就做完，省得把几十万字的对象搬回扩展再筛。
 * 注意：这里面不能有反斜杠转义（外层是模板字符串），路径解析用 split/join 做。
 */
function buildCdpExpression(code, pick) {
  const pickLines = pick
    ? [
      '  const __pick = ' + JSON.stringify(String(pick)),
      '  if (__pick) {',
      "    const parts = __pick.split('[').join('.').split(']').join('').split('.').filter(Boolean)",
      '    const walk = (v, i) => {',
      '      if (i >= parts.length) return v',
      '      if (v == null) return undefined',
      '      const k = parts[i]',
      "      if (k === '*') {",
      '        if (Array.isArray(v)) return v.map((x) => walk(x, i + 1))',
      '        if (typeof v === "object") { const o = {}; for (const kk of Object.keys(v)) o[kk] = walk(v[kk], i + 1); return o }',
      '        return undefined',
      '      }',
      '      return walk(v[k], i + 1)',
      '    }',
      '    v = walk(v, 0)',
      '  }',
    ].join('\n')
    : ''
  return [
    '(async () => {',
    '  let v = await (' + code + '\n)',
    pickLines,
    '  let s',
    "  try { const j = JSON.stringify(v); s = (j === undefined ? String(v) : j) } catch (e) { s = String(v) }",
    '  return JSON.stringify({ t: typeof v, s })',
    '})()',
  ].filter((line) => line !== '').join('\n')
}

function parseCdpValue(raw) {
  if (typeof raw !== 'string') return { value: raw, type: typeof raw }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { return { value: raw, type: 'string' } }
  if (!parsed || typeof parsed !== 'object' || !('s' in parsed)) return { value: raw, type: 'string' }
  let value = parsed.s
  try { value = JSON.parse(parsed.s) } catch { /* 不是 JSON：保留原字符串 */ }
  return { value, type: parsed.t || typeof value }
}

/** 和 page.js 里 finish() 同样的深度裁剪规则（CDP 通道在扩展侧做）。 */
function trimEvalValue(value, limit) {
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
  return trimValue(value, limit, 0)
}

/** 把 CDP 拿到的值整理成和 inPageEval 一样的结果结构，调用方不用分两条路。 */
function buildEvalResult(parsed, opts = {}) {
  const runId = opts.runId || ''
  const via = opts.via ? { via: opts.via } : {}
  const picked = opts.picked ? { picked: opts.picked } : {}
  const value = parsed ? parsed.value : undefined
  const type = parsed ? parsed.type : 'undefined'
  if (value === undefined) return { ok: true, runId, value: undefined, type: 'undefined', ...via, ...picked }
  let json
  try { json = JSON.stringify(value) } catch { json = undefined }
  if (json === undefined) return { ok: true, runId, type, value: String(value), ...via, ...picked }
  const limit = Number(opts.maxChars) === 0
    ? 2000000
    : Math.max(500, Math.min(2000000, Number(opts.maxChars) || 12000))
  if (json.length > limit) {
    let trimmedJson = null
    try { trimmedJson = JSON.stringify(trimEvalValue(value, limit)) } catch { trimmedJson = null }
    if (trimmedJson !== null) {
      return {
        ok: true, runId, type, value: JSON.parse(trimmedJson), truncated: true, valueLength: json.length,
        note: '返回值 ' + json.length + ' 字，超过 maxChars=' + limit + '，已按字段裁剪。要全文：加大 maxChars，或加 saveTo 落盘。',
        ...via, ...picked,
      }
    }
    return {
      ok: true, runId, type, value: json.slice(0, limit), truncated: true, valueLength: json.length,
      note: '返回值 ' + json.length + ' 字，超过 maxChars=' + limit + '，且无法安全裁剪，只给前 ' + limit + ' 字（字符串预览，不是合法 JSON）。',
      ...via, ...picked,
    }
  }
  try { return { ok: true, runId, type, value: JSON.parse(json), ...via, ...picked } } catch { return { ok: true, runId, type, value: json, ...via, ...picked } }
}

async function waitTabReady(tabId, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return true
    } catch { return false }
    await sleep(150)
  }
  return false
}

/**
 * 这个标签现在是不是「真的有一份文档」。
 * 地址一样不等于页面还在：Chrome 的错误页地址栏仍是原 URL，但注入会被拒
 * （"Frame with ID 0 is showing error page"）。2026-11-17 实测踩到——
 * 服务器一挂，navigate 到同一地址被误判成「已到达（同文档）」。
 */
async function documentAlive(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(document.body && document.body.innerHTML.length > 0),
    })
    return Boolean(r && r.result)
  } catch (error) {
    const msg = String((error && error.message) || error)
    if (/showing error page|neterror/i.test(msg)) return false
    // 内置页/chrome:// 之类注入本来就失败：判断不了就按「活着」处理，
    // 别把 chrome://extensions 这种正常页面当成错误页反复刷。
    return true
  }
}

async function waitNavigation(tabId, timeoutMs = 20000, expectUrl) {  const start = Date.now()
  let lastUrl = ''
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (expectUrl) {
        if ((tab.url || '').includes(expectUrl)) return true
      } else if (tab.status === 'complete' && tab.url !== lastUrl) {
        // 给单页应用一点时间把内容画出来
        await sleep(400)
        return true
      }
      lastUrl = tab.url || ''
    } catch { return false }
    await sleep(200)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 截图（支持局部裁剪 / 缩放，省流量也省 token）                          */
/* ------------------------------------------------------------------ */

async function capture(tabId, opts = {}) {
  const tab = await chrome.tabs.get(tabId)

  // 裁剪区域：元素 → 元素矩形；给了 clip → 用它；否则整屏视口。
  // 全部换算成「文档坐标」（CDP 的 clip 用的是文档坐标）。
  let clip = null
  let cropInfo = null
  if (opts.selector) {
    const rect = await exec(tabId, 'inPageRect', { selector: opts.selector }, { timeoutMs: 6000 })
    if (rect && rect.ok !== false && rect.width > 0) {
      clip = { x: rect.pageX, y: rect.pageY, width: rect.width, height: rect.height }
      cropInfo = { clip, selector: opts.selector }
    } else {
      cropInfo = { selectorFailed: true, selector: opts.selector, error: rect && rect.error }
    }
  } else if (opts.clip && typeof opts.clip === 'object') {
    clip = {
      x: Number(opts.clip.x) || 0,
      y: Number(opts.clip.y) || 0,
      width: Number(opts.clip.width || opts.clip.w) || 0,
      height: Number(opts.clip.height || opts.clip.h) || 0,
    }
    cropInfo = { clip }
  } else {
    const vp = await exec(tabId, 'inPageViewport', {}, { timeoutMs: 6000 })
    if (vp && vp.ok !== false && vp.width > 0) {
      clip = { x: vp.scrollX, y: vp.scrollY, width: vp.width, height: vp.height }
    } else if (tab.width > 0 && tab.height > 0) {
      // 量不到视口（content script 还没就绪 / 刚 reload）时别放弃 clip：
      // 没有 clip，CDP 会按整个 surface 出图（dpr 倍），scale 也就无从换算——
      // 表现为「scale:0.5 反而产出 2 倍大的图」（2026-11-20 实测）。
      clip = { x: 0, y: 0, width: tab.width, height: tab.height }
      cropInfo = { clip, fallbackViewport: true }
    }
  }

  // 主路：CDP。captureVisibleTab 在窗口被压住/GPU 回读失败时直接报错，
  // 而且必须把窗口抢到最前——2026-11-17 本机实测。
  try {
    const shot = await cdp.captureRegion(tabId, { clip, scale: opts.scale, format: opts.format, quality: opts.quality })
    const mime = shot.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    const raw = `data:${mime};base64,${shot.data}`
    // CDP 的 clip.scale 吃的是设备像素，同一台机器 dpr=1.5 时 scale:0.5 出来
    // 的实际是原尺寸的两倍——metadata 说 960x462、文件却是 1920x924。
    // 显式给了 scale 就按「CSS 尺寸 × scale」重采样；没给就保持原生像素，
    // 但宽高一律回真实值（文件名里的 WxH 因此永远可信）。
    const wantScale = Number(opts.scale) > 0 ? Number(opts.scale) : 1
    const wantFit = shot.clip && Math.abs(wantScale - 1) > 1e-6
    const targetW = wantFit ? shot.clip.width * wantScale : null
    const targetH = wantFit ? shot.clip.height * wantScale : null
    const fit = await fitShot(raw, mime, opts.quality, targetW, targetH)
    const dataUrl = fit ? fit.dataUrl : raw
    const outW = fit ? fit.width : shot.width
    const outH = fit ? fit.height : shot.height
    return {
      ok: true,
      dataUrl,
      format: shot.format,
      url: tab.url,
      title: tab.title,
      width: outW,
      height: outH,
      resampled: fit ? fit.resized : false,
      crop: cropInfo ? { ...cropInfo, scale: wantScale, outWidth: outW, outHeight: outH } : null,
      via: 'cdp',
    }
  } catch (error) {
    // 只有「CDP 不可用」才退回老路；别的错误照实抛，别拿一张错图糊弄
    const code = String((error && error.errorCode) || '')
    if (!/^DEBUGGER_|^CDP_ENABLE_FAILED$/.test(code)) throw error
  }

  // 老路（兜底）：captureVisibleTab + OffscreenCanvas 裁
  await chrome.tabs.update(tabId, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  await sleep(250)
  let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  let width = null
  let height = null
  if (clip || (opts.scale && Number(opts.scale) > 0 && Number(opts.scale) < 1)) {
    try {
      const out = await cropPng(dataUrl, { x: clip ? clip.x : 0, y: clip ? clip.y : 0, width: clip ? clip.width : 0, height: clip ? clip.height : 0 }, Number(opts.scale) || 1, opts.selector ? null : (clip ? clip.width : null))
      if (out) { dataUrl = out.dataUrl; width = out.width; height = out.height }
    } catch { /* 裁不了就给原图 */ }
  }
  return { ok: true, dataUrl, format: 'png', url: tab.url, title: tab.title, width, height, crop: cropInfo, via: 'captureVisibleTab' }
}

/** 用 OffscreenCanvas 裁/缩；SW 里可用，失败就原图返回。 */
async function cropPng(dataUrl, clip, scale, viewportWidth) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  // 截图是物理像素，getBoundingClientRect 是 CSS 像素：按视口宽度换算比例
  const ratio = viewportWidth && viewportWidth > 0 ? bitmap.width / viewportWidth : 1
  const sx = clip ? Math.max(0, Math.min(bitmap.width - 1, Math.round(clip.x * ratio))) : 0
  const sy = clip ? Math.max(0, Math.min(bitmap.height - 1, Math.round(clip.y * ratio))) : 0
  const sw = clip && clip.width > 0 ? Math.min(bitmap.width - sx, Math.round(clip.width * ratio)) : bitmap.width
  const sh = clip && clip.height > 0 ? Math.min(bitmap.height - sy, Math.round(clip.height * ratio)) : bitmap.height
  const s = scale > 0 && scale <= 1 ? scale : 1
  const dw = Math.max(1, Math.round(sw * s))
  const dh = Math.max(1, Math.round(sh * s))
  const canvas = new OffscreenCanvas(dw, dh)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh)
  const outBlob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await outBlob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
  return {
    dataUrl: 'data:image/png;base64,' + btoa(binary),
    width: dw, height: dh,
    clip: { x: sx, y: sy, width: sw, height: sh },
    scale: s,
    ratio,
  }
}

/**
 * 把整张截图重采样到目标像素（不做裁剪）。
 * 用途：CDP 的 clip.scale 按设备像素算，高 DPI 屏上「scale:0.5」不但不省体积，
 * 反而等于原尺寸的 dpr 倍。统一在这里落到「CSS 尺寸 × scale」。
 * 失败就退原图——截图宁可不缩，也不能报错。
 */
async function fitShot(dataUrl, mime, quality, targetW, targetH) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null
  let bitmap
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
  } catch { return null }
  const srcW = bitmap.width
  const srcH = bitmap.height
  const w = Math.max(1, Math.round(Number(targetW) || srcW))
  const h = Math.max(1, Math.round(Number(targetH) || srcH))
  if (w === srcW && h === srcH) return { dataUrl, width: srcW, height: srcH, resized: false }
  try {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return { dataUrl, width: srcW, height: srcH, resized: false }
    ctx.drawImage(bitmap, 0, 0, w, h)
    const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await canvas.convertToBlob({
      type,
      ...(type === 'image/jpeg' && Number(quality) > 0 ? { quality: Math.max(0.1, Math.min(1, Number(quality) / 100)) } : {}),
    })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
    return { dataUrl: `data:${type};base64,` + btoa(binary), width: w, height: h, resized: true }
  } catch {
    return { dataUrl, width: srcW, height: srcH, resized: false }
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 主入口：执行一条命令，永远 resolve，错误装在 {ok:false,error,errorCode} 里。
 * @param {{action:string, params:object}} cmd
 */
export async function runCommand(cmd) {
  const action = String(cmd.action || '').trim()
  const p = cmd.params || {}
  const started = Date.now()
  let via = ''
  try {
    let data
    const loc = () => resolveTab2(p)
    switch (action) {
      case 'ping':
        data = {
          ok: true, pong: true, version: chrome.runtime.getManifest().version, pageVersion: P.VERSION || '',
          // 能力握手：插件按这份清单判断「这条命令这个扩展有没有」
          cdp: {
            available: Boolean(chrome.debugger && chrome.debugger.attach),
            attached: cdp.attachedTabs(),
            capabilities: cdp.capabilityList(),
          },
          now: Date.now(),
        }
        break

      case 'tabs': {
        const all = await chrome.tabs.query({})
        const windows = await chrome.windows.getAll({ populate: false })
        data = {
          ok: true,
          tabs: all.filter(isRealTab).map(tabBrief).sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index)),
          windows: windows.map((w) => ({ id: w.id, focused: w.focused, state: w.state, type: w.type, tabCount: all.filter((t) => t.windowId === w.id).length })),
          activeTabId: (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null,
        }
        break
      }

      case 'history': {
        // 浏览历史：回答「这个页面昨天是在哪个地址打开的」。
        // 走 chrome.history 而不是去啃 Chrome 的 History.sqlite —— 那东西正被
        // 浏览器独占（WAL 锁），还得自带 SQLite 解析器（2026-11-20 加）。
        if (!chrome.history || typeof chrome.history.search !== 'function') {
          throw Object.assign(
            new Error('扩展没有 history 权限：manifest 里加 "history" 后，到 chrome://extensions 点一次「重新加载」'),
            { errorCode: 'HISTORY_UNAVAILABLE' },
          )
        }
        const keyword = String(p.keyword || p.text || '').trim()
        const maxResults = Math.max(1, Math.min(1000, Number(p.limit) || 30))
        const days = Number(p.sinceDays)
        const query = { text: keyword, maxResults }
        if (Number.isFinite(days) && days > 0) query.startTime = Date.now() - days * 86400000
        const rows = await chrome.history.search(query)
        const list = rows
          .map((r) => ({
            url: r.url || '',
            title: r.title || '',
            lastVisitTime: r.lastVisitTime || 0,
            visitCount: r.visitCount || 0,
            typedCount: r.typedCount || 0,
          }))
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        data = { ok: true, keyword, count: list.length, rows: list }
        break
      }

      case 'open': {
        // 先开 about:blank 再导航：CDP 会话必须在真正的导航**之前**挂上，
        // 否则快页的 frameNavigated 事件在 attach 前就发完了，永远等不到。
        const waitUntil = p.wait === false ? 'none' : cdp.normaliseWaitUntil(p.waitUntil)
        const budget = cdp.navBudget(waitUntil, p.timeoutMs)
        let tab
        if (p.newWindow) {
          const win = await chrome.windows.create({ url: 'about:blank', focused: true })
          tab = win.tabs?.[0] || await chrome.tabs.query({ windowId: win.id }).then((rows) => rows[0])
        } else {
          tab = await chrome.tabs.create({ url: 'about:blank', active: p.active !== false, windowId: p.windowId })
        }
        let waiter = null
        let fallback = ''
        if (waitUntil !== 'none' && p.url && !String(p.url).startsWith('about:')) {
          try {
            await cdp.ensure(tab.id, { domains: ['Page'] })
            waiter = cdp.watchNavigation(tab.id, { waitUntil })
          } catch (error) {
            fallback = String((error && error.message) || error)
          }
        }
        if (p.url) await chrome.tabs.update(tab.id, { url: p.url })
        let arrival = null
        if (waiter) {
          arrival = await cdp.arrive(waiter, { timeoutMs: budget, pendingUrl: p.url || '', getTab: () => chrome.tabs.get(tab.id) })
        } else if (waitUntil !== 'none' && p.url && !String(p.url).startsWith('about:')) {
          const okLoad = await waitNavigation(tab.id, budget || 25000, p.expectUrl)
          arrival = { landed: okLoad, via: 'poll', loadPending: !okLoad, waitUntil }
        }
        data = {
          ok: true,
          tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)),
          arrival,
          ...(fallback ? { cdpFallback: fallback } : {}),
        }
        break
      }

      case 'focus': {
        const { tab, via: v } = await loc()
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
        data = { ok: true, tab: tabBrief(await chrome.tabs.get(tab.id)) }; via = v
        break
      }

      case 'close': {
        const { tab, via: v } = await loc()
        await chrome.tabs.remove(tab.id)
        data = { ok: true, closed: tabBrief(tab), tab: tabBrief(tab) }; via = v
        break
      }

      case 'navigate': {
        const { tab, via: v } = await loc(); via = v
        if (!p.url) throw new Error('navigate 需要 url')
        // 已经在目标地址：别刷一遍再干等（登录流程会 navigate 到当前页）。
        // 但地址一样 ≠ 页面还在：错误页的地址栏也长这样，得先探一下文档活没活。
        if (tab.url === p.url && tab.status === 'complete' && await documentAlive(tab.id)) {
          data = {
            ok: true, landed: true, loaded: true, sameDocument: true, waitedMs: 0,
            note: '已经是这个地址，没有重新导航', tab: tabBrief(tab),
          }
          break
        }
        const waitUntil = cdp.normaliseWaitUntil(p.waitUntil)
        const budget = cdp.navBudget(waitUntil, p.timeoutMs)
        // 只改了 #hash：页面不会重新加载，前端路由响不响应取决于页面自己
        // （Node-RED 编辑器就不会因为 hash 变化切画布，必须 RED.workspaces.show；
        //  2026-11-24 备份接口时按「已到达」误判过）。
        const hashOnly = Boolean(tab.url) && tab.url !== p.url
          && String(tab.url).split('#')[0] === String(p.url).split('#')[0]
        const hashNote = hashOnly
          ? '只改了 #hash：页面没有重新加载，是否切换视图取决于前端路由（例如 Node-RED 需要 RED.workspaces.show，改 hash 不切画布）。'
          : ''
        // 监听必须在 tabs.update 之前挂上：事件是「提交时就发」的，晚一步就等不到。
        let waiter = null
        let fallback = ''
        if (waitUntil !== 'none') {
          try {
            await cdp.ensure(tab.id, { domains: ['Page'] })
            waiter = cdp.watchNavigation(tab.id, { waitUntil })
          } catch (error) {
            // DevTools 占着标签 / 权限没给：退回轮询，但把原因带回去，不假装是事件判定
            fallback = String((error && error.message) || error)
          }
        }
        await chrome.tabs.update(tab.id, { url: p.url })
        if (waiter) {
          const arrival = await cdp.arrive(waiter, { timeoutMs: budget, pendingUrl: p.url, getTab: () => chrome.tabs.get(tab.id) })
          data = {
            ok: true,
            ...arrival,
            loaded: arrival.landed,
            ...(hashOnly ? { hashOnly: true, hashOnlyNote: hashNote } : {}),
            tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)),
          }
          break
        }
        const okLoad = await waitNavigation(tab.id, budget || 25000, p.expectUrl)
        data = {
          ok: true, landed: okLoad, loaded: okLoad, waitUntil, via: 'poll', loadPending: !okLoad,
          ...(fallback ? { cdpFallback: fallback } : {}),
          ...(hashOnly ? { hashOnly: true, hashOnlyNote: hashNote } : {}),
          tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)),
        }
        break
      }

      case 'reload': {
        const { tab, via: v } = await loc(); via = v
        await chrome.tabs.reload(tab.id, { bypassCache: p.bypassCache === true })
        await waitTabReady(tab.id, Number(p.timeoutMs) || 20000)
        data = { ok: true, tab: tabBrief(await chrome.tabs.get(tab.id)) }
        break
      }

      case 'back': {
        const { tab, via: v } = await loc(); via = v
        await chrome.tabs.goBack(tab.id)
        await sleep(600)
        await waitTabReady(tab.id, 8000)
        data = { ok: true, tab: tabBrief(await chrome.tabs.get(tab.id)) }
        break
      }

      case 'forward': {
        const { tab, via: v } = await loc(); via = v
        await chrome.tabs.goForward(tab.id)
        await sleep(600)
        await waitTabReady(tab.id, 8000)
        data = { ok: true, tab: tabBrief(await chrome.tabs.get(tab.id)) }
        break
      }

      case 'frames': {
        const { tab, via: v } = await loc(); via = v
        const navFrames = (await frameList(tab.id)).filter((f) => f.frameId !== 0 || f.url)
        const probe = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () => {
            // 同源父页里能拿到 frameElement；跨域会抛，拿不到就按「可见」处理，别误判
            let rect = null
            try { rect = window.frameElement ? window.frameElement.getBoundingClientRect() : null } catch { rect = null }
            return {
              title: document.title || '',
              url: location.href,
              textLength: String((document.body && document.body.innerText) || '').length,
              width: Math.round(rect && rect.width ? rect.width : window.innerWidth),
              height: Math.round(rect && rect.height ? rect.height : window.innerHeight),
              visible: rect ? (rect.width > 0 && rect.height > 0) : true,
            }
          },
        }).catch((error) => ({ __error: String((error && error.message) || error) }))
        const merged = new Map()
        for (const f of navFrames || []) {
          merged.set(f.frameId, { frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, error: f.errorOccurred ? 'load-error' : undefined })
        }
        for (const r of Array.isArray(probe) ? probe : []) {
          const cur = merged.get(r.frameId) || { frameId: r.frameId }
          if (r.result) {
            cur.title = r.result.title
            cur.url = r.result.url || cur.url
            cur.textLength = r.result.textLength
            cur.size = r.result.width + 'x' + r.result.height
            cur.visible = r.result.visible
          }
          if (r.error) cur.probeError = String(r.error).slice(0, 200)
          merged.set(r.frameId, cur)
        }
        data = {
          ok: true,
          count: merged.size,
          frames: [...merged.values()].sort((a, b) => a.frameId - b.frameId),
          probeError: Array.isArray(probe) ? undefined : (probe && probe.__error),
          hint: 'frameId 就是动作里的 frame 参数；同源 iframe 里 read/query/click/check/type 也会自动跨进去，不必手动指定。',
          tab: tabBrief(tab),
        }
        break
      }

      case 'rows': {
        const { tab, via: v } = await loc(); via = v
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageRows', { in: p.in, limit: p.limit }, { timeoutMs: Number(p.timeoutMs) || 20000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'read': {
        const { tab, via: v } = await loc(); via = v
        if (tab.url && /^(chrome|edge|about|devtools):/.test(tab.url)) throw new Error('这个页面不允许扩展注入：' + tab.url)
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageRead', {
          maxChars: p.maxChars, offset: p.offset, selector: p.selector, includeHtml: p.includeHtml, inputs: p.inputs,
          tables: p.tables,
        }, { timeoutMs: Number(p.timeoutMs) || 20000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'extract': {
        const { tab, via: v } = await loc(); via = v
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageExtract', {
          selector: p.selector, items: p.items, fields: p.fields, limit: p.limit,
          maxChars: p.maxChars, fullValues: p.fullValues,
        }, { timeoutMs: Number(p.timeoutMs) || 20000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'snapshot': {
        const { tab, via: v } = await loc(); via = v
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageSnapshot', { maxChars: p.maxChars, allFrames: p.allFrames }, { timeoutMs: Number(p.timeoutMs) || 20000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'query': {
        const { tab, via: v } = await loc(); via = v
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageQuery', { selector: p.selector, limit: p.limit }, { timeoutMs: Number(p.timeoutMs) || 15000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'outline': {
        const { tab, via: v } = await loc(); via = v
        await waitTabReady(tab.id, Number(p.timeoutMs) || 12000)
        const result = await exec(tab.id, 'inPageOutline', { limit: p.limit, selector: p.selector, lastRef: p.lastRef }, { timeoutMs: Number(p.timeoutMs) || 15000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'click': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageClick', {
          ref: p.ref, selector: p.selector, text: p.text, index: p.index,
          label: p.label, role: p.role, placeholder: p.placeholder, name: p.name, ariaLabel: p.ariaLabel,
          rowText: p.rowText, in: p.in, target: p.target, rowMatch: p.rowMatch,
          retry: p.retry, expect: p.expect,
          exact: p.exact,
          dryRun: p.dryRun,
        }, { timeoutMs: Math.max(8000, Number(p.timeoutMs) || 20000), frameId: p.frame })
        if (!result.ok || result.dryRun) { data = { ...result, tab: tabBrief(tab) }; break }
        await sleep(Number(p.afterMs) || 900)
        await waitTabReady(tab.id, 8000)
        const after = await chrome.tabs.get(tab.id).catch(() => tab)
        data = await attachDelta(tab.id, { ...result, tab: tabBrief(after) }, { noDelta: p.noDelta })
        break
      }

      case 'type': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageType', {
          ref: p.ref, selector: p.selector, hint: p.hint, value: p.value, clear: p.clear, submit: p.submit,
          name: p.name, label: p.label, placeholder: p.placeholder, ariaLabel: p.ariaLabel, role: p.role,
          verify: p.verify, submitMode: p.submitMode,
          dryRun: p.dryRun,
        }, { timeoutMs: Math.max(8000, Number(p.timeoutMs) || 20000), frameId: p.frame })
        if (result.dryRun) { data = { ...result, tab: tabBrief(tab) }; break }
        if (p.submit) {
          await sleep(400)
          await waitNavigation(tab.id, Number(p.timeoutMs) || 15000, p.expectUrl)
        }
        data = await attachDelta(tab.id, { ...result, tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)) }, { noDelta: p.noDelta })
        break
      }

      case 'select': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageSelect', { selector: p.selector, value: p.value, index: p.index }, { timeoutMs: 15000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'check': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageCheck', {
          ref: p.ref, selector: p.selector, checked: p.checked, index: p.index,
          name: p.name, label: p.label, text: p.text,
          rowText: p.rowText, in: p.in, target: p.target, rowMatch: p.rowMatch,
          retry: p.retry, dryRun: p.dryRun,
        }, { timeoutMs: Math.max(8000, Number(p.timeoutMs) || 25000), frameId: p.frame })
        data = await attachDelta(tab.id, { ...result, tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)) }, { noDelta: p.noDelta })
        break
      }

      case 'isChecked': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageIsChecked', {
          in: p.in, selector: p.selector, target: p.target, limit: p.limit,
        }, { timeoutMs: Number(p.timeoutMs) || 20000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'value': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageValue', {
          selector: p.selector, prop: p.prop, maxChars: p.maxChars, fullValue: p.fullValue, index: p.index,
        }, { timeoutMs: Number(p.timeoutMs) || 15000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'submit': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageType', {
          selector: p.selector || p.formSelector, hint: p.hint,
          value: p.value == null ? '' : p.value, clear: false, submit: true,
          submitMode: p.submitMode, verify: p.verify, dryRun: p.dryRun,
        }, { timeoutMs: Math.max(8000, Number(p.timeoutMs) || 20000), frameId: p.frame })
        if (result.dryRun) { data = { ...result, tab: tabBrief(tab) }; break }
        await sleep(400)
        await waitNavigation(tab.id, Number(p.timeoutMs) || 15000, p.expectUrl)
        data = { ...result, tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)) }
        break
      }

      case 'eval':
      case 'evalMain': {
        const { tab, via: v } = await loc(); via = v
        const world = action === 'evalMain' ? 'MAIN' : (p.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN')
        const runId = p.runId || (p.code ? 'run-' + Date.now().toString(36) : '')
        const timeoutMs = Number(p.timeoutMs) || 20000
        const result = await exec(tab.id, 'inPageEval', {
          code: p.code, runId, maxChars: p.maxChars, pick: p.pick,
        }, { world, timeoutMs, frameId: p.frame })
        // 页面 CSP 没给 unsafe-eval 时，page.js 的 new Function 两个世界都会被挡。
        // 这时改走 DevTools 的 Runtime.evaluate（不受页面 CSP 约束）。
        const needCdp = result && result.ok === false &&
          (result.errorCode === 'EVAL_CSP_BLOCKED' || result.errorCode === 'EVAL_UNAVAILABLE')
        if (!needCdp) {
          data = { ...result, world, runId, tab: tabBrief(tab) }
          break
        }
        const cdpRes = await cdp.evaluate(tab.id, {
          expression: buildCdpExpression(p.code, p.pick),
          frameId: p.frame,
          timeoutMs: timeoutMs + 5000,
        })
        data = {
          ...buildEvalResult(parseCdpValue(cdpRes.value), {
            runId, maxChars: p.maxChars, via: 'cdp', picked: p.pick,
          }),
          world: 'MAIN',
          fellBackTo: 'CDP',
          cdpNote: '页面 CSP 禁了 unsafe-eval（page.js 的 new Function 跑不了），这次改用 DevTools 的 Runtime.evaluate 执行，不受页面 CSP 限制。注意：这条通道里没有 window.__dshAborted，abort 停不下来。',
          firstError: { errorCode: result.errorCode, error: String(result.error || '').slice(0, 300) },
          tab: tabBrief(tab),
        }
        break
      }

      case 'fetch': {
        const { tab, via: v } = await loc(); via = v
        const frameId = p.frame
        const result = await exec(tab.id, 'inPageFetch', {
          url: p.url, method: p.method, headers: p.headers, body: p.body,
          json: p.json === true,
          // saveTo 时给全量：页面侧先截断，后面再想落盘就只剩半截
          maxChars: p.saveTo ? 0 : p.maxChars,
          timeoutMs: p.timeoutMs,
        }, { world: 'MAIN', timeoutMs: Math.max(4000, Number(p.timeoutMs) || 20000) + 8000, frameId })
        if (!result || result.ok === false) {
          data = { ...(result || { ok: false, error: '页面没有返回结果' }), method: String(p.method || 'GET').toUpperCase(), url: p.url, tab: tabBrief(tab) }
          break
        }
        data = {
          ...result,
          method: String(p.method || 'GET').toUpperCase(),
          frameUrl: result.frameUrl || (await frameUrlOf(tab.id, frameId)),
          tab: tabBrief(tab),
        }
        break
      }

      case 'abort': {
        const { tab, via: v } = await loc(); via = v
        // 1.11.1：先走页面里的协作式取消（只标记，代码自己查 __dshAborted 才退）。
        // 如果这条都送不进去（同步死循环把主线程占死 → 注入超时），或者用户显式
        // hard:true，就改走 CDP 的 Runtime.terminateExecution 硬停。
        const hard = p.hard === true
        let cooperative = null
        if (!hard) {
          cooperative = await exec(tab.id, 'inPageAbort', { runId: p.runId }, { timeoutMs: 8000 })
            .catch((error) => ({ ok: false, errorCode: (error && error.errorCode) || 'ABORT_FAILED', error: String((error && error.message) || error) }))
        }
        if (cooperative && cooperative.ok !== false) {
          data = { ...cooperative, hard: false, tab: tabBrief(tab) }
          break
        }
        const stop = await cdp.terminate(tab.id).catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
        data = {
          ok: stop.ok === true,
          hard: true,
          terminated: Boolean(stop.terminated),
          reason: hard ? 'explicit' : 'page-busy',
          cooperative: cooperative || null,
          note: stop.ok === true
            ? '已让渲染进程终止当前正在跑的脚本（页面自己的长任务也会一起被打断）。'
            : '硬停也失败了：' + (stop.error || '未知原因'),
          tab: tabBrief(tab),
        }
        break
      }

      case 'wait': {
        const { tab, via: v } = await loc(); via = v
        // 纯等待（等动画/等节流恢复）：不碰页面，最多 30 秒
        if (p.time != null && !p.selector && !p.text && !p.textGone && !p.count && !p.changed) {
          const seconds = Math.max(0, Math.min(30, Number(p.time) || 0))
          await sleep(seconds * 1000)
          data = { ok: true, matched: 'time', waited: seconds, ms: seconds * 1000, tab: tabBrief(tab) }
          break
        }
        const result = await exec(tab.id, 'inPageWait', {
          selector: p.selector, text: p.text, urlContains: p.urlContains,
          timeoutMs: p.timeoutMs, pollMs: p.pollMs, visible: p.visible,
          exact: p.exact, changed: p.changed, value: p.value, until: p.until, count: p.count,
          textGone: p.textGone,
        }, { timeoutMs: (Number(p.timeoutMs) || 10000) + 6000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'scroll': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageScroll', { selector: p.selector, dy: p.dy, dx: p.dx, toBottom: p.toBottom, smooth: p.smooth }, { timeoutMs: 15000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'screenshot': {
        const { tab, via: v } = await loc(); via = v
        if (p.fullPage) {
          // 整页截图走 CDP：captureVisibleTab 只能拿视口那一屏
          const shot = await cdp.captureFullScreenshot(tab.id, { format: p.format, quality: p.quality })
          data = {
            ok: true,
            dataUrl: `data:image/${shot.format === 'jpeg' ? 'jpeg' : 'png'};base64,${shot.data}`,
            fullPage: shot.fullPage !== false,
            ...(shot.note ? { note: shot.note } : {}),
            url: tab.url, title: tab.title, tab: tabBrief(tab),
          }
          break
        }
        const result = await capture(tab.id, { selector: p.selector, clip: p.clip, scale: p.scale, format: p.format, quality: p.quality })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      /* ---------------------- CDP 一族（真实输入 / 抓取 / 导出） ---------------------- */

      case 'press': {
        const { tab, via: v } = await loc(); via = v
        // 有 ref/selector 就先聚焦：真实按键只会送到当前焦点
        let focused = null
        if (p.ref || p.selector) {
          const f = await exec(tab.id, 'inPageFocus', { ref: p.ref, selector: p.selector }, { timeoutMs: 8000, frameId: p.frame })
          // 错误码要带出去：REF_STALE / NOT_FOUND 不能被压成 COMMAND_FAILED
          if (f && f.ok === false) throw Object.assign(new Error(f.error || '聚焦失败'), { errorCode: f.errorCode || 'NOT_FOUND' })
          focused = f && f.focused
        }
        const info = await cdp.press(tab.id, p.key, p.modifiers)
        data = await attachDelta(tab.id, { ok: true, pressed: info, focused, tab: tabBrief(tab) }, { noDelta: p.noDelta })
        break
      }

      case 'hover': {
        const { tab, via: v } = await loc(); via = v
        let point = null
        if (p.x != null && p.y != null) point = { x: Number(p.x), y: Number(p.y) }
        else if (p.ref || p.selector) {
          const r = await exec(tab.id, 'inPageRect', { ref: p.ref, selector: p.selector }, { timeoutMs: 8000, frameId: p.frame })
          if (!r || r.ok === false) throw Object.assign(new Error((r && r.error) || '量不到元素位置'), { errorCode: (r && r.errorCode) || 'NOT_FOUND' })
          point = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        } else {
          throw new Error('hover 需要 ref / selector，或 x+y 坐标')
        }
        const out = await cdp.hover(tab.id, point)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'storage': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageStorage', {
          kind: p.kind, op: p.op, key: p.key, value: p.value, limit: p.limit, maxChars: p.maxChars,
        }, { timeoutMs: 12000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'highlight': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageHighlight', {
          ref: p.ref, selector: p.selector, color: p.color, clear: p.clear,
        }, { timeoutMs: 10000, frameId: p.frame })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'dialog': {
        const { tab, via: v } = await loc(); via = v
        const sub = String(p.op || 'get').toLowerCase()
        if (sub === 'set' || p.mode) cdp.setDialogPolicy(tab.id, p.mode, p.promptText)
        const recent = cdp.recentDialogs(tab.id)
        data = { ok: true, ...recent, tab: tabBrief(tab) }
        break
      }

      case 'logs': {
        const { tab, via: v } = await loc(); via = v
        // 先 attach + enable：日志只从「挂上之后」开始抓，先说清楚，别让模型以为能回看
        await cdp.ensure(tab.id, { domains: ['Runtime', 'Log'] })
        const out = cdp.consoleRows(tab.id, p.limit)
        // CDP 挂上之前的报错，靠页面探针补（用户点完才来问的典型场景）。
        // 探针是 per-window 的：主帧 + 每个 iframe 都要读，否则只能看到壳页那几条。
        const probe = await readProbeAll(tab.id)
        const merged = mergeProbeRows(out.rows, probe.con, p.limit, (r) => `${r.level || ''}|${String(r.text || '').slice(0, 120)}`)
        const level = p.level ? String(p.level).toLowerCase() : ''
        const rows = level ? merged.rows.filter((r) => String(r.level).toLowerCase() === level) : merged.rows
        data = {
          ok: true, rows, total: out.total + merged.probeAdded, returned: rows.length, level,
          source: merged.source, probeRows: merged.probeAdded, probeFrames: probe.perFrame.length,
          tab: tabBrief(tab),
        }
        break
      }

      case 'networkLog': {
        const { tab, via: v } = await loc(); via = v
        await cdp.ensure(tab.id, { domains: ['Network'] })
        // 1.12.0：先取整个环，再过滤，最后才截断。
        // 以前是 networkRows(tabId, limit) → merge(limit) → filter，limit 小的时候
        // 等于「只在最新 N 条里找」，缓冲里明明有的请求会过滤成 0 条（2026-11-23 实测）。
        const out = cdp.networkRows(tab.id, ALL_ROWS)
        const probe = await readProbeAll(tab.id)
        // 跨帧 + 跨来源去重（见 mergeNetworkRows 注释）
        const merged = mergeNetworkRows(out.rows, probe.net, ALL_ROWS)
        const sel = selectRows(merged.rows, {
          filter: p.filter, ignore: p.ignore, frame: p.frame,
          limit: p.limit, collapse: p.collapse !== false, unique: p.unique === true,
        })
        const rows = sel.rows
        // 有请求体的行标出来：排查「保存到底提交了什么」时一眼能找到那条
        const withBody = rows.filter((r) => r.body).length
        // 1.11.1：有请求头的行（探针记的 headers / CDP 记的 requestHeaders）单列，
        // 数据权限这类问题经常只看头就水落石出。
        const headersOfRow = (r) => r.requestHeaders || r.headers || null
        const withHeaders = rows.filter((r) => {
          const h = headersOfRow(r)
          return h && Object.keys(h).length
        }).length
        data = {
          ok: true, rows, total: out.total + merged.probeAdded, matched: sel.matched,
          returned: rows.length, truncated: sel.truncated, folded: sel.folded, ignored: sel.ignored,
          unique: sel.unique, uniqueDropped: sel.uniqueDropped,
          filter: sel.filter, frame: p.frame != null ? Number(p.frame) : null, ignore: p.ignore || null,
          source: merged.source, probeRows: merged.probeAdded, withBody, withHeaders,
          probeFrames: probe.perFrame.length, framesWithTraffic: probe.perFrame.filter((f) => f.net > 0).length,
          hint: [
            sel.truncated ? `匹配 ${sel.matched} 条，只给了最新 ${sel.kept} 条：要看更早的加大 limit（上限 400），或加 filter 缩小范围。` : '',
            sel.unique ? `已按接口去重：${sel.uniqueDropped} 条重复调用合并（×N 是次数）。要看逐条加 unique:false。` : '',
            sel.folded ? `相邻重复请求折叠了 ${sel.folded} 条（行尾 ×N 是次数）；要逐条看加 collapse:false。` : '',
            sel.ignored ? `ignore 正则排掉 ${sel.ignored} 条（心跳这类）。` : '',
            withBody ? '标了「有请求体」的行可以用 networkDetail（filter 或 index）看提交内容。' : '',
            withHeaders ? '⚑ 开头的行带了 X-*/moduleCode 这类头：数据权限、租户、版本往往由头决定，先看 networkDetail 的头，再怀疑数据。' : '',
          ].filter(Boolean).join(' ') || '没有带请求体/请求头的记录：可能都是 GET，或请求发生在 probe 装上之前（刷新页面后才有）。',
          tab: tabBrief(tab),
        }
        break
      }

      case 'tabEvents': {
        // 标签页开/关留证：回答「点一下自动开了个标签又自动消失」这类问题。
        // 数据来自 tabevents.js 的环（SW 内），关掉的标签会留一份网络/console 快照。
        const op = String(p.op || 'list').toLowerCase()
        const snap = readTabEvents({
          op, tabId: p.tabId, limit: p.limit, filter: p.filter, ignore: p.ignore,
          frame: p.frame, collapse: p.collapse !== false,
        })
        data = { ok: true, op, ...snap }
        break
      }

      case 'networkDetail': {
        const { tab, via: v } = await loc(); via = v
        // 1.19.0：探针行有 id（p1/p2…）了，按 id 或 source:"probe" 直接走探针，
        // 不再被 CDP 缓冲里同名的新请求抢走（2026-11-26 排查退库接口时踩过）。
        const wantProbe = String(p.source || '').toLowerCase() === 'probe' || /^p\d+$/.test(String(p.requestId || ''))
        let cdpMiss = null
        if (!wantProbe) {
          try {
            const out = await cdp.networkDetail(tab.id, {
              requestId: p.requestId, index: p.index, filter: p.filter, match: p.match, maxChars: p.maxChars,
            })
            data = { ok: true, ...out, source: 'cdp', tab: tabBrief(tab) }
            break
          } catch (error) { cdpMiss = error }
        }
        // 明确要 cdp 的，不在探针里兜底——否则用户以为看的是 CDP 那条，实际是历史记录。
        if (cdpMiss && String(p.source || '').toLowerCase() === 'cdp') throw cdpMiss
        // CDP 缓冲里没有（请求发生在挂上之前）：从各帧探针里找，probe 带请求体/请求头
        const probe = await readProbeAll(tab.id)
        const test = cdp.urlMatcher(p.filter, String(p.match || '').toLowerCase())
        let rows = p.filter ? probe.net.filter((r) => test(r.url)) : probe.net.slice()
        if (p.frame != null) rows = rows.filter((r) => Number(r.frameId || 0) === Number(p.frame))
        let row = null
        if (p.requestId) row = rows.find((r) => String(r.id || '') === String(p.requestId)) || null
        if (!row && p.index != null) {
          const idx = Number(p.index) || 0
          row = rows[rows.length - 1 - Math.max(0, idx)] || null
        }
        if (!row && rows.length) row = rows[rows.length - 1]
        if (!row) {
          throw cdpMiss || Object.assign(new Error('网络缓冲和页面探针里都没有匹配的请求'), { errorCode: 'NOT_FOUND' })
        }
        data = {
          ok: true, source: 'probe', fromProbe: true,
          requestId: row.id || '', frameId: row.frameId, frameUrl: row.frameUrl,
          method: row.method, url: row.url, status: row.status ?? null, statusText: '',
          failed: row.failed || '',
          requestHeaders: row.headers || {},
          responseHeaders: {},
          postData: row.body || '', postDataTruncated: Boolean(row.bodyTruncated),
          body: row.resp || '', bodyLength: Number.isFinite(Number(row.respLen)) ? Number(row.respLen) : String(row.resp || '').length,
          bodyTruncated: Boolean(row.respTruncated),
          bodyError: row.resp
            ? ''
            : '探针默认不记响应体：先在页面里设 window.__dshProbeRespLimit = 2000 再复现一次，或用 fetch 直接打这个接口',
          tab: tabBrief(tab),
        }
        break
      }

      case 'networkClear': {
        const { tab, via: v } = await loc(); via = v
        // 没挂 CDP 时清了等于没清，顺手把监听挂上（2026-11-18 排查过这条）
        await cdp.ensure(tab.id, { domains: ['Network'] })
        const out = cdp.clearNetwork(tab.id)
        // 1.9.0：连页面探针里的历史一起清，否则下次 networkLog 又把它当 probe 捞回来
        // 2026-11-21：改成清所有帧，不只是主帧
        const clearProbe = () => {
          const p = window.__dshProbe
          if (p && Array.isArray(p.net)) { const n = p.net.length; p.net.length = 0; return n }
          return 0
        }
        let probeCleared = 0
        for (const f of await frameList(tab.id)) {
          const pr = await viaInject(tab.id, clearProbe, {}, 'MAIN', 3000, f.frameId).catch(() => null)
          if (typeof pr === 'number') probeCleared += pr
        }
        data = { ok: true, ...out, probeCleared, capturing: true, tab: tabBrief(tab) }
        break
      }

      case 'replay': {
        const { tab, via: v } = await loc(); via = v
        // 1) 找到要重放的那条：CDP 优先（头/体都全），退回页面探针（凭据已脱敏）
        let rec = null
        try {
          rec = await cdp.networkDetail(tab.id, { requestId: p.requestId, index: p.index, filter: p.filter, match: p.match })
          rec.source = 'cdp'
        } catch (error) {
          const probe = await readProbeAll(tab.id)
          const test = cdp.urlMatcher(p.filter, String(p.match || '').toLowerCase())
          let rows = p.filter ? probe.net.filter((r) => test(r.url)) : probe.net.slice()
          if (p.frame != null) rows = rows.filter((r) => Number(r.frameId || 0) === Number(p.frame))
          let row = null
          if (p.requestId) row = rows.find((r) => String(r.id || '') === String(p.requestId)) || null
          if (!row && p.index != null) row = rows[rows.length - 1 - Math.max(0, Number(p.index) || 0)] || null
          if (!row && rows.length) row = rows[rows.length - 1]
          if (!row) throw error
          rec = {
            source: 'probe', requestId: row.id || '', method: row.method, url: row.url,
            status: row.status ?? null, requestHeaders: row.headers || {}, postData: row.body || '',
            postDataTruncated: row.bodyTruncated === true,
            postDataLength: Number.isFinite(Number(row.bodyLen)) ? Number(row.bodyLen) : String(row.body || '').length,
          }
        }

        // 2) 拼这次要发的请求：原样 + 覆盖（dropHeaders 删、headers 加/改，值为空即删）
        const headers = {}
        for (const [k, val] of Object.entries(rec.requestHeaders || {})) headers[k] = String(val)
        const dropList = (Array.isArray(p.dropHeaders) ? p.dropHeaders : []).map((x) => String(x).toLowerCase())
        if (dropList.length) {
          for (const k of Object.keys(headers)) if (dropList.includes(k.toLowerCase())) delete headers[k]
        }
        if (p.headers && typeof p.headers === 'object') {
          for (const [k, val] of Object.entries(p.headers)) {
            const hit = Object.keys(headers).find((key) => key.toLowerCase() === String(k).toLowerCase())
            if (val === null || val === undefined || val === '') {
              if (hit) delete headers[hit]
            } else if (hit) headers[hit] = String(val)
            else headers[String(k)] = String(val)
          }
        }
        const method = String(p.method || rec.method || 'GET').toUpperCase()
        const body = p.body != null ? String(p.body) : String(rec.postData || '')
        const mask = (h) => {
          const out = {}
          for (const [k, val] of Object.entries(h || {})) out[k] = /^(authorization|cookie)$/i.test(k) ? '***' : val
          return out
        }
        if (p.dryRun === true) {
          data = {
            ok: true, dryRun: true, source: rec.source, method, url: rec.url,
            headers: mask(headers), body: body.slice(0, 1200), bodyLength: body.length,
            tab: tabBrief(tab),
          }
          break
        }

        // 3) 在页面里真发（带 cookie；netBlock 装了规则照样只登记不发送）
        const result = await exec(tab.id, 'inPageReplay', {
          url: rec.url, method, headers, body, maxChars: p.maxChars,
        }, { timeoutMs: Math.max(4000, Math.min(120000, Number(p.timeoutMs) || 30000)) + 4000, frameId: p.frame })
        // 命令本身算成功（请求确实发出去了），fetch 失败放在 sent:false + error 里
        data = {
          ...result, ok: true, sent: result.ok !== false, source: rec.source, method, url: rec.url,
          requestBodyTruncated: rec.postDataTruncated === true,
          requestBodyLength: Number.isFinite(Number(rec.postDataLength)) ? Number(rec.postDataLength) : body.length,
          tab: tabBrief(tab),
        }
        break
      }

      case 'netBlock': {
        const { tab, via: v } = await loc(); via = v
        const op = String(p.op || 'set').toLowerCase()
        if (op === 'hits' || op === 'get') {
          const parts = await readInFrames(tab.id, netBlockReader)
          const hits = []
          const rules = []
          let mode = 'block'
          let dryRun = false
          let installed = false
          for (const part of parts) {
            const d = part.data
            if (!d) continue
            installed = installed || Boolean(d.installed)
            mode = d.mode || mode
            dryRun = dryRun || Boolean(d.dryRun)
            for (const r of d.rules || []) if (!rules.includes(r)) rules.push(r)
            for (const h of d.hits || []) hits.push({ ...h, frameId: part.frameId })
          }
          hits.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
          data = {
            ok: true, op, tab: tabBrief(tab), frames: parts.length,
            installed, mode, dryRun, rules,
            total: hits.length,
            hits: hits.slice(-Math.max(1, Math.min(60, Number(p.limit) || 20))),
          }
          break
        }
        if (op === 'clear' || op === 'off') {
          // 作用到所有帧：这两个是「收拾现场」的操作，只清主帧会留下还在拦截的
          // iframe（2026-11-21 实测踩到：off 之后 hits 里还有记录）。
          let cleared = 0
          const applied = []
          for (const f of await frameList(tab.id)) {
            const r = await viaInject(tab.id, P.inPageNetBlock, { op }, 'MAIN', 8000, f.frameId).catch(() => null)
            if (!r || r.ok === false) continue
            cleared += Number(r.cleared) || 0
            applied.push({ frameId: f.frameId, cleared: r.cleared, installed: r.installed })
          }
          data = {
            ok: true, op, tab: tabBrief(tab), cleared,
            applied,
            note: '已清掉各帧的拦截记录与规则；刷新页面可彻底移除钩子。',
          }
          break
        }

        // set：装到指定帧；allFrames 时逐帧装（生产排查常用：不知道请求是哪个 iframe 发的）
        const targets = p.allFrames === true ? (await frameList(tab.id)).map((f) => f.frameId) : [Number(p.frame || 0)]
        const applied = []
        for (const frameId of targets) {
          const r = await viaInject(tab.id, P.inPageNetBlock, {
            op: 'set', patterns: p.patterns, dryRun: p.dryRun, blockMode: p.blockMode,
          }, 'MAIN', 10000, frameId)
          if (!r || r.ok === false) {
            throw Object.assign(new Error((r && r.error) || ('netBlock 注入帧 ' + frameId + ' 失败')), { errorCode: (r && r.errorCode) || 'INJECT_FAILED' })
          }
          applied.push({ frameId, ...r })
        }
        data = {
          ok: true, op: 'set', tab: tabBrief(tab),
          mode: applied[0] && applied[0].mode,
          dryRun: applied[0] && applied[0].dryRun,
          rules: applied[0] && applied[0].rules,
          applied: applied.map((a) => ({ frameId: a.frameId, mode: a.mode, dryRun: a.dryRun, rules: a.rules, installedAt: a.installedAt })),
          note: applied[0] && applied[0].note,
        }
        break
      }

      case 'downloads': {
        const { tab, via: v } = await loc(); via = v
        // 下载事件只在 CDP 挂着时才有；先确保挂上，再回最近的记录。
        await cdp.ensure(tab.id, { domains: [] }).catch(() => {})
        const out = cdp.downloadRows(tab.id, p.limit)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'pdf': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.printPdf(tab.id, p)
        data = { ok: true, ...out, url: tab.url, title: tab.title, tab: tabBrief(tab) }
        break
      }

      case 'mhtml': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.captureMhtml(tab.id)
        data = { ok: true, ...out, url: tab.url, title: tab.title, tab: tabBrief(tab) }
        break
      }

      case 'upload': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.setFiles(tab.id, p.selector, p.files)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'drag': {
        const { tab, via: v } = await loc(); via = v
        const point = async (value, label) => {
          if (value == null) throw new Error('drag 需要 from 和 to（选择器 / ref:e7 / "x,y" 坐标）')
          if (typeof value === 'object') {
            if (value.x != null && value.y != null) return { x: Number(value.x), y: Number(value.y) }
            if (value.ref) {
              const r = await exec(tab.id, 'inPageRect', { ref: value.ref }, { timeoutMs: 8000 })
              if (!r || r.ok === false) throw Object.assign(new Error(label + ' 的 ref 找不到：' + value.ref), { errorCode: (r && r.errorCode) || 'REF_STALE' })
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
            }
            if (value.selector) {
              const r = await exec(tab.id, 'inPageRect', { selector: value.selector }, { timeoutMs: 8000 })
              if (!r || r.ok === false) throw Object.assign(new Error(label + ' 找不到：' + value.selector), { errorCode: (r && r.errorCode) || 'NOT_FOUND' })
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
            }
            throw new Error(label + ' 参数看不懂：' + JSON.stringify(value))
          }
          const text = String(value).trim()
          const coords = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
          if (coords) return { x: Number(coords[1]), y: Number(coords[2]) }
          if (/^ref:/i.test(text)) {
            const r = await exec(tab.id, 'inPageRect', { ref: text.slice(4) }, { timeoutMs: 8000 })
            if (!r || r.ok === false) throw Object.assign(new Error(label + ' 的 ref 找不到：' + text.slice(4)), { errorCode: (r && r.errorCode) || 'REF_STALE' })
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          }
          const r = await exec(tab.id, 'inPageRect', { selector: text }, { timeoutMs: 8000 })
          if (!r || r.ok === false) throw Object.assign(new Error(label + ' 找不到：' + text), { errorCode: (r && r.errorCode) || 'NOT_FOUND' })
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }
        const from = await point(p.from, 'from')
        const to = await point(p.to, 'to')
        const out = await cdp.drag(tab.id, from, to, p.steps)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'emulate': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.emulate(tab.id, p)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'metrics': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.metrics(tab.id)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'cdp': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.raw(tab.id, p.method, p.params)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'detach': {
        const { tab, via: v } = await loc(); via = v
        const out = await cdp.detach(tab.id)
        data = { ok: true, ...out, tab: tabBrief(tab) }
        break
      }

      case 'detectLogin': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageDetectLogin', {}, { timeoutMs: 15000 })
        data = { ...result, tab: tabBrief(tab) }
        break
      }

      case 'fillLogin': {
        const { tab, via: v } = await loc(); via = v
        const result = await exec(tab.id, 'inPageFillLogin', {
          username: p.username, password: p.password,
          userSelector: p.userSelector, passSelector: p.passSelector, submitSelector: p.submitSelector,
          submit: p.submit, dryRun: p.dryRun,
        }, { timeoutMs: 20000 })
        if (!result.ok || result.dryRun) { data = { ...result, tab: tabBrief(tab) }; break }
        if (p.submit !== false) {
          await sleep(500)
          await waitNavigation(tab.id, Number(p.timeoutMs) || 20000, p.expectUrl)
          if (p.successSelector) await exec(tab.id, 'inPageWait', { selector: p.successSelector, timeoutMs: Number(p.successTimeoutMs) || 15000 }, { timeoutMs: 20000 })
        }
        data = { ...result, tab: tabBrief(await chrome.tabs.get(tab.id).catch(() => tab)) }
        break
      }

      case 'cookies': {
        const { tab, via: v } = await loc(); via = v
        if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') {
          throw new Error('扩展没有 cookies 权限：manifest 新增了 cookies，需要在 chrome://extensions 里重载扩展。')
        }
        const url = p.url || tab.url || ''
        const list = await chrome.cookies.getAll({ url })
        data = {
          ok: true,
          url,
          count: list.length,
          cookies: list.map((c) => ({
            name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
            // 值默认不回流：cookie 值是凭据，只有显式 showValues 才给
            ...(p.showValues === true ? { value: c.value } : {}),
          })),
          tab: tabBrief(tab),
        }
        break
      }

      case 'diag': {
        // 一次调用回答：这个标签现在能不能读、能不能点、eval 在两个世界通不通
        const { tab, via: v } = await loc(); via = v
        const out = { tabId: tab.id, url: tab.url, status: tab.status, title: tab.title, active: tab.active, tabVia: v, tab: tabBrief(tab) }
        const iso = await exec(tab.id, 'inPageDiag', {}, { timeoutMs: 8000 })
        out.cs = iso && iso.ok !== false
          ? { injected: true, pageVersion: iso.pageVersion, eval: iso.eval, frames: iso.frames, sameOriginFrames: iso.sameOriginFrames, elementCount: iso.elementCount }
          : { injected: false, errorCode: iso && iso.errorCode, error: iso && iso.error }
        // iframe 概况：门户壳页的正文都在 iframe 里，diag 必须先把这件事说清楚
        const navFrames = await frameList(tab.id)
        out.frames = (navFrames || []).map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })).sort((a, b) => a.frameId - b.frameId)
        out.iframeHint = out.frames.length > 1
          ? '页面有 ' + out.frames.length + ' 个帧（frameId 见 frames）；正文不在顶层时用 frame 参数，或直接 read（会自动下沉到可见的同源 iframe）。'
          : ''
        // 每帧能不能 eval：门户类页面真正要操作的是 iframe，主帧能 eval 不代表子帧也能
        // （CSP / sandbox / 注入限制）。只在多帧页面做，避免常态开销。
        if (out.frames.length > 1) {
          const probeEval = () => { try { return { ok: new Function('return 1+1')() === 2 } } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 120) } } }
          const rows = await Promise.all(out.frames.slice(0, 12).map(async (f) => {
            const r = await chrome.scripting.executeScript({
              target: { tabId: tab.id, frameIds: [f.frameId] }, world: 'MAIN', func: probeEval,
            }).catch((e) => [{ result: { ok: false, error: String((e && e.message) || e) } }])
            const res = Array.isArray(r) ? (r[0] && r[0].result) : null
            return { frameId: f.frameId, mainEval: Boolean(res && res.ok), ...(res && !res.ok ? { error: String(res.error || '').slice(0, 120) } : {}) }
          }))
          out.frameEval = rows
          const blocked = rows.filter((r) => !r.mainEval)
          out.frameEvalHint = blocked.length
            ? blocked.length + ' 个帧的页面世界禁了 eval（' + blocked.map((b) => 'frame=' + b.frameId).join('、') + '）：在这些帧上 eval 会自动改走 CDP（回执 via:"cdp"）。'
            : '所有帧的页面世界都能 eval。'
        }
        // 版本错位要说出来：扩展升级后旧标签里跑的还是旧 content script。
        // 方向决定动作：页面旧 → F5；扩展旧 → 重载扩展（只刷页面不会更新扩展）。
        const extVersion = chrome.runtime.getManifest().version
        if (iso && iso.ok !== false && iso.pageVersion && iso.pageVersion !== extVersion) {
          const cmp = compareVersions(iso.pageVersion, extVersion)
          out.versionSkew = {
            contentScript: iso.pageVersion,
            extension: extVersion,
            direction: cmp < 0 ? 'page-old' : 'extension-old',
            note: cmp < 0
              ? '这个标签里的页面脚本是旧版（页面 v' + iso.pageVersion + ' < 扩展 v' + extVersion + '）：按 F5 刷新该标签。'
              : '扩展比页面脚本旧（扩展 v' + extVersion + ' < 页面 v' + iso.pageVersion + '）：到 chrome://extensions 点「重新加载」，再按 F5——只刷新页面不会更新扩展。',
          }
        }
        const mainProbe = () => {
          let ok = false
          let err = ''
          try {
            // eslint-disable-next-line no-new-func
            ok = new Function('return 1 + 1')() === 2
          } catch (e) { err = String((e && e.message) || e) }
          return { ok, error: err, href: location.href, title: document.title }
        }
        const main = await viaInject(tab.id, mainProbe, {}, 'MAIN', 8000, null)
        out.evalWorlds = {
          main: main && main.ok !== false ? (main.ok ? 'ok' : 'CSP_BLOCKED') : 'unavailable',
          mainDetail: main && main.ok !== false ? undefined : main,
          isolated: out.cs.injected ? (out.cs.eval && out.cs.eval.isolated) : 'no-content-script',
        }
        out.verdict = out.cs.injected
          ? (out.evalWorlds.main === 'ok' || out.evalWorlds.isolated === 'ok' ? '可以干活（至少一个世界能跑 JS）' : '只能走声明式步骤（页面和扩展都禁 eval）')
          : '页面没注入 content script：按 F5 刷新，或重载扩展'
        // CDP 这一层单独报：真实按键/弹窗/日志/导出都靠它
        out.cdp = {
          available: Boolean(chrome.debugger && chrome.debugger.attach),
          attached: cdp.isAttached(tab.id),
          capabilities: cdp.capabilityList().length,
        }
        data = { ok: true, ...out }
        break
      }

      case 'log': {
        const all = await chrome.storage.local.get('dshChromeLog')
        data = { ok: true, rows: all.dshChromeLog || [] }
        break
      }

      default:
        throw new Error('不认识的 action：' + action)
    }
    if (via && data && typeof data === 'object') data.tabVia = via
    // 「请求的标签」也带回去：插件层拿它和 tabVia 对比，显式 tabId 没被采纳时
    // 能当场告警，而不是只写在标题行里等人发现（2026-11-20 连错三次标签后加）。
    if (p.tabId != null && p.tabId !== '' && data && typeof data === 'object') data.tabIdRequested = p.tabId
    // 同理，把「请求的帧」带回去：eval/fetch 在别的帧执行时能当场告警（1.13.0）。
    if (p.frame != null && p.frame !== '' && data && typeof data === 'object') data.frameRequested = Number(p.frame)
    // 页面函数返回的业务错误（NOT_FOUND / MULTI_MATCH / CHECK_FAILED…）必须提升到
    // 命令层。否则 background 只看到 ok:false + error:undefined，桥那边就只剩一句
    // 「扩展执行失败」——2026-11-17 实测里一半的困惑都是这么来的。
    if (data && typeof data === 'object' && data.ok === false) {
      return {
        ok: false,
        action,
        ms: Date.now() - started,
        error: data.error || '页面脚本返回失败',
        errorCode: data.errorCode || 'PAGE_ERROR',
        data,
      }
    }
    return { ok: data?.ok !== false, action, ms: Date.now() - started, data }
  } catch (error) {
    // 把 CDP/参数错误自带的码带出去：否则 BAD_ARGS 会退化成 COMMAND_FAILED，
    // 模型就分不清「参数写错了」和「协议层炸了」。
    return {
      ok: false,
      action,
      ms: Date.now() - started,
      error: cleanError(error),
      errorCode: (error && error.errorCode) || 'COMMAND_FAILED',
    }
  }
}

export const VERSION = EXT_VERSION
