/**
 * actions.js —— chrome 工具的每个动作。
 *
 * 约定：所有动作都返回
 *   { ok, action, ms, tab, detail, message }
 * message 是给人看的中文报告（工具输出），detail 是给日志落盘的结构化数据。
 * 失败也返回（ok:false + message 里写清楚为什么），由工具层决定抛不抛。
 *
 * 2026-11-17 实测后的两条新规矩：
 *  1. 失败必须带错误码 + 下一步建议，不能只甩一句「扩展执行失败」。
 *  2. 工具输出要能"关小声"：flow quiet、read inputs:'summary'、screenshot 局部，
 *     不然 91 个元素的任务光复读就烧掉一半 token。
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { chromeHome, recent } from './log.js'
import { readSites, writeSites, findSite, maskSite } from './sites.js'
import { performExtra, isExtraAction, AUTH_HINT } from './extra.js'
import { viaTag } from './tabnote.js'
import { resolveSavePath, ensureDir } from './save.js'

/**
 * 截断时不切半个代理对（emoji 之类）：半个字符会让下游 JSON 解析整条失败，
 * 而且坏字符会跟着会话历史每轮重放。切点落在高位代理上就退一格。
 */
function safeSlice(text, start, count) {
  const s = String(text == null ? '' : text)
  let begin = Math.max(0, Number(start) || 0)
  let end = Math.min(s.length, begin + Math.max(0, Number(count) || 0))
  if (begin > 0 && begin < s.length) {
    const prev = s.charCodeAt(begin - 1)
    if (prev >= 0xD800 && prev <= 0xDBFF) begin += 1
  }
  if (end > begin && end < s.length) {
    const last = s.charCodeAt(end - 1)
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1
  }
  return s.slice(begin, end)
}

const clip = (text, n) => {
  const s = String(text == null ? '' : text)
  const limit = Math.max(0, Number(n) || 0)
  return s.length > limit ? safeSlice(s, 0, Math.max(1, limit - 1)) + `…（共 ${s.length} 字）` : s
}

const tabLine = (tab) => tab
  ? `标签 #${tab.id}《${clip(tab.title || '(无标题)', 60)}》${tab.url || ''}`
  : '标签（未知）'

/**
 * 统一的标签定位参数。
 * sticky:true 时扩展会沿用「上一次操作过的标签」——多标签排查时不用每次带 tabId，
 * 也不会因为焦点切到别的标签就打到错误页面。
 */
function tabLoc(params = {}) {
  const loc = { tabId: params.tabId, urlContains: params.urlContains, index: params.index }
  if (params.sticky === true) loc.sticky = true
  return loc
}

/** 动作回执里附一句「页面变化」：只列变了什么名字，省掉模型再调一次 outline 的那整轮上下文。 */
function deltaLine(delta) {
  if (!delta || (!delta.addedCount && !delta.removedCount)) return ''
  const fmt = (rows) => (rows || []).slice(0, 4).map((r) => `${r.role}「${clip(r.name, 30)}」`).join('、')
  const bits = []
  if (delta.addedCount) bits.push(`+${delta.addedCount} ${fmt(delta.added)}`)
  if (delta.removedCount) bits.push(`-${delta.removedCount} ${fmt(delta.removed)}`)
  return `【页面变化】${bits.join('；')}`
}

function pageHeader(data) {
  return `${tabLine(data.tab)}${viaTag(data)}${data.title && !data.tab?.title ? ` · 页面标题：${clip(data.title, 60)}` : ''}`
}

/**
 * 版本比较：'1.12.0' vs '1.13.0' → -1 / 0 / 1。
 * 以前只做字符串不等判断，于是「页面脚本比扩展新」也会被说成「页面脚本是旧版，
 * 按 F5 刷新就行」——F5 根本不会把页面脚本刷成更高版本（2026-11-24 实测踩到）。
 */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 错误码 → 下一步怎么做。只写能立刻执行的话。 */
const ERROR_HINTS = {
  NOT_FOUND: '没找到。页面动作：先 action=outline / rows 看这页有什么，或改用 text / rowText / selector；「壳页 + iframe」先 action=frames 拿 frame 编号。网络动作（networkDetail / replay）：先 networkLog 看行尾 #id——CDP 行用 #xxx，探针行用 #pN 或加 source:"probe"；CDP 挂上之前的请求只有探针有。',
  REF_STALE: 'ref 失效了（页面变过，或又跑了一次 outline）。重新 action=outline 拿新 ref，或改用 selector / text / rowText。',
  MULTI_MATCH: '命中多个，不敢替你选。把 rowText/selector 写全、加 rowMatch:"equals"，或用 index 指定第几个。',
  EVAL_CSP_BLOCKED: '页面 CSP 禁了 unsafe-eval：1.11.0 起会自动改走 DevTools 通道（回执 via:"cdp"）重试。若仍失败，说明注入也被禁，改用 flow 的声明式步骤。',
  EVAL_UNAVAILABLE: '页面和扩展世界都跑不了 JS（CSP 很严）。1.11.0 起会再试 CDP 通道；还不行就用 click/type/check/extract 代替 eval。',
  FRAME_CONTEXT_NOT_FOUND: '这个 frame 没有默认执行上下文（可能正在导航或已被移除）。先 action=frames 确认帧还在，等页面加载完再试，或去掉 frame 在主帧跑。',
  PAGE_BUSY: '页面还在加载或主线程被占着，注入没抢到——**这不是 CSP 限制**。等 1~2 秒重试同一条命令即可；连着几次都这样再考虑 flow。',
  PAGE_SCRIPT_TIMEOUT: '页面脚本**可能还在跑**。先 read 看一眼当前状态，别直接重试写操作；长任务拆小或设大 timeoutMs。要是页面已经卡死（连 read 都不回），等看门狗收场后 action=reload 刷新该标签（浏览器层导航，会丢现场）；abort 的 hard:true 只对「页面还活着」有效。',
  TYPE_NOT_APPLIED: '值没写进去（多半是组件重建了输入框）。先 wait selector 等它稳定，或用 selector/ref 精确定位再填。',
  CHECK_FAILED: '点了但选中态没变。把 target 指到真正的勾选控件（input[type=checkbox] 或 .el-checkbox__inner）。',
  CLICK_NOT_APPLIED: '点了但 expect 没满足，重试也没成。有状态元素（勾选/开关）改用 check。',
  WAIT_TIMEOUT: '没等到。如果目标本来就在页面上（旧内容残留），改用 changed:true 或 exact:true。',
  NO_CONTENT_SCRIPT: '页面没注入 content script（扩展刷新前就开着的标签）。在目标页按 F5。',
  INJECT_TIMEOUT: '注入没返回。两种可能：① 扩展刷新前开着的标签（F5）；② 页面主线程被死循环/超长任务占住——先 status 看扩展还在不在轮询，回收场后用 action=reload 刷新该标签。chrome:// 这类内置页永远不行。',
  INJECT_FAILED: '这个页面不让注入扩展脚本。',
  NO_HANDLER: '扩展版本旧了：chrome://extensions 里重载扩展，再刷新页面。',
  BAD_ARGS: '参数不够，看 message 里缺什么。',
  PAGE_ERROR: '页面脚本自己报错了，看 message。',
  COMMAND_FAILED: '命令层失败，看 message。',
  COMMAND_TIMEOUT: '扩展没在时限内回话。写操作**可能已经生效**：先 read / isChecked / diag 看状态，别连着重放；只读动作可以直接重试。',
  EXT_OFFLINE: '扩展没连上桥。chrome://extensions 里确认扩展启用，点弹窗「重连」；写操作还没发出去，重试不会做两遍。',
  DEBUGGER_UNAVAILABLE: '扩展没有 debugger 权限（1.2.0 的 manifest 新增了）：chrome://extensions 里重载扩展。重载前先用非 CDP 的动作（click/type/read）。',
  DEBUGGER_ATTACH_FAILED: '挂不上 CDP 会话。最常见：这个标签开着 DevTools（关掉 F12）、或被别的调试工具占着。换个标签或关掉再试。',
  CDP_ENABLE_FAILED: 'CDP 域没打开（页面可能刚跳转）。刷新一次再试。',
  CDP_FAILED: 'CDP 命令失败，看 message 里的协议原文。',
  CDP_TIMEOUT: 'CDP 命令超时（页面或协议卡住）。命令可能仍在浏览器里执行：先 read / screenshot 看状态，别直接重放写操作。',
  COMMAND_WATCHDOG: '扩展放弃等了（超过 90 秒）。写操作可能已经生效：先 read / screenshot 确认，再决定要不要重做。',
  WAIT_TIMEOUT_MS: '等太久了。',
  TAB_NOT_FOUND: '显式指定的 tabId 不存在（多半已关掉）。用 action=tabs 看现有标签；想用当前活动标签就别传 tabId，或改用 urlContains。',
  FRAME_NOT_FOUND: '这个 frame 编号不存在。先 action=frames 看当前帧表（frameId 就是 frame 参数）。注意 iframe 里的页面一跳转，frameId 就会变，旧编号不能再用。',
  FRAME_STALE: '这个 frame 已经不存在了（页面导航过、或子帧已被移除）——**这不是 CSP，也不是页面不让注入**。重新 action=frames 拿新帧表；iframe 里的审批页点完提交常会 location.href 跳转，跳转后原来的 frameId 全部作废。',
}

/** 这些动作会改页面/浏览器状态：超时或掉线后结果未知，不能让模型盲目重试。 */
const WRITE_ACTIONS = new Set([
  'click', 'type', 'submit', 'check', 'select', 'navigate', 'flow', 'login', 'open', 'close', 'eval', 'evalMain',
  'press', 'upload', 'drag', 'emulate', 'netBlock',
])

function hintOf(code) {
  return (code && ERROR_HINTS[code]) || ''
}

/**
 * 看到 401 就别让模型硬猜（1.13.0）：网关的 401 长得像「接口不存在」，
 * 实测会连着重试 5 次同一条请求。判据只认 401 本身的特征，别把业务文案里的 "401" 也算进来。
 */
function looksUnauthorized(status, text) {
  if (Number(status) === 401) return true
  const s = String(text || '')
  if (!s || s.length > 20000) return false
  return /401\s+Authorization\s+Required/i.test(s)
    || (/openresty/i.test(s) && /\b401\b/.test(s))
    || /"status"\s*:\s*401\b/.test(s)
}

/* ------------------------------------------------------------------ */

