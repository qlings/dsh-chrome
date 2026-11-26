/**
 * background.js —— service worker：长轮询桥、执行命令、记本地流水。
 *
 * 为什么不用 WebSocket：见 lib/bridge.js 顶部注释。这里只负责「桥上有活就干，
 * 干完回话，然后继续蹲着」。SW 被回收后由 alarms / 标签页事件重新拉起来。
 *
 * 端口探测：插件热重载时旧桥可能还占着 18765（僵尸实例），新桥会往后挪到
 * 18766。扩展按 /status 里的 version 认桥，认不到就试下一个，不靠人工配端口。
 */

import { runCommand } from './executor.js'
import { initTabEvents } from './tabevents.js'

const DEFAULT_PORT = 18765
const PROBE_PORTS = [18765, 18766, 18767, 18768, 18769]
// 25 秒的长轮询会把 MV3 的 service worker 挂死：Chrome 认为空闲就回收，
// fetch 悬着不返回、循环也不会再发新请求（2026-11-17 实测：桥侧最后轮询时间
// 停在原地）。改成 10 秒一轮，让 SW 每 10 秒都有一次扩展活动。
const POLL_WAIT_MS = 10000
const FETCH_TIMEOUT_MS = 15000
const MAX_LOCAL_LOG = 120

let polling = false
let lastStatus = { connected: false, at: 0, error: '', port: 0, version: '' }

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

/** 找一个正在运行、且版本对得上的桥。探测失败的原因要留下来，不然只能瞎猜。 */
async function probeBridge() {
  const fails = []
  let ports = PROBE_PORTS.slice()
  let pinned = 0
  try {
    const { dshChromePort } = await chrome.storage.local.get('dshChromePort')
    if (dshChromePort) {
      pinned = Number(dshChromePort)
      // 历史配置只是"优先试试"，不能钉死：以前"重连"按钮会把当时的端口存下来，
      // 桥后来挪回 18765 或换了端口，扩展就一直 Failed to fetch 连到天荒地老。
      ports = [pinned, ...PROBE_PORTS.filter((p) => p !== pinned)]
    }
  } catch (e) {
    fails.push('读 storage 失败: ' + String((e && e.message) || e))
  }
  for (const port of ports) {
    try {
      const info = await fetchJson(`http://127.0.0.1:${port}/status`, {}, 1500)
      if (info && info.running && info.bridge === 'dsh-chrome' && info.version) {
        // 找到了和钉死的端口不一样：顺手把 storage 纠正过来，省得下次又白试
        if (pinned && pinned !== port) {
          chrome.storage.local.set({ dshChromePort: port }).catch(() => {})
        }
        return { base: `http://127.0.0.1:${port}`, port, version: info.version }
      }
      fails.push(`${port}: 有应答但不像桥 → ${JSON.stringify(info).slice(0, 100)}`)
    } catch (e) {
      fails.push(`${port}: ${String((e && e.name) || 'Error')} ${String((e && e.message) || e).slice(0, 120)}`)
    }
  }
  // 把失败明细落盘：下次直接从 storage 里看为什么连不上
  try {
    await chrome.storage.local.set({ dshProbeFail: { at: new Date().toISOString(), ports, fails: fails.slice(0, 8) } })
  } catch { /* 写不了就算了 */ }
  return null
}

async function pushLocalLog(entry) {
  try {
    const { dshChromeLog = [] } = await chrome.storage.local.get('dshChromeLog')
    const next = [{ ...entry, ts: new Date().toISOString() }, ...dshChromeLog].slice(0, MAX_LOCAL_LOG)
    await chrome.storage.local.set({ dshChromeLog: next })
  } catch { /* 存不下就算了，不连坐 */ }
}

const seen = new Map()   // cmdId -> { ts, payload }：桥没收到回音会重发，这里去重
const SEEN_TTL = 60000

