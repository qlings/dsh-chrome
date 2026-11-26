/**
 * tabevents.js —— 标签页开/关留证（1.12.0）。
 *
 * 为什么加：2026-11-23 排查「点重新推送 → 自动开一个标签页 → 标签页秒消失、没法编辑」时，
 * 页面自己 window.close() 关掉了标签，而 networkLog / logs 是按 tabId 存的，
 * 标签一没，证据全没了。当时只能去 patch window.open 记录目标地址——
 * 那一步差点把页面的 window.open 弄坏（delete 之后原生 open 没了，因为它是 window 的自有属性）。
 *
 * 现在扩展自己在 SW 里记「谁开了谁、什么时候关的、关之前最后发了什么请求」，
 * 查问题不用再往页面里动手。
 *
 * 限制：数据存在 SW 内存里，MV3 的 SW 被回收后会丢（通常几分钟内不会）。
 */

import * as cdp from './cdp.js'
import { selectRows } from './netlog.js'

const MAX_EVENTS = 150
const MAX_CLOSED = 8
const CLOSED_TTL_MS = 5 * 60 * 1000
const MAX_CLOSED_NET = 300
const MAX_CLOSED_CONSOLE = 200

/** tabId -> { url, title, openerTabId, firstSeenAt } */
const known = new Map()
/** tabId -> { tabId, url, title, openerTabId, createdAt, closedAt, network, consoleRows } */
const closed = new Map()
/** 时间升序的事件环 */
const events = []

let inited = false

const now = () => Date.now()