export async function performAction(bridge, action, params = {}, opts = {}) {
  const started = Date.now()
  const root = opts.root
  try {
    switch (action) {
      case 'status': return await status(bridge, started)
      case 'diag': return await diag(bridge, params, started)
      case 'tabs': return await tabs(bridge, started)
      case 'frames': return await framesAction(bridge, params, started)
      case 'rows': return await rowsAction(bridge, params, started)
      case 'downloads': return await downloadsAction(bridge, params, started)
      case 'history': return await historyAction(bridge, params, started)
      case 'read': return await read(bridge, params, started)
      case 'outline': return await outline(bridge, params, started)
      case 'query': return await query(bridge, params, started)
      case 'open': return await open(bridge, params, started)
      case 'focus': return await simple(bridge, 'focus', params, started, '已切到')
      case 'close': return await simple(bridge, 'close', params, started, '已关闭')
      case 'navigate': return await navigate(bridge, params, started)
      case 'reload': return await simple(bridge, 'reload', params, started, '已刷新')
      case 'back': return await simple(bridge, 'back', params, started, '已后退')
      case 'forward': return await simple(bridge, 'forward', params, started, '已前进')
      case 'click': return await click(bridge, params, started)
      case 'type': return await type(bridge, params, started)
      case 'submit': return await type(bridge, { ...params, submit: true }, started)
      case 'select': return await simple(bridge, 'select', params, started, '已选择')
      case 'check': return await check(bridge, params, started)
      case 'isChecked': return await isChecked(bridge, params, started)
      case 'value': return await valueOf(bridge, params, started, root)
      case 'eval': return await evalCode(bridge, params, started, root)
      case 'evalMain': return await evalCode(bridge, { ...params, world: 'MAIN' }, started, root)
      case 'abort': return await abort(bridge, params, started)
      case 'wait': return await waitFor(bridge, params, started)
      case 'scroll': return await simple(bridge, 'scroll', params, started, '已滚动')
      case 'extract': return await extract(bridge, params, started)
      case 'snapshot': return await snapshot(bridge, params, started, root)
      case 'diff': return await diffSnapshots(bridge, params, started, root)
      case 'screenshot': return await screenshot(bridge, params, started, root)
      case 'login': return await login(bridge, params, started, root, opts)
      case 'flow': return await flow(bridge, params, started, root, opts)
      case 'sites': return await sitesAction(params, started, root)
      case 'cookies': return await cookiesAction(bridge, params, started)
      case 'log': return await logAction(params, started, root)
      default:
        if (isExtraAction(action)) {
          const result = await performExtra(bridge, action, params, started, { root })
          if (result) return result
          return { ok: false, action, ms: Date.now() - started, message: `【chrome:${action}】失败：扩展回了失败但没有详情（装的是旧版扩展？chrome://extensions 里重载一次）` }
        }
        return { ok: false, action, ms: Date.now() - started, message: `不认识的 action：${action}` }
    }
  } catch (error) {
    // bridge.call 的 reject 带着扩展给的 errorCode（桥和扩展都改了才有效），
    // 拿不到就退回 THROWN，但至少把真实 message 和 detail 带出来。
    const code = (error && error.errorCode) || 'THROWN'
    const errMsg = String((error && error.message) || error)
    let hint = hintOf(code)
    // 写操作超时/掉线：结果未知。明确写出来，模型才不会当成「没发生」直接重放。
    let effectState = ''
    if (WRITE_ACTIONS.has(action) && /TIMEOUT/.test(code)) {
      effectState = 'unknown'
      hint = `【effectState=unknown】这条命令可能已经落到页面上：先 action=read / diag / isChecked 看现在的状态，确认没生效再重试；不要连着重放写操作。${hint ? '\n→ ' + hint : ''}`
    }
    // eval 超时后抢救回来的分段（window.__dshChunks）——已经落盘，别让用户以为全丢了。
    const salvage = error && error.salvage
    const salvageLine = salvage ? `\n已抢救超时前完成的分段：${salvage.count} 段 → ${salvage.file}` : ''
    // MULTI_MATCH 这类会带候选：编号列出来，直接能挑 index（以前只塞在 detail 里，
    // 模型看到的是「命中多个，不敢挑」，还得回去再 outline 一轮）。
    const cands = Array.isArray(error?.detail?.candidates) ? error.detail.candidates : []
    const candLines = cands.length
      ? '\n候选：\n' + cands.map((x, i) => `  ${i}. ${String(x)}`).join('\n') + '\n→ 用 index 指定第几个（从 0 开始），或 exact:true 精确匹配。'
      : ''
    return {
      ok: false,
      action,
      ms: Date.now() - started,
      message: `【chrome:${action}】失败${code !== 'THROWN' ? ` [${code}]` : ''}：${errMsg}${candLines}${hint ? `\n→ ${hint}` : ''}${salvageLine}`,
      detail: { error: errMsg, errorCode: code, effectState: effectState || undefined, hint, salvage, candidates: cands.length ? cands : undefined, extra: error?.detail },
    }
  }
}

/* ----------------------------- 基础动作 ----------------------------- */

async function status(bridge, started) {
  const info = bridge.info()
  let pong = null
  if (info.connected) {
    pong = await bridge.call('ping', {}, { timeoutMs: 4000 }).catch((e) => ({ ok: false, error: String(e.message || e) }))
  }
  const lines = [
    '【chrome:status】',
    `桥：${info.running ? '已启动' : '未启动'} · ${info.url}`,
    `扩展：${info.connected ? '已连接' : '未连接'}${info.ext?.version ? ` · v${info.ext.version}` : ''}`,
    `队列 ${info.queued} · 在途 ${info.inflight} · 挂起轮询 ${info.waitingPolls}`,
    info.lastPollAt ? `最后轮询：${new Date(info.lastPollAt).toLocaleTimeString()}` : '还没收到扩展轮询',
  ]
  if (info.droppedCount) lines.push(`因掉线被直接判死的命令：${info.droppedCount} 条（不再每条各等超时）`)
  if (info.tokenRequired) lines.push('这个桥开了 /cmd token 校验（~/.dsh/chrome/bridge.token）')
  if (info.hint) lines.push('', info.hint)
  if (pong && pong.ok === false) lines.push(`扩展 ping 失败：${pong.error}`)
  if (pong && pong.pageVersion) lines.push(`页面脚本版本：${pong.pageVersion}`)
  // 版本错位：扩展升级后，老标签里跑的还是老 content script——不刷新就会「行为一半新一半旧」。
  // 方向要分开说：页面旧 → F5；扩展旧 → 重载扩展（F5 只会把页面脚本刷成扩展里的那份，不会更新扩展本身）。
  if (pong && pong.pageVersion && pong.version && pong.pageVersion !== pong.version) {
    if (cmpVersion(pong.pageVersion, pong.version) < 0) {
      lines.push(`⚠ 页面脚本是旧版（页面 v${pong.pageVersion} < 扩展 v${pong.version}）：在目标页按 F5 刷新，让它加载扩展里的新脚本。`)
    } else {
      lines.push(`⚠ 扩展比页面脚本旧（扩展 v${pong.version} < 页面 v${pong.pageVersion}）：到 chrome://extensions 点扩展的「重新加载」，再按 F5 刷新标签——只按 F5 不会更新扩展。`)
    }
  }
  if (info.connected) lines.push('', '想确认「这个标签现在能不能 eval / 能不能点」：用 action=diag。')
  if (!info.connected) {
    lines.push('')
    lines.push('扩展没连上时：打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 dsh-chrome/extension，然后点扩展图标看是否「已连上 DSH」。')
  }
  return { ok: info.connected, action: 'status', ms: Date.now() - started, message: lines.join('\n'), detail: { bridge: info, pong } }
}

/** 能力自检：一条命令回答「这个标签现在能干嘛」。 */
async function diag(bridge, params, started) {
  const r = await bridge.call('diag', {
    ...tabLoc(params),
  }, { timeoutMs: 30000 })
  const d = r || {}
  if (!r.ok) return fail('diag', r, started)
  const main = d.evalWorlds?.main || '?'
  const iso = d.evalWorlds?.isolated || '?'
  const lines = [
    `【chrome:diag】${pageHeader(d)}`,
    `content script：${d.cs?.injected ? `已注入（v${d.cs.pageVersion || '?'}）` : '没注入'}`,
    `eval 能力：页面世界 ${main} · 扩展世界 ${iso}`,
  ]
  if (d.versionSkew) lines.push(`⚠ ${d.versionSkew.note}`)
  if (Array.isArray(d.frames) && d.frames.length) {
    const shown = d.frames.slice(0, 6).map((f) => `frame=${f.frameId}${f.frameId === 0 ? '(顶层)' : ''}`)
    lines.push(`帧：${d.frames.length} 个（${shown.join('、')}${d.frames.length > shown.length ? '…' : ''}）`)
  }
  if (d.iframeHint) lines.push(d.iframeHint)
  if (d.cdp) {
    lines.push(d.cdp.available
      ? `CDP：${d.cdp.attached ? '已挂上（真实按键/弹窗/日志/导出可用）' : '可用但还没挂（第一次用 CDP 动作时自动挂）'}`
      : 'CDP：不可用（扩展没有 debugger 权限，重载扩展）')
  }
  lines.push(`结论：${d.verdict || ''}`)
  if (!d.cs?.injected && d.cs?.error) lines.push(`注入错误：${clip(d.cs.error, 200)}`)
  return { ok: true, action: 'diag', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: d }
}

async function tabs(bridge, started) {
  const r = await bridge.call('tabs', {}, { timeoutMs: 15000 })
  const data = r || {}
  const rows = data.tabs || []
  const lines = [`【chrome:tabs】共 ${rows.length} 个标签，${(data.windows || []).length} 个窗口`]
  for (const t of rows) {
    // URL 不截断：它是「这个标签到底是哪个页面」的唯一依据，砍了就得再 eval 一次 location.href
    // （2026-11-23 排查时踩过：回执里只剩 ...&stat…，还得回头补一条命令）。
    lines.push(`${t.active ? '▶' : ' '} #${t.id} [窗口${t.windowId}/位${t.index}] ${clip(t.title || '(无标题)', 50)} — ${t.url || ''}`)
  }
  return {
    ok: true, action: 'tabs', ms: Date.now() - started,
    message: lines.join('\n'),
    detail: { count: rows.length, tabs: rows, windows: data.windows, activeTabId: data.activeTabId },
  }
}

async function framesAction(bridge, params, started) {
  const r = await bridge.call('frames', { ...tabLoc(params) }, { timeoutMs: 20000 })
  const d = r || {}
  if (!r.ok) return fail('frames', r, started)
  const list = d.frames || []
  const lines = [`【chrome:frames】${pageHeader(d)} · 共 ${list.length} 个帧`]
  for (const f of list) {
    const bits = [`frame=${f.frameId}`]
    if (f.frameId === 0) bits.push('（顶层）')
    else if (f.parentFrameId != null) bits.push(`（父帧 ${f.parentFrameId}）`)
    const txt = f.textLength != null ? ` · 正文 ${f.textLength} 字` : ''
    const size = f.size ? ` · ${f.size}` : ''
    const vis = f.visible === false ? ' · 不可见' : ''
    lines.push(`· ${bits.join('')} ${clip(f.title || f.url || '?', 60)}${txt}${size}${vis}`)
    if (f.url && f.title) lines.push(`    ${clip(f.url, 120)}`)
    if (f.probeError) lines.push(`    ⚠ ${clip(f.probeError, 120)}`)
  }
  if (!list.length) lines.push('—— 没有帧（页面可能还没加载完）——')
  if (d.hint) lines.push('', d.hint)
  return { ok: true, action: 'frames', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { count: list.length, frames: list } }
}