async function postResult(base, cmdId, payload) {
  await fetchJson(`${base}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmdId, ...payload }),
  }, 10000)
}

async function handleCommand(base, cmd) {
  // 探针：不 await，不拖慢执行；桥那边用 /status 的 traces 看断点
  fetchJson(`${base}/trace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'recv', id: cmd.id, action: cmd.action }),
  }, 3000).catch(() => {})
  const cached = seen.get(cmd.id)
  if (cached && Date.now() - cached.ts < SEEN_TTL) {
    // 重发：直接回上次的结果。写操作绝不执行第二遍。
    await postResult(base, cmd.id, cached.payload).catch(() => {})
    return
  }
  const started = Date.now()
  let result
  // 长命令（CDP 截图/导出/等页面）执行期间也要让 SW 有 chrome.* 活动：
  // 否则空闲计时器 30 秒一到，SW 被回收，命令和轮询一起没了。
  const heartbeat = setInterval(() => { keepAlive() }, 15000)
  // 看门狗：任何命令都不许无限等待。卡住就报「结果未知」，回去继续轮询。
  //
  // 1.11.1 实测记录（别再往回改）：轮询循环是 `await handleCommand(...)` 串行的，页面里
  // 要是有同步死循环，命令永远回不来 → 循环停转 → 之后**连 abort 都进不来**，只能等看门狗。
  // 试过在看门狗里用 CDP `Runtime.terminateExecution` 救，实测不行：渲染进程彻底卡死时
  // 这条 CDP 命令本身也返回不了（debugger 通道等渲染线程回话），所以这里不再调它。
  // 真正的逃生口是 `chrome.tabs.reload`（浏览器层导航，不依赖渲染进程）——因此看门狗
  // 一到点就立刻放弃等待、让轮询复活，让模型/用户能接着发 reload。
  let watchdogTimer = null
  // 预算：默认 90 秒；命令自己带了 timeoutMs 的（eval 之类），按「它 + 20 秒」算，
  // 下限 25 秒、上限仍是 90 秒——页面卡死时能早点收场，不用干等一分半。
  const askedMs = Number(cmd && cmd.params && cmd.params.timeoutMs)
  const watchdogMs = Number.isFinite(askedMs) && askedMs > 0
    ? Math.min(90000, Math.max(25000, askedMs + 20000))
    : 90000
  const watchdog = new Promise((resolve) => {
    watchdogTimer = setTimeout(() => {
      resolve({
        ok: false,
        errorCode: 'COMMAND_WATCHDOG',
        error: '这条命令超过 ' + Math.round(watchdogMs / 1000) + ' 秒没有结束（页面或 CDP 协议卡住）。扩展已放弃等待并回去轮询。'
          + '页面若真死循环（同步 while / 裸递归），abort 的硬停也进不去——用 action=reload 刷新该标签（浏览器层导航，会杀掉渲染进程，现场丢失），'
          + '或者告诉用户手动 F5。写操作**可能已经生效**，恢复后先 read / screenshot 看当前状态，别直接重放。',
        ms: Date.now() - started,
      })
    }, watchdogMs)
  })
  try {
    result = await Promise.race([runCommand(cmd), watchdog])
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error), ms: Date.now() - started }
  } finally {
    clearInterval(heartbeat)
    clearTimeout(watchdogTimer)
  }
  const tab = result?.data?.tab
  await pushLocalLog({
    action: cmd.action,
    ok: result.ok !== false,
    ms: result.ms,
    error: result.error || '',
    tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null,
  })
  const payload = { ok: result.ok !== false, data: result.data, error: result.error, errorCode: result.errorCode, ms: result.ms }
  seen.set(cmd.id, { ts: Date.now(), payload })
  if (seen.size > 200) {
    for (const [key, value] of seen) if (Date.now() - value.ts > SEEN_TTL) seen.delete(key)
  }
  fetchJson(`${base}/trace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'done', id: cmd.id, action: cmd.action, ok: result.ok !== false, ms: result.ms, error: result.error || '' }),
  }, 3000).catch(() => {})
  try {
    await postResult(base, cmd.id, payload)
  } catch (error) {
    // 桥上没人接（DSH 重启了）：记一笔，下轮重连
    lastStatus = { ...lastStatus, connected: false, at: Date.now(), error: '回传失败: ' + String(error && error.message || error) }
    fetchJson(`${base}/trace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'result-failed', id: cmd.id, error: String(error && error.message || error) }),
    }, 3000).catch(() => {})
  }
}