function note(ev) {
  events.push({ ts: now(), ...ev })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

function remember(tab) {
  if (!tab || tab.id == null) return
  const prev = known.get(tab.id) || {}
  known.set(tab.id, {
    url: tab.url || tab.pendingUrl || prev.url || '',
    title: tab.title || prev.title || '',
    openerTabId: tab.openerTabId != null ? tab.openerTabId : (prev.openerTabId != null ? prev.openerTabId : null),
    firstSeenAt: prev.firstSeenAt || now(),
  })
}

function prune() {
  const t = now()
  for (const [id, rec] of closed) {
    if (t - rec.closedAt > CLOSED_TTL_MS) closed.delete(id)
  }
}

/** 关标签之前把它的网络/console 快照下来（这一步必须在缓冲区被清掉之前做）。 */
function snapshot(tabId) {
  const info = known.get(tabId) || {}
  let network = []
  let consoleRows = []
  try { network = (cdp.networkRows(tabId, MAX_CLOSED_NET).rows || []).slice(-MAX_CLOSED_NET) } catch { /* 没缓冲区 */ }
  try { consoleRows = (cdp.consoleRows(tabId, MAX_CLOSED_CONSOLE).rows || []).slice(-MAX_CLOSED_CONSOLE) } catch { /* 同上 */ }
  closed.set(tabId, {
    tabId,
    url: info.url || '',
    title: info.title || '',
    openerTabId: info.openerTabId == null ? null : info.openerTabId,
    createdAt: info.firstSeenAt || null,
    closedAt: now(),
    network,
    consoleRows,
  })
  // 只留最近 MAX_CLOSED 个
  const ids = [...closed.keys()]
  while (ids.length > MAX_CLOSED) closed.delete(ids.shift())
  known.delete(tabId)
}

/**
 * 注册监听。只能注册一次（MV3 SW 重启会重新 import，所以用模块级 inited 兜住）。
 * @param {{chromeApi?: object}} [opts]
 */
export function initTabEvents(opts = {}) {
  if (inited) return
  const api = opts.chromeApi || (typeof chrome !== 'undefined' ? chrome : null)
  if (!api || !api.tabs || !api.tabs.onCreated) return
  inited = true

  api.tabs.onCreated.addListener((tab) => {
    remember(tab)
    note({ kind: 'created', tabId: tab && tab.id, openerTabId: tab && tab.openerTabId != null ? tab.openerTabId : null, url: (tab && (tab.url || tab.pendingUrl)) || '', title: (tab && tab.title) || '' })
  })
  api.tabs.onUpdated.addListener((tabId, info, tab) => {
    const before = (known.get(tabId) || {}).url || ''
    remember(tab || { id: tabId, url: info && info.url })
    const after = (known.get(tabId) || {}).url || ''
    if (info && info.url && info.url !== before) {
      note({ kind: 'url', tabId, url: info.url, title: (tab && tab.title) || '' })
    } else if (info && info.status === 'complete') {
      note({ kind: 'loaded', tabId, url: after, title: (tab && tab.title) || '' })
    }
  })
  api.tabs.onActivated.addListener((info) => {
    if (info && info.tabId != null) note({ kind: 'active', tabId: info.tabId })
  })
  api.tabs.onRemoved.addListener((tabId, info) => {
    const rec = known.get(tabId) || {}
    snapshot(tabId)
    note({
      kind: 'removed', tabId,
      url: rec.url || '', title: rec.title || '',
      isWindowClosing: Boolean(info && info.isWindowClosing),
      livedMs: rec.firstSeenAt ? now() - rec.firstSeenAt : null,
    })
  })

  // 冷启动时先把已经开着的标签记下来，否则它们被关掉时不知道 URL
  try {
    api.tabs.query({}).then((tabs) => { for (const tab of tabs || []) remember(tab) }).catch(() => {})
  } catch { /* 查不到就算了 */ }
}

/**
 * 读事件 / 读已关闭标签的留证。
 *
 * op=list（默认）: 最近事件 + 已关闭标签摘要
 * op=get:  某个已关闭标签的摘要
 * op=net:  某个已关闭标签关之前的请求（支持 filter/ignore/frame/limit/collapse）
 * op=console: 某个已关闭标签关之前的 console
 * op=clear: 清空
 */
export function readTabEvents(opts = {}) {
  prune()
  const op = String(opts.op || 'list').toLowerCase()
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 40))

  if (op === 'clear') {
    const had = { events: events.length, closed: closed.size }
    events.length = 0
    closed.clear()
    return { cleared: had }
  }

  if (op === 'get' || op === 'net' || op === 'console') {
    const id = Number(opts.tabId)
    const rec = closed.get(id)
    if (!rec) {
      return {
        found: false, tabId: id,
        note: '没有这个已关闭标签的留证。只留最近 ' + MAX_CLOSED + ' 个、' + Math.round(CLOSED_TTL_MS / 60000) + ' 分钟内的；SW 重启也会丢。',
        kept: [...closed.keys()],
      }
    }
    const base = {
      found: true, tabId: id, url: rec.url, title: rec.title, openerTabId: rec.openerTabId,
      createdAt: rec.createdAt, closedAt: rec.closedAt,
      livedMs: rec.createdAt ? rec.closedAt - rec.createdAt : null,
      networkCount: rec.network.length, consoleCount: rec.consoleRows.length,
    }
    if (op === 'get') return base
    if (op === 'console') {
      const rows = rec.consoleRows
        .filter((r) => !opts.filter || String(r.text || '').toLowerCase().includes(String(opts.filter).toLowerCase()))
        .slice(-limit)
      return { ...base, rows }
    }
    // net：和 networkLog 用同一套过滤/折叠，行为一致
    const sel = selectRows(rec.network, {
      filter: opts.filter, ignore: opts.ignore, frame: opts.frame,
      limit, collapse: opts.collapse !== false,
    })
    return { ...base, ...sel }
  }

  const ev = events.slice(-limit)
  const tabs = [...closed.values()].map((r) => ({
    tabId: r.tabId, url: r.url, title: r.title, openerTabId: r.openerTabId,
    createdAt: r.createdAt, closedAt: r.closedAt,
    livedMs: r.createdAt ? r.closedAt - r.createdAt : null,
    networkCount: r.network.length, consoleCount: r.consoleRows.length,
  }))
  return { events: ev, closed: tabs, totalEvents: events.length, totalClosed: closed.size }
}