async function rowsAction(bridge, params, started) {
  const r = await bridge.call('rows', { ...tabLoc(params), in: params.in, limit: params.limit, frame: params.frame }, { timeoutMs: 25000 })
  const d = r || {}
  if (!r.ok) return fail('rows', r, started)
  const shown = Math.max(1, Math.min(200, Number(params.show) || 40))
  const rows = d.rows || []
  const lines = [`【chrome:rows】${pageHeader(d)} · ${d.count} 行（in=${d.in}）`]
  for (const row of rows.slice(0, shown)) {
    const mark = row.checked === true ? '[✓]' : row.hasCheckbox ? '[ ]' : ' ·'
    lines.push(`${mark} ${row.ref}｜${clip(row.text, 150)}${row.frame ? `（iframe ${clip(row.frame, 40)}）` : ''}`)
  }
  if (rows.length > shown) lines.push(`（还有 ${rows.length - shown} 行；调大 show/limit，或用 in 缩小范围）`)
  if (!rows.length) lines.push('—— 没有行（换 in，例如 "tbody tr"；或先 read 确认表格在哪个 frame）——')
  lines.push('', 'ref（如 r3）可以直接 click / check；下次 outline/rows 会重排。')
  return { ok: true, action: 'rows', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { count: d.count, in: d.in, rows: rows.slice(0, shown) } }
}

async function downloadsAction(bridge, params, started) {
  const r = await bridge.call('downloads', { ...tabLoc(params), limit: params.limit }, { timeoutMs: 20000 })
  const d = r || {}
  if (!r.ok) return fail('downloads', r, started)
  const rows = d.rows || []
  const lines = [`【chrome:downloads】${pageHeader(d)} · ${rows.length} 条`]
  if (!rows.length) lines.push('—— 空（下载事件只在 CDP 挂上之后才有：先点下载，再查这里）——')
  for (const row of rows) {
    const kb = row.received ? ` ${Math.round(row.received / 1024)}KB` : ''
    lines.push(`· ${row.state}${kb} ${clip(row.file || row.url || '(未知)', 100)}`)
  }
  return { ok: true, action: 'downloads', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { total: d.total, rows } }
}

/* ----------------------------- 浏览历史 ----------------------------- */

/**
 * 「这个页面是在哪个地址打开的」——没有标签可定位，走浏览器历史。
 * 2026-11-20 加：排查两个看板时，NY 根本没部署在本机这台服务器上，
 * 只能从历史里翻它到底开在哪个地址；当时是绕过工具去啃 History.sqlite 的。
 */
async function historyAction(bridge, params, started) {
  const keyword = String(params.keyword || params.text || '').trim()
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 30))
  const r = await bridge.call('history', { keyword, limit, sinceDays: params.sinceDays }, { timeoutMs: 20000 })
  const d = r || {}
  if (!r.ok) return fail('history', r, started)
  const rows = d.rows || []
  const scope = keyword ? `关键词「${clip(keyword, 40)}」` : '最近访问'
  const lines = [`【chrome:history】${scope} · ${rows.length} 条${params.sinceDays ? `（近 ${params.sinceDays} 天）` : ''}`]
  for (const row of rows) {
    const when = row.lastVisitTime ? new Date(row.lastVisitTime).toLocaleString('zh-CN', { hour12: false }) : '?'
    lines.push(`· ${when} ×${row.visitCount} ${clip(row.title || '(无标题)', 50)}`)
    lines.push(`    ${clip(row.url, 160)}`)
  }
  if (!rows.length) {
    lines.push(keyword
      ? '—— 空：换个关键词，或去掉 sinceDays 放宽时间窗 ——'
      : '—— 空：最近没有访问记录 ——')
    // iframe 里的导航不进 Chrome 历史（编辑器、门户业务页基本都在 iframe 里），
    // 查不到不代表没开过，得换个入口（1.13.0，实测两次空结果都是这个原因）。
    lines.push('（注：Chrome 历史只记顶层导航，iframe 里的业务页查不到——用 action=frames 看当前标签的帧，或直接 action=tabs）')
  }
  return { ok: true, action: 'history', ms: Date.now() - started, message: lines.join('\n'), detail: { keyword, count: rows.length, rows } }
}