/**
 * 保活戳：MV3 的空闲计时器只认 chrome.* 调用，挂起的 fetch 不算。
 * 循环里任何一条 "等一会儿" 的路径都必须戳一下，否则 SW 三十秒就被收走，
 * 而它一旦被收走、alarm 又没建成，就再也没人叫得醒它了（2026-11-17 实测：
 * 桥重启那一下正好赶上收走，扩展从此彻底躺平，桥那边 lastPollAt 永远是 0）。
 */
async function keepAlive() {
  try { await chrome.runtime.getPlatformInfo() } catch { /* 拿不到就算了，别连坐 */ }
}

async function loop() {
  let target = null
  while (true) {
    try {
      if (!target) {
        target = await probeBridge()
        if (!target) {
          lastStatus = { connected: false, at: Date.now(), error: '没找到 DSH 桥（18765-18769 都没应答）', port: 0, version: '' }
          await keepAlive()
          await new Promise((r) => setTimeout(r, 2500))
          continue
        }
        await fetchJson(`${target.base}/hello`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ extId: chrome.runtime.id, version: chrome.runtime.getManifest().version }),
        }, 4000).catch(() => {})
      }
      await keepAlive()
      const res = await fetchJson(`${target.base}/poll?ext=${encodeURIComponent(chrome.runtime.id)}&wait=${POLL_WAIT_MS}`, {}, FETCH_TIMEOUT_MS + 5000)
      lastStatus = { connected: true, at: Date.now(), error: '', port: target.port, version: target.version }
      if (res && res.cmd) await handleCommand(target.base, res.cmd)
      else await new Promise((r) => setTimeout(r, 200))
    } catch (error) {
      lastStatus = { connected: false, at: Date.now(), error: String((error && error.message) || error), port: target?.port || 0, version: target?.version || '' }
      target = null
      await keepAlive()
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

export function ensurePoll() {
  if (polling) return
  polling = true
  loop().finally(() => { polling = false })
}

async function installAlarms() {
  try {
    await chrome.alarms.create('dsh-chrome-keepalive', { periodInMinutes: 0.5 })
  } catch {
    try { await chrome.alarms.create('dsh-chrome-keepalive', { periodInMinutes: 1 }) } catch { /* 老版本不支持就算了 */ }
  }
}

/**
 * 启动自检：把"SW 什么时候起来、什么版本、连的哪个端口"写进 storage。
 * 出问题时打开 Local Extension Settings/*.log 就能一眼看出：
 * 有 dshBootAt 说明模块加载成功；连它都没有，就是 import 阶段就挂了。
 */
async function bootTrace(extra = {}) {
  try {
    await chrome.storage.local.set({
      dshBoot: {
        at: new Date().toISOString(),
        version: chrome.runtime.getManifest().version,
        pageVersion: (globalThis.__dshPage && globalThis.__dshPage.VERSION) || 'missing',
        port: lastStatus.port || DEFAULT_PORT,
        ...extra,
      },
    })
  } catch { /* 写不了就算了，不连坐 */ }
}

chrome.runtime.onInstalled.addListener(() => { installAlarms(); ensurePoll() })
chrome.runtime.onStartup.addListener(() => { installAlarms(); ensurePoll() })
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'dsh-chrome-keepalive') ensurePoll() })
chrome.tabs.onActivated.addListener(() => ensurePoll())
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete') ensurePoll() })
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    sendResponse({ ...lastStatus, runtimeId: chrome.runtime.id, defaultPort: DEFAULT_PORT, pageVersion: (globalThis.__dshPage && globalThis.__dshPage.VERSION) || '' })
    return true
  }
  if (msg && msg.type === 'poke') { ensurePoll(); sendResponse({ ok: true }) }
  return false
})

// 冷启动：模块一加载就建 alarm + 蹲上。
// alarm 不能只放在 onInstalled/onStartup 里——reload 之后那两个事件不保证来。
installAlarms()
// 标签页开/关留证（1.12.0）：必须尽早注册，否则「点一下就开、开完就关」的标签
// 一个事件都收不到。
initTabEvents()
bootTrace()
ensurePoll()