async function read(bridge, params, started) {
  const wantFull = Number(params.maxChars) === 0
  // 模型侧窗口就是页面侧窗口：要多少给多少，别「页面给 20000、这里又切到 6000」白传一趟。
  const windowChars = wantFull ? 0 : Math.max(500, Math.min(20000, Number(params.maxChars) || 6000))
  const offset = Math.max(0, Number(params.offset) || 0)
  const r = await bridge.call('read', {
    ...tabLoc(params),
    maxChars: windowChars, offset, selector: params.selector, includeHtml: params.includeHtml,
    inputs: params.inputs, sections: params.sections, tables: params.tables, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail('read', r, started)
  const total = Number(d.textLength) || 0
  const body = wantFull ? clip(String(d.text || ''), 200000) : String(d.text || '')
  const start = Number(d.offset) || 0
  const end = start + body.length
  const more = d.truncated === true && end < total
  const lines = [
    `【chrome:read】${pageHeader(d)}`,
    `标题：${d.title || ''}`,
    `正文 ${total} 字 · 本次第 ${start}–${end} 字${more ? '，还有下文' : ''}`,
  ]
  // 自动下沉到子 iframe 时明确说一声：2026-11-27 排查 MOM 审批页时，read frame=173
  // 实际读的是它下面正文更长的 history-step（frame=175），回执却像读的就是 173，
  // 拿这段正文当"任务详情"用会张冠李戴。
  if (d.frame && d.frame.auto) {
    const askedFrame = params.frame == null || params.frame === '' ? null : Number(params.frame)
    lines.push(
      `（正文偏少，已自动下沉到 iframe${d.frame.title ? '「' + clip(d.frame.title, 30) + '」' : ''}：${clip(d.frame.src, 120)}` +
      `${askedFrame != null ? `；你传的是 frame=${askedFrame}，不是这个子帧` : ''}` +
      '。要读本帧自身就传 selector 收窄，或先 action=frames 直接指定子帧）',
    )
  }
  if (Array.isArray(d.tables) && d.tables.length) {
    lines.push('（表格已按行展开：' + d.tables.map((t) => `#${t.index} ` + (t.rows ? `${t.rows}行×${t.cols}列` : `表头 ${t.cols} 列`) + (t.headers?.length ? `，表头：${clip(t.headers.join('/'), 60)}` : '')).join('；') + '）')
  }
  lines.push('—— 正文 ——', body)
  if (offset > 0 && !d.offset) lines.push('（扩展版本旧，没支持 offset：这次给的是从头开始的正文。chrome://extensions 里重载扩展再试。）')
  if (more) lines.push(`（还有 ${total - end} 字：接着读 {action:"read", offset:${d.nextOffset ?? end}}；要整篇就 action=value + saveTo 落盘）`)
  if (d.links?.length) {
    lines.push(`—— 链接 ${d.links.length} 条（列前 15）——`)
    for (const l of d.links.slice(0, 15)) lines.push(`· ${clip(l.text || '(无文字)', 50)} → ${clip(l.href, 120)}`)
  }
  if (d.inputs?.length) {
    lines.push(`—— 输入框 ${d.inputsTotal ?? d.inputs.length} 个（列前 15，inputs:'none' 可关）——`)
    for (const el of d.inputs.slice(0, 15)) {
      const v = el.value === '***' ? '***' : clip(el.value, 300)
      lines.push(`· ${el.tag}${el.type ? '[' + el.type + ']' : ''} name=${el.name || '-'} id=${el.id || '-'} placeholder=${clip(el.placeholder, 30) || '-'}${el.valueLength > 300 ? `（值 ${el.valueLength} 字，用 value 读全）` : ''} value=${v}`)
    }
  }
  if (d.buttons?.length) {
    lines.push(`—— 按钮 ${d.buttons.length} 个（列前 15）——`)
    for (const b of d.buttons.slice(0, 15)) lines.push(`· ${clip(b.text || '(无文字)', 40)}${b.disabled ? '（禁用）' : ''} → ${b.selector}`)
  }
  if (d.forms?.length) {
    lines.push(`—— 表单 ${d.forms.length} 个 ——`)
    for (const f of d.forms.slice(0, 10)) lines.push(`· ${f.method.toUpperCase()} ${clip(f.action, 100)}（${f.fields} 个字段）`)
  }
  return {
    ok: true, action: 'read', ms: Date.now() - started, tab: d.tab,
    message: lines.join('\n'),
    detail: {
      url: d.url, title: d.title, textLength: d.textLength, truncated: d.truncated,
      text: d.text, links: d.links, inputs: d.inputs, inputsTotal: d.inputsTotal,
      buttons: d.buttons, forms: d.forms, headings: d.headings, frame: d.frame,
    },
  }
}

/**
 * outline：这页有什么能点/能填，一行一个，带 ref。
 * 比 read 正文省得多（一行一个元素，不贴整页文字），而且拿到的 ref 可以直接
 * 传给 click/type/check——不用猜 CSS，也不用先 query 再点，两个来回变一个。
 */
async function outline(bridge, params, started) {
  const r = await bridge.call('outline', {
    ...tabLoc(params),
    limit: params.limit, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 20000 })
  const d = r || {}
  if (!r.ok) return fail('outline', r, started)
  const rows = d.rows || []
  const lines = [
    `【chrome:outline】${pageHeader(d)}`,
    `可交互元素 ${d.total} 个，列 ${d.shown} 个${d.skippedInvisible ? `（跳过 ${d.skippedInvisible} 个隐藏/不可见）` : ''}${d.truncated ? '，还有更多（limit 调大或缩小范围）' : ''}`,
  ]
  // 折叠菜单：里面的元素根本不在列表里，不给提示就只能靠猜父菜单再点一次（2026-11-24 找二级菜单时踩到）
  if (d.hiddenInCollapsed > 0) {
    const wins = (d.collapsedTriggers || []).map((x) => '「' + clip(x.name, 20) + '」').join('、')
    lines.push(`（另有 ${d.hiddenInCollapsed} 个可交互元素在折叠菜单里，未列出：${wins ? `先展开${wins}，再 outline 一次` : '先展开父菜单再 outline'}；也可以直接 click text:"子菜单名"）`)
  }
  // 整页元素全被判成隐藏：几乎只有一个原因——这是个 display:none 的 iframe（门户里
  // 没被激活的业务页）。click 一样点不到，得换打法（2026-11-27 MOM 审批页实测）。
  if (Number(d.total) > 0 && Number(d.shown) === 0 && Number(d.skippedInvisible) >= Number(d.total)) {
    lines.push('（这页元素全部被判为隐藏：多半是 display:none 的 iframe 或未激活的门户标签页。click/outline 都点不到——改用 eval 在该帧里 document.querySelector(...).click()，提交后用 networkLog 确认接口真发了；也可以先在壳页把这个标签切到前台再操作）')
  }
  for (const row of rows) {
    if (row.collapsed) { lines.push('  ' + row.name); continue }
    // 紧凑行：`e1 textbox 姓名`——省掉方括号和引号，一行一个元素
    const bits = [`${row.ref} ${row.role} ${clip(row.name, 60)}`]
    if (row.checked === true) bits.push('✓')
    else if (row.checked === false) bits.push('✗')
    if (row.disabled) bits.push('(禁用)')
    if (row.href) bits.push('→ ' + clip(row.href, 50))
    if (row.value) bits.push(`="${clip(row.value, 40)}"`)
    lines.push(bits.join(' '))
  }
  return { ok: true, action: 'outline', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { total: d.total, shown: d.shown, rows } }
}

async function query(bridge, params, started) {
  const r = await bridge.call('query', {
    ...tabLoc(params),
    selector: params.selector, limit: params.limit, frame: params.frame,
  }, { timeoutMs: 20000 })
  const d = r || {}
  if (!r.ok) return fail('query', r, started)
  const lines = [`【chrome:query】${pageHeader(d)}`, `匹配 ${d.count} 个，列出 ${d.shown} 个`]
  for (const row of d.rows || []) {
    const stable = row.stable === 'id' ? '' : row.textHint ? `（建议 text:"${clip(row.textHint, 30)}"）` : ''
    lines.push(`· <${row.tag}> ${clip(row.text, 100)} | ${row.selector}${row.visible ? '' : '（不可见）'}${stable}`)
  }
  return { ok: true, action: 'query', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { count: d.count, rows: d.rows } }
}

async function simple(bridge, action, params, started, label) {
  const r = await bridge.call(action, {
    ...tabLoc(params),
    selector: params.selector, value: params.value, checked: params.checked,
    dy: params.dy, dx: params.dx, toBottom: params.toBottom, smooth: params.smooth,
    bypassCache: params.bypassCache, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail(action, r, started)
  const extra = d.selected ? ` → ${d.selected.text}（value=${d.selected.value}）` : ''
  return {
    ok: true, action, ms: Date.now() - started, tab: d.tab,
    message: `【chrome:${action}】${label}：${pageHeader(d)}${extra}`,
    detail: d,
  }
}

async function navigate(bridge, params, started) {
  if (!params.url) return { ok: false, action: 'navigate', ms: Date.now() - started, message: '【chrome:navigate】需要 url 参数' }
  const r = await bridge.call('navigate', {
    ...tabLoc(params),
    url: params.url, expectUrl: params.expectUrl, waitUntil: params.waitUntil, timeoutMs: params.timeoutMs,
  }, { timeoutMs: Math.max(40000, (Number(params.timeoutMs) || 0) + 10000) })
  const d = r || {}
  if (!r.ok) return fail('navigate', r, started)
  const arrived = d.landed === true
  const via = d.via === 'poll' ? '轮询兜底' : '事件判定'
  const lines = [
    `【chrome:navigate】${arrived ? '已到达' : (d.loadPending ? `已发出，没等到 ${d.waitUntil || 'load'}` : '没落地')}（${d.waitUntil || 'load'} · ${d.waitedMs ?? 0}ms · ${via}）：${pageHeader(d)}`,
  ]
  if (!arrived && d.loadPending) lines.push(`注意：页面**可能还在加载**，别把这次当成加载完成。要等具体元素就用 action=wait selector=...`)
  if (d.sameDocument) lines.push('（同文档跳转：地址/锚点变了，文档没换）')
  if (d.hashOnly) lines.push(`⚠ ${d.hashOnlyNote || '只改了 #hash：页面没有重新加载，是否切换视图取决于前端路由。'}`)
  if (d.siteUnreachable) lines.push(`站点打不开（${d.siteUnreachable.reason}）：域名解析失败或网络不通`)
  if (d.cdpFallback) lines.push(`CDP 没挂上，这次退回轮询（判断精度差）：${clip(d.cdpFallback, 200)}`)
  lines.push('（要回到上一页用 action=back；比再点一遍菜单稳，也不会被折叠菜单挡住）')
  return { ok: true, action: 'navigate', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: d }
}

/** 打开新标签：到达判定和 navigate 同一套，结果挂在 arrival 里。 */
async function open(bridge, params, started) {
  const r = await bridge.call('open', {
    url: params.url, active: params.active, windowId: params.windowId, newWindow: params.newWindow,
    expectUrl: params.expectUrl, wait: params.wait, waitUntil: params.waitUntil, timeoutMs: params.timeoutMs,
  }, { timeoutMs: Math.max(45000, (Number(params.timeoutMs) || 0) + 10000) })
  const d = r || {}
  if (!r.ok) return fail('open', r, started)
  const a = d.arrival || null
  const lines = [`【chrome:open】新标签已打开：${pageHeader(d)}`]
  if (a) {
    lines.push(a.landed
      ? `到达判定：${a.waitUntil || 'load'} · ${a.waitedMs ?? 0}ms${a.sameDocument ? ' · 同文档' : ''}`
      : `注意：已发出但没等到 ${a.waitUntil || 'load'}（${a.waitedMs ?? 0}ms），页面还在加载`)
  }
  if (d.cdpFallback) lines.push(`CDP 没挂上，退回轮询：${clip(d.cdpFallback, 160)}`)
  return { ok: true, action: 'open', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: d }
}

async function click(bridge, params, started) {
  const hasLocator = params.ref || params.selector || params.text || params.label || params.role
    || params.placeholder || params.name || params.ariaLabel || params.rowText
  if (!hasLocator) {
    return { ok: false, action: 'click', ms: Date.now() - started, message: '【chrome:click】需要 ref / selector / text / rowText / label / role / placeholder / name 之一（ref 从 action=outline 拿）。有状态元素（勾选/开关）请用 check。' }
  }
  const r = await bridge.call('click', {
    ...tabLoc(params),
    ref: params.ref, selector: params.selector, text: params.text,
    label: params.label, role: params.role, placeholder: params.placeholder, name: params.name, ariaLabel: params.ariaLabel,
    rowText: params.rowText, in: params.in, target: params.target, rowMatch: params.rowMatch,
    retry: params.retry, expect: params.expect, exact: params.exact,
    afterMs: params.afterMs, timeoutMs: params.timeoutMs, dryRun: params.dryRun, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail('click', r, started)
  if (d.dryRun) {
    const c = d.wouldClick || {}
    return {
      ok: true, action: 'click', ms: Date.now() - started, tab: d.tab,
      message: `【chrome:click·预览】准备点击 <${c.tag}>「${clip(c.text, 60)}」${c.href ? ' → ' + c.href : ''}\n没有真的点。确认后去掉 dryRun 再调一次。\n现在：${pageHeader(d)}`,
      detail: d,
    }
  }
  const c = d.clicked || {}
  const extra = d.attempts > 1 ? `（点了 ${d.attempts} 次才生效）` : ''
  const dLine = deltaLine(d.delta)
  return {
    ok: true, action: 'click', ms: Date.now() - started, tab: d.tab,
    message: `【chrome:click】已点击 <${c.tag}>「${clip(c.text, 60)}」${c.href ? ' → ' + c.href : ''}${extra}${d.verified ? ' · 已校验' : ''}\n点击后：${pageHeader(d)}${dLine ? '\n' + dLine : ''}`,
    detail: d,
  }
}

async function type(bridge, params, started) {
  const hasLocator = params.ref || params.selector || params.hint || params.name || params.label || params.placeholder || params.ariaLabel || params.role
  if (!hasLocator) return { ok: false, action: 'type', ms: Date.now() - started, message: '【chrome:type】需要 ref / selector / hint / name / label / placeholder / ariaLabel 之一' }
  const r = await bridge.call('type', {
    ...tabLoc(params),
    ref: params.ref, selector: params.selector, hint: params.hint, value: params.value == null ? '' : params.value,
    name: params.name, label: params.label, placeholder: params.placeholder, ariaLabel: params.ariaLabel, role: params.role,
    clear: params.clear, submit: params.submit, submitMode: params.submitMode, verify: params.verify,
    expectUrl: params.expectUrl, timeoutMs: params.timeoutMs, dryRun: params.dryRun, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 40000 })
  const d = r || {}
  const act = params.submit ? 'submit' : 'type'
  if (!r.ok) return fail(act, r, started)
  if (d.dryRun) {
    const w = d.wouldFill || {}
    return {
      ok: true, action: act, ms: Date.now() - started, tab: d.tab,
      message: `【chrome:${act}·预览】准备填入 ${w.tag || '输入框'}${w.name ? '（name=' + w.name + '）' : ''}，${d.masked ? '这是密码框' : '值长度 ' + (d.valueLength ?? 0)}${params.submit ? '，并提交' : ''}\n没有真的填。确认后去掉 dryRun 再调一次。\n现在：${pageHeader(d)}`,
      detail: d,
    }
  }
  const filled = d.filled || {}
  const verifiedNote = d.verified === true ? '· 已回读校验' : ''
  const submNote = d.submitted ? `；已提交（${d.submitted}）` : ''
  return {
    ok: true, action: act, ms: Date.now() - started, tab: d.tab,
    message: `【chrome:${act}】已填入 ${filled.tag || '输入框'}${filled.name ? '（name=' + filled.name + '）' : ''}，值：${clip(d.value, 60)}${verifiedNote}${submNote}\n现在：${pageHeader(d)}${deltaLine(d.delta) ? '\n' + deltaLine(d.delta) : ''}`,
    detail: d,
  }
}

async function check(bridge, params, started) {
  const hasLocator = params.ref || params.selector || params.rowText || params.name || params.label || params.text
  if (!hasLocator) {
    return { ok: false, action: 'check', ms: Date.now() - started, message: '【chrome:check】需要 ref / selector / rowText / name / label / text 之一。rowText + in + target 是按行文本勾选（推荐）。' }
  }
  const r = await bridge.call('check', {
    ...tabLoc(params),
    ref: params.ref, selector: params.selector, checked: params.checked, index: params.index,
    name: params.name, label: params.label, text: params.text,
    rowText: params.rowText, in: params.in, target: params.target, rowMatch: params.rowMatch,
    retry: params.retry, dryRun: params.dryRun, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail('check', r, started)
  if (d.dryRun) {
    return {
      ok: true, action: 'check', ms: Date.now() - started, tab: d.tab,
      message: `【chrome:check·预览】「${clip(d.text, 50)}」现在是 ${d.before ? '选中' : '未选中'}，目标 ${d.wanted ? '选中' : '未选中'}${d.wouldClick ? '，会点一下' : '，不用动'}。\n没有真的点。\n现在：${pageHeader(d)}`,
      detail: d,
    }
  }
  const state = d.checked ? '已选中' : '未选中'
  const what = d.skipped ? '本来就是目标状态，没点' : (d.attempts > 1 ? `点了 ${d.attempts} 次才生效` : '点了一次')
  const line = '· ' + clip(d.text || params.rowText || params.selector || '', 60) + ' → ' + state
  return {
    ok: true, action: 'check', ms: Date.now() - started, tab: d.tab,
    message: `【chrome:check】${what}${d.stateSource ? `（状态取自 ${d.stateSource}）` : ''}\n${line}\n${pageHeader(d)}${deltaLine(d.delta) ? '\n' + deltaLine(d.delta) : ''}`,
    detail: d,
  }
}

async function isChecked(bridge, params, started) {
  if (!params.in && !params.selector) {
    return { ok: false, action: 'isChecked', ms: Date.now() - started, message: '【chrome:isChecked】需要 in（行容器，如 "tbody tr"，推荐）或 selector' }
  }
  const r = await bridge.call('isChecked', {
    ...tabLoc(params),
    in: params.in, selector: params.selector, target: params.target, limit: params.limit, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 25000 })
  const d = r || {}
  if (!r.ok) return fail('isChecked', r, started)
  const rows = d.rows || []
  const lines = [`【chrome:isChecked】${pageHeader(d)}`, `共 ${d.total} 行，选中 ${d.checkedCount} 个`]
  const preview = rows.slice(0, Number(params.limit || 30))
  for (const row of preview) {
    lines.push(`· [${row.checked ? '✓' : ' '}] ${clip(row.text, 70)}${row.hasControl === false ? '（行里没有勾选控件）' : ''}`)
  }
  if (rows.length > preview.length) lines.push(`（只列前 ${preview.length} 行，共 ${rows.length} 行；detail.rows 有全部）`)
  return {
    ok: true, action: 'isChecked', ms: Date.now() - started, tab: d.tab,
    message: lines.join('\n'),
    detail: { total: d.total, checkedCount: d.checkedCount, rows },
  }
}

async function valueOf(bridge, params, started, root) {
  if (!params.selector) {
    return { ok: false, action: 'value', ms: Date.now() - started, message: '【chrome:value】需要 selector（如 textarea、#result）。prop 可选 value/text/html。' }
  }
  const wantFull = Number(params.maxChars) === 0 || params.fullValue
  const r = await bridge.call('value', {
    ...tabLoc(params),
    selector: params.selector, prop: params.prop, index: params.index,
    maxChars: wantFull ? 0 : (Number(params.maxChars) || 2000), fullValue: params.fullValue, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 25000 })
  const d = r || {}
  if (!r.ok) return fail('value', r, started)

  let file = ''
  if (params.saveTo) {
    const target = resolveSavePath(root, params.saveTo, 'value.txt')
    await ensureDir(target.dir)
    file = target.file
    await writeFile(file, String(d.value ?? ''), 'utf8')
  }

  const lines = [`【chrome:value】${pageHeader(d)}`, `${d.prop} · ${d.length} 字${d.truncated ? '（已截断）' : ''}`]
  if (file) {
    lines.push(`已落盘：${file}`)
    lines.push(`预览（前 200 字）：${clip(d.value, 200)}`)
  } else if (wantFull) {
    lines.push('—— 全文 ——')
    lines.push(String(d.value ?? ''))
  } else {
    lines.push('—— 值 ——')
    lines.push(clip(d.value, 2000))
    if (d.length > 2000) lines.push('（要全文：maxChars:0；不想烧 token 就加 saveTo:"名字.txt"）')
  }
  return {
    ok: true, action: 'value', ms: Date.now() - started, tab: d.tab,
    message: lines.join('\n'),
    // detail 里只放预览：全文已经在 message 里了，两边都塞等于双倍 token
    detail: { length: d.length, prop: d.prop, truncated: d.truncated, file, preview: clip(d.value, file ? 300 : 1500) },
  }
}

/**
 * eval 里改写原生 API 的告警（1.12.0）。
 *
 * 2026-11-23 实测事故：为了记录 window.open 的目标地址，patch 了它，收尾时
 * `delete window.open` —— 结果 open 直接变 undefined，因为它是 window 的**自有属性**，
 * 原型上没有可以回落的原生版本。页面上的「重新推送」差点废掉，最后靠 F5 才恢复。
 *
 * 这类临时观测现在有正规做法：看标签页开/关用 tabEvents，不用再动 window.open。
 * 真要动，就提醒一句「改完怎么还原」。
 */
function nativePatchWarnings(code) {
  const text = String(code || '')
  const hits = new Set()
  const add = (name) => { if (name) hits.add(name) }
  let m
  const reAssign = /\bwindow\.(open|close|fetch|alert|confirm|prompt|print|stop|postMessage)\s*=(?!=)/g
  while ((m = reAssign.exec(text))) add('window.' + m[1])
  const reDelete = /\bdelete\s+window\.(open|close|fetch|alert|confirm|prompt)\b/g
  while ((m = reDelete.exec(text))) add('delete window.' + m[1])
  const reProto = /\b(XMLHttpRequest|Notification|WebSocket)\.prototype\.(\w+)\s*=(?!=)/g
  while ((m = reProto.exec(text))) add(`${m[1]}.prototype.${m[2]}`)
  if (/Object\.defineProperty\s*\(\s*window\b/.test(text)) add('Object.defineProperty(window, …)')
  return [...hits]
}

const SNIPPET_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const snippetsDir = (root) => path.join(chromeHome(root), 'snippets')

/** 读片段：~/.dsh/chrome/snippets/<name>.js，{{key}} 用 vars 替换（字符串原样、其余 JSON 化）。 */
async function loadSnippet(root, name, vars) {
  const n = String(name || '').replace(/\.js$/i, '')
  if (!SNIPPET_RE.test(n) || n.includes('..')) throw new Error(`片段名不合法：${name}`)
  const file = path.join(snippetsDir(root), `${n}.js`)
  const raw = await readFile(file, 'utf8')
  let code = raw
  if (vars && typeof vars === 'object') {
    code = code.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, k) => {
      const v = vars[k]
      if (v === undefined) return m
      return typeof v === 'string' ? v : JSON.stringify(v)
    })
  }
  return { code, file }
}

async function listSnippets(root) {
  try {
    return (await readdir(snippetsDir(root)))
      .filter((f) => /\.js$/i.test(f))
      .map((f) => f.replace(/\.js$/i, ''))
      .sort()
  } catch {
    return []
  }
}

/** 超时了也不能把已算出来的东西全丢：saveTo 派生出 .partial.json。 */
function partialName(saveTo) {
  const s = String(saveTo || '')
  if (!s) return `eval-partial-${Date.now().toString(36)}.json`
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(s)
  return `${m[1] || 'eval'}.partial${m[2] || '.json'}`
}

/**
 * 抢救 window.__dshChunks：命令超时/被看门狗放弃后，页面里的异步循环通常还活着，
 * 已 push 的分段还能读回来。读不到就安静返回 null，别把原始错误盖掉。
 */
async function salvageChunks(bridge, params, root) {
  try {
    const r = await bridge.call('eval', {
      ...tabLoc(params),
      code: 'JSON.stringify(window.__dshChunks || [])',
      maxChars: 0,
      frame: params.frame,
    }, { timeoutMs: 20000 })
    if (!r || !r.ok) return null
    const arr = JSON.parse(r.value || '[]')
    if (!Array.isArray(arr) || !arr.length) return null
    const target = resolveSavePath(root, partialName(params.saveTo), 'eval-partial.json')
    await ensureDir(target.dir)
    await writeFile(target.file, JSON.stringify(arr, null, 2), 'utf8')
    return { count: arr.length, file: target.file }
  } catch {
    return null
  }
}

async function evalCode(bridge, params, started, root) {
  // 片段：把常用脚本放到 ~/.dsh/chrome/snippets/<name>.js，eval 只传 snippet + vars。
  // 以前同一段 40 行的导出脚本每批手打一遍，改一处漏一处（2026-11-24 备份接口时）。
  let code = params.code
  let snippetFile = ''
  if (params.snippet != null && String(params.snippet).trim()) {
    if (String(params.snippet).trim() === '?') {
      const names = await listSnippets(root)
      return {
        ok: true, action: 'eval', ms: Date.now() - started,
        message: `【chrome:eval】可用片段（${snippetsDir(root)}）：\n${names.length ? names.map((n) => '· ' + n).join('\n') : '（还没有片段：把 .js 放进这个目录即可）'}\n用法：{action:"eval", snippet:"名字", vars:{k:v}}，片段里的 {{k}} 会被替换。`,
        detail: { snippets: names, dir: snippetsDir(root) },
      }
    }
    try {
      const s = await loadSnippet(root, params.snippet, params.vars)
      code = s.code
      snippetFile = s.file
    } catch (error) {
      return {
        ok: false, action: 'eval', ms: Date.now() - started,
        message: `【chrome:eval】读片段失败：${error.message}。片段放在 ${snippetsDir(root)}，文件名 <name>.js；传 snippet:"?" 可列出已有片段。`,
      }
    }
  }
  if (!code) return { ok: false, action: 'eval', ms: Date.now() - started, message: '【chrome:eval】需要 code 或 snippet' }
  const action = params.world === 'MAIN' && params.evalMain ? 'evalMain' : 'eval'
  let r
  try {
    r = await bridge.call('eval', {
      ...tabLoc(params),
      code, world: params.world, timeoutMs: params.timeoutMs, runId: params.runId, frame: params.frame,
      // pick：只回一条路径（a.b[0].c / rows[*].code），在页面里就筛完，省 token
      pick: params.pick,
      // 要落盘就让扩展回全量：裁剪是在页面里做的，先裁再落盘只能存下半截
      // （2026-11-20 修：以前 saveTo 拿到的永远是被 maxChars 砍过的内容）。
      maxChars: params.saveTo ? 0 : params.maxChars,
    }, { timeoutMs: (Number(params.timeoutMs) || 25000) + 8000 })
  } catch (error) {
    // 超时/看门狗：命令没回话，但页面里的循环可能已经攒了一部分结果。
    // 约定：代码把中间结果 push 到 window.__dshChunks，这里在失败后补一条短 eval 取回来落盘。
    const ec = (error && error.errorCode) || 'THROWN'
    if (/TIMEOUT|WATCHDOG/.test(ec)) {
      const saved = await salvageChunks(bridge, params, root)
      if (saved && error && typeof error === 'object') error.salvage = saved
    }
    throw error
  }
  const d = r || {}
  if (!r.ok) return fail('eval', r, started)
  const valueText = typeof d.value === 'string' ? d.value : JSON.stringify(d.value, null, 2)
  const world = d.world || params.world || 'MAIN'
  const notes = []
  // 帧坐标（1.13.0）：同上一次事故——frame 传了、回执却只说「标签 + 世界」，
  // 结果跑在别的帧里报 ReferenceError，只能靠猜。这里把请求帧和实际帧都摆出来。
  const requestedFrame = params.frame == null || params.frame === '' ? null : Number(params.frame)
  const actualFrame = d.execFrameId == null ? null : Number(d.execFrameId)
  const frameTag = requestedFrame != null ? [`frame=${requestedFrame}`] : []
  if (requestedFrame != null && actualFrame != null && actualFrame !== requestedFrame) {
    notes.push(`⚠️ 请求 frame=${requestedFrame}，实际在 frame=${actualFrame} 执行——这个帧参数没生效，结果可能来自别的帧。先 action=frames 核对帧号再重试。`)
  }
  if (d.fellBackTo === 'CDP') notes.push('（页面 CSP 禁了 unsafe-eval，这条是用 DevTools 的 Runtime.evaluate 跑的，不受页面 CSP 限制）')
  else if (d.fellBackTo) notes.push(`（扩展世界禁 eval，已自动退到 ${d.fellBackTo} 世界执行）`)
  if (d.runId) notes.push(`runId=${d.runId}（要停就用 action=abort）`)
  if (d.picked) notes.push(`（pick=${d.picked}：只回了这条路径的值）`)
  if (looksUnauthorized(null, valueText)) notes.push(AUTH_HINT)

  // 大结果落盘：一次 eval 返回几十万字会把后面几轮的上下文都吃掉，给个出口。
  let file = ''
  const body = String(valueText == null ? '' : valueText).trim()
  if (params.saveTo && body) {
    const target = resolveSavePath(root, params.saveTo, 'eval.txt')
    await ensureDir(target.dir)
    file = target.file
    await writeFile(file, body, 'utf8')
  }
  if (d.truncated) notes.push(`（返回值 ${d.valueLength} 字，超过 maxChars，已按字段深度裁剪；结构仍是合法 JSON。要全文用 maxChars:0，或加 saveTo 落全量）`)
  // 长任务提醒：扩展侧看门狗 90 秒一到就放弃等待，timeoutMs 写多大都没用。
  // 这一条只在「可能接近上限」时出现，正常短 eval 不会多出噪音。
  const elapsed = Date.now() - started
  if (Number(params.timeoutMs) > 60000 || elapsed > 60000) {
    notes.push('（长任务提示：单条命令实际上限约 90 秒（扩展看门狗），timeoutMs 再大也会被放弃；长任务请分批，并把中间结果 push 到 window.__dshChunks，超时后会抢救成 .partial.json）')
  }
  if (snippetFile) notes.push(`（用的是片段 ${params.snippet}：${snippetFile}）`)
  const patched = nativePatchWarnings(code)
  if (patched.length) {
    notes.push(`⚠️ 这段代码改写了原生 API：${patched.join('、')}。改完必须还原——最稳的是 action=reload；`
      + '`delete window.open` 这类不一定能恢复（window.open 是 window 的自有属性，原型上没有，删了就真没了）。'
      + '只是想看「点一下开了哪个标签页」的话，用 action=tabEvents，不用动页面。')
  }
  // saveTo 的意图就是「别把正文塞回上下文」：没显式传 quiet:false 就自动安静。
  // 以前 saveTo 了还回显代码 + 500 字预览，等于白落盘（2026-11-24 备份接口时每批多花几千 token）。
  const effQuiet = params.quiet === true || (params.quiet == null && Boolean(params.saveTo))
  return {
    ok: true, action, ms: Date.now() - started, tab: d.tab,
    message: `【chrome:eval】${pageHeader(d)} · ${world} 世界${frameTag.length ? ' · ' + frameTag.join(' · ') : ''}`
      + `${notes.length ? '\n' + notes.join('\n') : ''}`
      + `${effQuiet ? '' : `\n${snippetFile ? `片段：${params.snippet}（${snippetFile}）` : `代码：${clip(code, 300)}`}`}`
      + `\n结果（${d.type}）：\n${file ? `已落盘：${file}（${body.length} 字，全量）\n预览：${clip(body, effQuiet ? 160 : 500)}` : clip(valueText, 6000)}`,
    detail: {
      code: snippetFile ? undefined : code, snippet: params.snippet, snippetFile,
      type: d.type, value: file ? clip(body, 500) : d.value, world, runId: d.runId, file,
      valueLength: d.valueLength, truncated: d.truncated, picked: d.picked, via: d.via || 'in-page',
    },
  }
}

async function abort(bridge, params, started) {
  const r = await bridge.call('abort', {
    ...tabLoc(params), runId: params.runId, hard: params.hard === true,
  }, { timeoutMs: 25000 })
  const d = r || {}
  if (!r.ok) return fail('abort', r, started)
  const lines = []
  if (d.hard) {
    lines.push(`【chrome:abort】硬停：${d.note || ''}`)
    if (d.reason === 'page-busy') lines.push('（协作式取消送不进页面——主线程被占住了，才用的硬停）')
    if (d.cooperative && d.cooperative.error) lines.push(`协作式取消的失败原因：${String(d.cooperative.error).slice(0, 160)}`)
    lines.push('页面可能已经被打断在半个状态上：接着用 read / screenshot 看一眼再决定下一步，别直接重放写操作。')
  } else {
    lines.push(d.cancelledAll != null
      ? `【chrome:abort】标记了 ${d.cancelledAll} 个在跑的任务为「已取消」。注意：只有代码里调了 window.__dshAborted(runId) 的地方才会真的退出。`
      : `【chrome:abort】已标记 ${d.cancelled} 取消。`)
    lines.push('注意：页面若已彻底卡死（同步死循环），协作式取消和硬停都进不去——等看门狗收场后 action=reload 刷新该标签。')
  }
  return { ok: true, action: 'abort', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: d }
}

async function waitFor(bridge, params, started) {
  const tabLoc = params.tabId != null
    ? { tabId: params.tabId }
    : params.index != null
      ? { index: params.index }
      : (params.urlContains ? { urlContains: params.urlContains } : {})
  const r = await bridge.call('wait', {
    ...tabLoc,
    selector: params.selector, text: params.text, urlContains: params.waitUrl,
    timeoutMs: params.timeoutMs, pollMs: params.pollMs, visible: params.visible,
    exact: params.exact, changed: params.changed, value: params.value, until: params.until, count: params.count,
    textGone: params.textGone, time: params.time,
    frame: params.frame,
  }, { timeoutMs: (params.timeoutMs || 15000) + 8000 })
  const d = r || {}
  if (!r.ok) return fail('wait', r, started)
  const label = {
    selector: '元素出现了', count: `元素数量到了（${d.count} 个）`, text: '文字出现了', 'text-exact': '文字精确出现了',
    'text-gone': '文字消失了', time: `等了 ${d.waited ?? 0} 秒`,
    url: 'URL 变了', value: '输入框值到了', changed: '内容变了', until: '条件满足',
  }[d.matched] || '已满足'
  return {
    ok: true, action: 'wait', ms: Date.now() - started, tab: d.tab,
    message: `【chrome:wait】${label}（${d.ms}ms）${d.text ? '：' + clip(d.text, 100) : ''}`,
    detail: d,
  }
}

/* ----------------------------- 结构化提取 ----------------------------- */

async function extract(bridge, params, started) {
  const r = await bridge.call('extract', {
    ...tabLoc(params),
    selector: params.selector, items: params.items, fields: params.fields, limit: params.limit,
    maxChars: params.maxChars, fullValues: params.fullValues, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail('extract', r, started)
  const shown = Math.max(1, Math.min(200, Number(params.show) || 30))
  const lines = [`【chrome:extract】${pageHeader(d)}`, `提取 ${d.count} 行${d.count > shown ? `（列前 ${shown} 行）` : ''}`]
  for (const row of (d.rows || []).slice(0, shown)) {
    const parts = Object.entries(row).map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), Number(params.maxChars) === 0 ? 4000 : 120)}`)
    lines.push('· ' + parts.join(' | '))
  }
  if ((d.rows || []).length > shown) lines.push(`（只列前 ${shown} 行，共 ${d.rows.length} 行）`)
  return {
    ok: true, action: 'extract', ms: Date.now() - started, tab: d.tab,
    message: lines.join('\n'),
    detail: { count: d.count, rows: d.rows, url: d.url, title: d.title },
  }
}

/* ----------------------------- 快照与对比 ----------------------------- */

function snapshotsDir(root) {
  return path.join(chromeHome(root), 'snapshots')
}

async function snapshot(bridge, params, started, root) {
  const r = await bridge.call('snapshot', {
    ...tabLoc(params),
    maxChars: params.maxChars, allFrames: params.allFrames, timeoutMs: params.timeoutMs, frame: params.frame,
  }, { timeoutMs: params.timeoutMs || 30000 })
  const d = r || {}
  if (!r.ok) return fail('snapshot', r, started)
  const dir = snapshotsDir(root)
  await mkdir(dir, { recursive: true })
  const id = `snap-${Date.now().toString(36)}-${d.tab?.id ?? 'tab'}`
  const file = path.join(dir, `${id}.json`)
  await writeFile(file, JSON.stringify({ id, ts: new Date().toISOString(), ...d }, null, 2), 'utf8')
  const lines = [
    `【chrome:snapshot】${pageHeader(d)}`,
    `快照 id：${id}`,
    `正文 ${d.textLength || 0} 字 · 标题 ${(d.headings || []).length} 个 · 链接 ${(d.links || []).length} 条 · 表单 ${(d.forms || []).length} 个`,
    `文件：${file}`,
    '拿去和另一个快照比：{action:"diff", a:"<idA>", b:"<idB>"}',
  ]
  return {
    ok: true, action: 'snapshot', ms: Date.now() - started, tab: d.tab,
    message: lines.join('\n'),
    detail: { id, file, url: d.url, title: d.title, textLength: d.textLength, headings: d.headings?.length, links: d.links?.length, forms: d.forms?.length },
  }
}

async function loadSnapshot(root, id) {
  const clean = String(id || '').replace(/[^\w-]/g, '')
  if (!clean) return null
  try {
    const text = await readFile(path.join(snapshotsDir(root), `${clean}.json`), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function diffSnapshots(bridge, params, started, root) {
  if (!params.a || !params.b) return { ok: false, action: 'diff', ms: Date.now() - started, message: '【chrome:diff】需要 a 和 b 两个快照 id（先 action=snapshot 生成）' }
  const a = await loadSnapshot(root, params.a)
  const b = await loadSnapshot(root, params.b)
  if (!a) return { ok: false, action: 'diff', ms: Date.now() - started, message: `【chrome:diff】找不到快照 ${params.a}` }
  if (!b) return { ok: false, action: 'diff', ms: Date.now() - started, message: `【chrome:diff】找不到快照 ${params.b}` }
  const setOf = (rows, key) => new Set((rows || []).map((r) => r && r[key]).filter(Boolean))
  const headingsA = setOf(a.headings, 'text')
  const headingsB = setOf(b.headings, 'text')
  const linksA = setOf(a.links, 'href')
  const linksB = setOf(b.links, 'href')
  const addedHeadings = [...headingsB].filter((x) => !headingsA.has(x)).slice(0, 30)
  const removedHeadings = [...headingsA].filter((x) => !headingsB.has(x)).slice(0, 30)
  const addedLinks = [...linksB].filter((x) => !linksA.has(x)).slice(0, 30)
  const removedLinks = [...linksA].filter((x) => !linksB.has(x)).slice(0, 30)
  const textDelta = (b.textLength || 0) - (a.textLength || 0)
  const same = a.title === b.title && a.url === b.url && textDelta === 0 && !addedHeadings.length && !removedHeadings.length && !addedLinks.length && !removedLinks.length
  const lines = [
    `【chrome:diff】${same ? '两个快照一致' : '有差异'}`,
    `A：${a.title || ''} · ${a.url || ''} · 正文 ${a.textLength || 0} 字`,
    `B：${b.title || ''} · ${b.url || ''} · 正文 ${b.textLength || 0} 字`,
    `正文变化：${textDelta >= 0 ? '+' : ''}${textDelta} 字`,
  ]
  if (addedHeadings.length) lines.push('新增标题：', ...addedHeadings.map((t) => '  + ' + clip(t, 80)))
  if (removedHeadings.length) lines.push('消失标题：', ...removedHeadings.map((t) => '  - ' + clip(t, 80)))
  if (addedLinks.length) lines.push('新增链接：', ...addedLinks.map((h) => '  + ' + clip(h, 100)))
  if (removedLinks.length) lines.push('消失链接：', ...removedLinks.map((h) => '  - ' + clip(h, 100)))
  return {
    ok: true, action: 'diff', ms: Date.now() - started,
    message: lines.join('\n'),
    detail: { same, textDelta, addedHeadings, removedHeadings, addedLinks, removedLinks, a: { title: a.title, url: a.url }, b: { title: b.title, url: b.url } },
  }
}

/* ----------------------------- 截图 ----------------------------- */

async function screenshot(bridge, params, started, root) {
  const r = await bridge.call('screenshot', {
    ...tabLoc(params),
    selector: params.selector, clip: params.clip, scale: params.scale,
    fullPage: params.fullPage, format: params.format, quality: params.quality,
  }, { timeoutMs: params.fullPage ? 45000 : 25000 })
  const d = r || {}
  if (!r.ok) return fail('screenshot', r, started)
  if (!d.dataUrl) return { ok: false, action: 'screenshot', ms: Date.now() - started, message: '【chrome:screenshot】扩展没返回图片' }
  const base64 = String(d.dataUrl).split(',')[1] || ''
  // 图片格式跟着扩展回来的 dataUrl 走：jpeg 别硬写成 .png
  const mime = (String(d.dataUrl).match(/^data:image\/([a-z0-9]+)/i) || [])[1] || 'png'
  const ext = mime === 'jpeg' ? 'jpg' : mime
  let file = ''
  if (params.saveTo) {
    // 1.16.0：saveTo 以前在 screenshot 上被静默忽略（schema 里有、代码没接），
    // 传了路径还是落 shots/ 目录。现在与 pdf/mhtml 一致：给路径就按路径写。
    const target = resolveSavePath(root, params.saveTo, `shot-${Date.now().toString(36)}.${ext}`, ext)
    await ensureDir(target.dir)
    file = target.file
  } else {
    const dir = path.join(chromeHome(root), 'shots')
    await mkdir(dir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${d.tab?.id ?? 'tab'}${d.width ? `-${d.width}x${d.height}` : ''}.${ext}`
    file = path.join(dir, name)
  }
  await writeFile(file, Buffer.from(base64, 'base64'))
  const kb = Math.round(base64.length * 0.75 / 1024)
  const pageNote = d.fullPage ? '（整页 · CDP captureBeyondViewport）' : (params.fullPage ? '（整页截图超时，退回视口截图）' : '')
  const viaNote = d.via === 'captureVisibleTab' ? '（CDP 不可用，走的旧截图链路）' : ''
  const cropNote = d.crop?.clip ? `（裁剪 ${d.crop.clip.width}x${d.crop.clip.height}${d.crop.scale && d.crop.scale < 1 ? `，缩放 ${d.crop.scale}` : ''}）` : ''
  const selNote = d.crop?.selectorFailed ? `（selector 没量到位置，截的是整屏）` : ''
  return {
    ok: true, action: 'screenshot', ms: Date.now() - started, tab: d.tab,
    message: `【chrome:screenshot】已截图${pageNote}${viaNote}${cropNote}${selNote}：${pageHeader(d)}\n文件：${file}\n大小：${kb} KB`,
    detail: { file, bytes: Math.round(base64.length * 0.75), width: d.width, height: d.height, crop: d.crop, via: d.via, tab: d.tab },
  }
}

/* ----------------------------- 登录 ----------------------------- */

async function login(bridge, params, started, root, opts) {
  const sites = await readSites(root)
  const found = params.site ? findSite(sites, params.site) : null
  const site = found?.site || {}
  const url = params.url || site.url
  const username = params.username ?? site.username
  const password = params.password ?? site.password
  const userSelector = params.userSelector || site.userSelector
  const passSelector = params.passSelector || site.passSelector
  const submitSelector = params.submitSelector || site.submitSelector
  const successSelector = params.successSelector || site.successSelector
  const successUrl = params.successUrl || site.successUrl || site.expectUrl || params.expectUrl
  const successText = params.successText || site.successText
  const steps = []

  let tab = null
  if (url) {
    const nav = await bridge.call('navigate', {
      tabId: params.tabId, urlContains: params.urlContains,
      url, expectUrl: successUrl, timeoutMs: params.timeoutMs,
    }, { timeoutMs: params.timeoutMs || 40000 })
    if (!nav.ok) return fail('login', nav, started)
    tab = nav.tab
    steps.push(`导航到 ${url}${nav.loaded ? '（已加载）' : '（没等到加载完成）'}`)
  }

  const detect = await bridge.call('detectLogin', {
    tabId: tab?.id, urlContains: tab ? undefined : params.urlContains,
  }, { timeoutMs: 15000 })
  if (!detect.ok) return fail('login', detect, started)
  const info = detect || {}
  tab = info.tab || tab
  steps.push(`页面：${info.title || ''} · ${info.url || ''}`)
  steps.push(`检测：${info.hasPassword ? '有密码框（未登录）' : '没有密码框'}，像登录页=${info.looksLikeLogin ? '是' : '否'}`)

  // 已登录判断：配了成功条件就以成功条件为准；没配才用「没有密码框、不像登录页」这条弱判断
  const probeSuccess = async () => {
    if (successSelector) {
      const p = await bridge.call('wait', { tabId: tab?.id, selector: successSelector, timeoutMs: 2500 }, { timeoutMs: 8000 }).catch(() => null)
      return p && p.ok ? 'selector' : null
    }
    if (successUrl && info.url && String(info.url).includes(successUrl)) return 'url'
    if (successText) {
      const p = await bridge.call('wait', { tabId: tab?.id, text: successText, timeoutMs: 2500 }, { timeoutMs: 8000 }).catch(() => null)
      return p && p.ok ? 'text' : null
    }
    if (!info.hasPassword && !info.looksLikeLogin) return 'heuristic'
    return null
  }
  const already = await probeSuccess()
  if (already) {
    return {
      ok: true, action: 'login', ms: Date.now() - started, tab,
      message: `【chrome:login】已经登录（依据：${already === 'heuristic' ? '没有密码框且不像登录页' : already}）。\n${steps.join('\n')}\n${pageHeader(info)}`,
      detail: { alreadyLoggedIn: true, verifiedBy: already, steps, tab: info.tab },
    }
  }

  if (!username || !password) {
    return {
      ok: false, action: 'login', ms: Date.now() - started, tab,
      message: `【chrome:login】这个站要登录，但没拿到账号密码。\n${steps.join('\n')}\n把账号密码存进 ~/.dsh/chrome/sites.json（或直接传 username/password 参数），再试一次。`,
      detail: { needCredentials: true, steps, tab: info.tab },
    }
  }

  if (params.dryRun) {
    const how = successSelector ? `成功标记 ${successSelector}` : successUrl ? `URL 包含 ${successUrl}` : successText ? `文字「${successText}」` : '密码框消失'
    return {
      ok: true, action: 'login', ms: Date.now() - started, tab,
      message: `【chrome:login·预览】准备用账号 ${username} 登录，提交后按「${how}」判断结果。\n没有真的填。确认后去掉 dryRun 再调一次。\n${steps.join('\n')}`,
      detail: { dryRun: true, wouldSubmit: true, steps, tab: info.tab },
    }
  }

  const fill = await bridge.call('fillLogin', {
    tabId: tab?.id, username, password, userSelector, passSelector, submitSelector,
    submit: true, expectUrl: successUrl, successSelector, timeoutMs: params.timeoutMs,
  }, { timeoutMs: params.timeoutMs || 45000 })
  if (!fill.ok) return fail('login', fill, started)
  const fd = fill || {}
  steps.push(`填表：账号=${fd.userField ? (fd.userField.name || fd.userField.id || '已识别') : '未识别'}，密码=${fd.passField ? '已填' : '未识别'}`)
  steps.push(`提交方式：${fd.submitted || '无'}（账号 ${username}，密码已脱敏）`)

  const after = await bridge.call('read', { tabId: fd.tab?.id, maxChars: 1500 }, { timeoutMs: 15000 }).catch(() => null)
  const stillHasPassword = after?.inputs?.some((i) => i.type === 'password')
  const pageText = String(after?.text || '')
  const errorHint = /验证码|验证失败|密码错误|账号或密码|登录失败|invalid|incorrect|failed|try again/i.test(pageText) ? pageText.slice(0, 200) : ''

  // 提交后验证：成功条件优先，其次错误提示，最后才是密码框
  let verifiedBy = null
  const successTimeout = Number(params.successTimeoutMs) || 8000
  if (successSelector) {
    const w = await bridge.call('wait', { tabId: fd.tab?.id, selector: successSelector, timeoutMs: successTimeout }, { timeoutMs: successTimeout + 5000 }).catch(() => null)
    if (w && w.ok) verifiedBy = 'selector'
  } else if (successUrl && after?.url && String(after.url).includes(successUrl)) {
    verifiedBy = 'url'
  } else if (successText) {
    const w = await bridge.call('wait', { tabId: fd.tab?.id, text: successText, timeoutMs: successTimeout }, { timeoutMs: successTimeout + 5000 }).catch(() => null)
    if (w && w.ok) verifiedBy = 'text'
  } else if (!stillHasPassword) {
    verifiedBy = 'password-gone'
  }

  steps.push(`提交后：${after?.title || ''} · ${after?.url || ''}${stillHasPassword ? '（还有密码框）' : ''}`)
  if (errorHint) steps.push(`页面提示：${clip(errorHint, 160)}`)

  if (!verifiedBy) {
    return {
      ok: false, action: 'login', ms: Date.now() - started, tab: fd.tab,
      message: `【chrome:login】登录结果不确定：没有命中成功条件${stillHasPassword ? '，页面仍有密码框' : ''}${errorHint ? '，页面有错误提示' : ''}。\n${steps.join('\n')}\n可能需要验证码/二次验证，或账号密码不对。`,
      detail: { status: 'uncertain', steps, stillHasPassword, errorHint, tab: fd.tab, username },
    }
  }

  return {
    ok: true, action: 'login', ms: Date.now() - started, tab: fd.tab,
    message: `【chrome:login】登录成功（依据：${verifiedBy}）\n${steps.join('\n')}`,
    detail: { status: 'logged-in', verifiedBy, steps, filled: fd.filled, submitted: fd.submitted, stillHasPassword, tab: fd.tab, username },
  }
}

/* ----------------------------- 多页流程 ----------------------------- */

function resolveVarPath(vars, pathText) {
  return String(pathText).split('.').reduce((obj, key) => (obj == null ? obj : obj[key]), vars)
}

function applyVars(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, key) => {
      const v = resolveVarPath(vars, key)
      if (v == null) return ''
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => applyVars(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = applyVars(v, vars)
    return out
  }
  return value
}

function evalWhen(when, vars) {
  if (!when) return true
  if (when.checked !== undefined) {
    const v = resolveVarPath(vars, when.checked)
    return Boolean(v) === Boolean(when.checked === true ? true : when.checked)
  }
  const val = resolveVarPath(vars, when.var)
  if (when.exists !== undefined) return (val != null) === Boolean(when.exists)
  if (when.equals !== undefined) return String(val) === String(when.equals)
  if (when.notEquals !== undefined) return String(val) !== String(when.notEquals)
  if (when.includes !== undefined) return String(val ?? '').includes(String(when.includes))
  if (when.notIncludes !== undefined) return !String(val ?? '').includes(String(when.notIncludes))
  return true
}

/**
 * 跑一串步骤。
 * quiet:true 只输出失败步骤 + 汇总（长流程必开，不然 91 个元素光复读就几万 token）。
 * repeat 步骤：{action:'repeat', items:[...], steps:[...]}，内层用 {{item}} 引用。
 */
async function flow(bridge, params, started, root, opts) {
  let steps = params.steps
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps) } catch (e) { return { ok: false, action: 'flow', ms: Date.now() - started, message: '【chrome:flow】steps 不是合法 JSON：' + e.message } }
  }
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, action: 'flow', ms: Date.now() - started, message: '【chrome:flow】需要 steps 数组' }

  const stopOnError = params.stopOnError !== false
  const quiet = params.quiet === true || params.report === 'failures'
  const vars = { ...(params.vars || {}) }
  const results = []
  let inherit = { tabId: params.tabId, urlContains: params.urlContains }
  const lines = [`【chrome:flow】${steps.length} 个顶层步骤（失败${stopOnError ? '即停' : '继续'}${quiet ? '，静默模式' : ''}）`]
  let stopped = false

  const runOne = async (raw, depth, labelPrefix) => {
    const stepAction = String(raw.action || '').trim()
    const step = { ...raw }
    delete step.action
    if (!stepAction) {
      results.push({ index: labelPrefix, action: '(空)', ok: false, message: '这一步没有 action' })
      lines.push(`${labelPrefix} ✗ 缺少 action`)
      return { ok: false }
    }
    if (step.when) {
      const cond = step.when
      delete step.when
      if (!evalWhen(cond, vars)) {
        results.push({ index: labelPrefix, action: stepAction, ok: true, skipped: true, ms: 0 })
        if (!quiet) lines.push(`${labelPrefix} ↷ ${stepAction}（when 不满足，跳过）`)
        return { ok: true, skipped: true }
      }
    }
    const saveAs = step.saveAs
    delete step.saveAs
    const onError = String(step.onError || (stopOnError ? 'stop' : 'continue'))
    delete step.onError
    const resolved = applyVars(step, vars)
    // flow 里每一步的「页面变化」没人看，只会白扫一遍页面
    resolved.noDelta = true
    if (resolved.tabId == null && resolved.urlContains == null && resolved.index == null) {
      if (inherit.tabId != null) resolved.tabId = inherit.tabId
      else if (inherit.urlContains) resolved.urlContains = inherit.urlContains
    }
    const r = await performAction(bridge, stepAction, resolved, { root, ...opts })
    if (saveAs) vars[saveAs] = r.detail ?? (r.ok ? r.message : null)
    results.push({ index: labelPrefix, action: stepAction, ok: r.ok, ms: r.ms, errorCode: r.detail?.errorCode, tab: r.tab })
    if (r.tab?.id != null) inherit = { tabId: r.tab.id }

    const head = `${labelPrefix} ${r.ok ? '✓' : '✗'} ${stepAction} ${r.tab ? `[#${r.tab.id}]` : ''} ${r.ms}ms${saveAs ? ` → ${saveAs}` : ''}`
    if (!quiet || !r.ok) {
      lines.push(head)
      if (r.message) {
        // 成功步骤只留前两行（标题 + 关键结果）；失败的全留，最多 8 行
        const maxLines = r.ok ? 2 : 8
        const body = r.message.split('\n').slice(0, maxLines).join('\n      ')
        lines.push('      ' + body)
      }
    } else if (r.message && /提取|isChecked|value|read/.test(stepAction)) {
      // 静默模式也保留「验收依据」：提取/盘点结果的第一行
      lines.push(head + ' · ' + clip(r.message.split('\n').find((x) => /提取|选中|共|结果/.test(x)) || '', 120))
    }
    if (!r.ok && onError !== 'continue') stopped = true
    return r
  }

  const runList = async (list, depth, prefix) => {
    for (let i = 0; i < list.length; i++) {
      if (stopped) return
      const raw = list[i] || {}
      const label = prefix ? `${prefix}.${i + 1}` : String(i + 1)
      if (String(raw.action || '').toLowerCase() === 'repeat') {
        const items = Array.isArray(raw.items) ? raw.items : []
        const innerSteps = Array.isArray(raw.steps) ? raw.steps : []
        if (!items.length || !innerSteps.length) {
          lines.push(`${label} ✗ repeat 需要 items 和 steps`)
          results.push({ index: label, action: 'repeat', ok: false })
          continue
        }
        const onEmpty = String(raw.onEmpty || 'skip')
        lines.push(`${label} ⟳ repeat ${items.length} 项 × ${innerSteps.length} 步${raw.label ? '（' + raw.label + '）' : ''}`)
        let failed = 0
        for (let k = 0; k < items.length; k++) {
          if (stopped) break
          vars.item = items[k]
          vars.index = k
          for (let j = 0; j < innerSteps.length; j++) {
            if (stopped) break
            const r = await runOne(innerSteps[j], depth + 1, `${label}.${k + 1}.${j + 1}`)
            if (!r || !r.ok) failed++
          }
        }
        results.push({ index: label, action: 'repeat', ok: failed === 0, items: items.length, failed, container: true })
        if (failed && onEmpty === 'stop') stopped = true
        continue
      }
      if (stopped) return
      await runOne(raw, depth, label)
    }
  }

  await runList(steps, 0, '')
  // repeat 自己那条只是"容器"记录，统计步数时别把它算进去（不然 3 项 1 步会显示成 4/4）
  const counted = results.filter((r) => !r.container)
  const okCount = counted.filter((r) => r.ok).length
  const failedSteps = counted.filter((r) => !r.ok)
  lines.push('', `汇总：${okCount}/${counted.length} 步成功${failedSteps.length ? `，失败 ${failedSteps.length} 步` : ''}${stopped ? '（提前停止）' : ''}`)
  if (failedSteps.length && quiet) {
    for (const f of failedSteps.slice(0, 10)) {
      lines.push(`  失败 ${f.index} ${f.action}${f.errorCode ? ' [' + f.errorCode + ']' : ''} ${hintOf(f.errorCode)}`)
    }
  }
  return {
    ok: failedSteps.length === 0,
    action: 'flow', ms: Date.now() - started, tab: results.at(-1)?.tab,
    message: lines.join('\n'),
    detail: {
      okCount, total: counted.length, stopped,
      steps: results.map((r) => ({ index: r.index, action: r.action, ok: r.ok, ms: r.ms, skipped: r.skipped, errorCode: r.errorCode, items: r.items, failed: r.failed })),
      vars,
    },
  }
}

/* ----------------------------- 站点凭据 ----------------------------- */

/** cookies：只报名字/域/过期时间，默认不回值（值是凭据，别往聊天里搬）。 */
async function cookiesAction(bridge, params, started) {
  const r = await bridge.call('cookies', {
    ...tabLoc(params),
    url: params.url, showValues: params.showValues === true,
  }, { timeoutMs: 15000 })
  const d = r || {}
  if (!r.ok) return fail('cookies', r, started)
  const rows = d.cookies || []
  const shown = Math.max(1, Math.min(200, Number(params.limit) || 40))
  const lines = [`【chrome:cookies】${pageHeader(d)}`, `${d.url} 上 ${d.count ?? rows.length} 颗 cookie`]
  for (const c of rows.slice(0, shown)) {
    const bits = [c.name, '@' + c.domain + (c.path || '')]
    if (c.httpOnly) bits.push('httpOnly')
    if (c.secure) bits.push('secure')
    if (c.expirationDate) bits.push('到期 ' + new Date(c.expirationDate * 1000).toISOString().slice(0, 10))
    if (c.value != null) bits.push('值=' + clip(c.value, 60))
    lines.push('· ' + bits.join(' '))
  }
  if (rows.length > shown) lines.push(`（只列前 ${shown} 颗，共 ${rows.length} 颗；showValues:true 才会回值）`)
  return { ok: true, action: 'cookies', ms: Date.now() - started, tab: d.tab, message: lines.join('\n'), detail: { url: d.url, count: d.count, cookies: rows.map((c) => ({ ...c, value: c.value == null ? undefined : '***' })) } }
}

async function sitesAction(params, started, root) {
  const op = String(params.op || 'list').toLowerCase()
  const sites = await readSites(root)
  if (op === 'list') {
    const keys = Object.keys(sites)
    const lines = [`【chrome:sites】已存 ${keys.length} 个站点`]
    for (const key of keys) {
      const s = sites[key]
      lines.push(`· ${key} → ${s.url || ''} · 账号 ${s.username || '(未存)'} · 密码 ${s.password ? '已存' : '(未存)'}`)
    }
    if (!keys.length) lines.push('（空。用 action=sites&op=add&key=站点名&url=...&username=...&password=... 添加）')
    return { ok: true, action: 'sites', ms: Date.now() - started, message: lines.join('\n'), detail: { op, keys } }
  }
  if (op === 'add' || op === 'set') {
    const key = String(params.key || '').trim().toLowerCase()
    if (!key) return { ok: false, action: 'sites', ms: Date.now() - started, message: '【chrome:sites】add 需要 key（域名或自定义名）' }
    sites[key] = {
      url: params.url || sites[key]?.url || '',
      username: params.username ?? sites[key]?.username ?? '',
      password: params.password ?? sites[key]?.password ?? '',
      userSelector: params.userSelector || sites[key]?.userSelector || '',
      passSelector: params.passSelector || sites[key]?.passSelector || '',
      submitSelector: params.submitSelector || sites[key]?.submitSelector || '',
      successSelector: params.successSelector || sites[key]?.successSelector || '',
      successUrl: params.successUrl || sites[key]?.successUrl || '',
      successText: params.successText || sites[key]?.successText || '',
      expectUrl: params.expectUrl || sites[key]?.expectUrl || '',
    }
    const file = await writeSites(root, sites)
    return { ok: true, action: 'sites', ms: Date.now() - started, message: `【chrome:sites】已保存站点 ${key} → ${file}`, detail: { op, key, file } }
  }
  if (op === 'remove' || op === 'del') {
    const key = String(params.key || '').trim().toLowerCase()
    if (!sites[key]) return { ok: false, action: 'sites', ms: Date.now() - started, message: `【chrome:sites】没有这个站点：${key}` }
    delete sites[key]
    const file = await writeSites(root, sites)
    return { ok: true, action: 'sites', ms: Date.now() - started, message: `【chrome:sites】已删除 ${key}（${file}）`, detail: { op, key, file } }
  }
  return { ok: false, action: 'sites', ms: Date.now() - started, message: `【chrome:sites】不支持的 op：${op}（list/add/remove）` }
}

/* ----------------------------- 操作日志 ----------------------------- */

async function logAction(params, started, root) {
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 10))
  const fetchN = params.actionFilter || params.ok === false ? limit * 5 : limit
  const rows = await recent(root, fetchN)
  const filtered = rows.filter((r) => {
    if (params.actionFilter && r.action !== params.actionFilter) return false
    if (params.ok !== undefined && Boolean(r.ok) !== Boolean(params.ok)) return false
    return true
  }).slice(-limit)
  const lines = [`【chrome:log】最近 ${filtered.length} 条${params.actionFilter ? '（action=' + params.actionFilter + '）' : ''}${params.ok !== undefined ? '（ok=' + params.ok + '）' : ''}`]
  for (const r of filtered) {
    const code = r.detail?.errorCode ? ` [${r.detail.errorCode}]` : ''
    lines.push(`${r.ts} ${r.ok ? '✓' : '✗'} ${r.action} ${r.ms ?? '?'}ms${r.tab ? ' · ' + clip(r.tab.title || r.tab.url || '', 40) : ''}${code}${r.detail?.error ? ' · ' + clip(r.detail.error, 160) : ''}`)
  }
  if (!filtered.length) lines.push('（没有符合条件的记录）')
  return { ok: true, action: 'log', ms: Date.now() - started, message: lines.join('\n'), detail: { rows: filtered } }
}

/* ------------------------------------------------------------------ */

function fail(action, r, started) {
  const err = r.error || '扩展执行失败'
  const code = r.errorCode || ''
  const hint = hintOf(code)
  const tried = r.triedMain || r.triedIsolated
    ? `\n另试：页面世界 ${r.triedMain?.errorCode || '-'} / 扩展世界 ${r.triedIsolated?.errorCode || '-'}`
    : ''
  const fallback = r.fellBackTo ? `\n（已自动从扩展世界退到 ${r.fellBackTo} 世界执行）` : ''
  return {
    ok: false, action, ms: Date.now() - started,
    message: `【chrome:${action}】失败${code ? ` [${code}]` : ''}：${err}${fallback}${tried}${hint ? `\n→ ${hint}` : ''}`,
    detail: { error: err, errorCode: code, hint, extra: r },
  }
}
