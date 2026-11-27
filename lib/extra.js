/**
 * extra.js —— 挂在 CDP 通道上的那批动作（插件侧）。
 *
 * 一条通道换来的能力都放这儿，别往 actions.js 里堆：
 *   press / dialog / logs / networkLog / networkClear / pdf / mhtml /
 *   upload / drag / emulate / metrics / cdp（透传）/ detach
 *
 * 约定和 actions.js 一样：返回 { ok, action, ms, tab, detail, message }，
 * 失败别自己吞——抛出去由 performAction 统一带上错误码和下一步建议。
 */

import { writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { chromeHome } from './log.js'
import { viaTag } from './tabnote.js'
import { resolveSavePath, ensureDir } from './save.js'
import { fileNameFromUrl, shapeOf, stemFromBody } from './fetchplan.js'

const clip = (text, n) => {
  const s = String(text == null ? '' : text)
  return s.length > n ? s.slice(0, n - 1) + `…（共 ${s.length} 字）` : s
}

const tabLine = (tab, data) => (tab ? `标签 #${tab.id}《${clip(tab.title || '(无标题)', 50)}》${viaTag(data || {})}` : '标签（未知）')

// 1.19.0：带毫秒。同一秒里连点两次提交时，只到秒的时间戳分不清先后。
const timeOf = (ts) => {
  const d = new Date(ts || Date.now())
  return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/**
 * 401 的下一步（1.13.0）。
 * 2026-11-23 实测：同源 GET /api/v1/... 连吃 5 个 openresty 401，最后靠翻前端 bundle
 * 才发现平台要 `authorization: <tokenType> <token>`，token 在 localStorage 里。
 * 模型看到 401 只会反复重试同一条请求，所以这里必须把「去哪儿看」写死。
 */
export const AUTH_HINT = '401 = 网关鉴权失败（不是接口不存在）。页面自己的请求一般带 authorization 或 '
  + 'X-Function-Code 这类头：先 networkLog 找到同名接口，再 networkDetail 看它的请求头照抄；'
  + 'token 通常在 localStorage 的 *_token 里（值不要贴到对话里）。'
  + '也可以给 fetch 传 authFrom（如 {"key":"m5_token"}），它会自己从页面 localStorage 取令牌并加头，不用再写 eval。'
  + 'replay 同样接受 authFrom（从探针行重放时 Authorization 已被脱敏，必须补，否则必 401）。'
  + '注意：后台接口经常只接受 POST，GET 会被网关直接 401。'

/**
 * authFrom：从页面 localStorage 取令牌，合并进 headers。fetch 与 replay 共用。
 *
 * 为什么要抽出来（2026-11-27）：1.20.0 的文档先写了「replay 也支持 authFrom」，
 * 但其实只有 fetch 实现了；实测时又恰好因为重放命中 CDP 抓到的原请求（自带
 * authorization）而返回 200，把「没实现」藏了过去。探针行的 Authorization 是脱敏的，
 * 只有真合并进 headers 才能救回来。
 *
 * @returns {Promise<{headers?:object, note?:string, missing?:string}>} missing=取不到令牌的键名
 */
async function resolveAuthFrom(call, params, tabLoc) {
  if (!params.authFrom) return { headers: params.headers, note: '' }
  const spec = typeof params.authFrom === 'string' ? { key: params.authFrom } : (params.authFrom || {})
  const key = String(spec.key || 'm5_token')
  const typeKey = String(spec.typeKey || (key + 'Type'))
  const header = String(spec.header || 'authorization')
  const expr = '(function(){try{return JSON.stringify({t:localStorage.getItem(' + JSON.stringify(key)
    + '),ty:localStorage.getItem(' + JSON.stringify(typeKey) + ')})}catch(e){return \'{}\'}})()'
  const g = await call('eval', { ...tabLoc, code: expr, frame: params.frame }, 20000).catch(() => null)
  let token = ''
  let tokenType = ''
  try {
    const o = JSON.parse((g && g.value) || '{}')
    token = o.t || ''
    tokenType = o.ty || ''
  } catch { /* 取不到就由调用方报错 */ }
  if (!token) return { missing: key }
  return {
    headers: {
      ...(params.headers || {}),
      [header]: spec.raw === true ? token : `${tokenType || 'Bearer'} ${token}`,
    },
    note: `已按 authFrom 从 localStorage["${key}"] 取令牌，加到 ${header} 头（值不回显）`,
  }
}

/**
 * 响应体截断说明（1.20.2）：`bodyTruncated` 有两个来源——2MB 硬上限，以及回执预览的
 * maxChars。以前两处一律写「超过 2MB 已截断」，15KB 的响应也这么显示（2026-11-27 实测）。
 */
function bodyBrief(r, shown) {
  const len = Number(r && r.bodyLength) || 0
  if (len > 2 * 1024 * 1024) return '超过 2MB 已截断'
  return `回执只给前 ${shown} 字（要全文：saveTo 落盘或 maxChars:0）`
}

/**
 * 把挖出来的一小段压缩代码折成能读的样子：语句边界换行 + 超长行硬折。
 * 只用于回执展示，不改原文（原文还在页面里）。
 */
function prettyCode(text, width = 110) {
  let s = String(text == null ? '' : text)
  s = s.replace(/;(?=(?:case\s|var\s|let\s|const\s|return\s|this\.|if\s*\(|function\s|switch\s*\(|while\s*\(|try\s*\{|console\.|Promise\.))/g, ';\n')
  s = s.replace(/(case\s+\d+:)/g, '\n$1')
  return s.split('\n').map((line) => {
    if (line.length <= width) return line
    const chunks = []
    for (let i = 0; i < line.length; i += width) chunks.push(line.slice(i, i + width))
    return chunks.join('\n')
  }).join('\n')
}

/**
 * 页面里跑：在「所有已加载的脚本」里搜字符串。
 *
 * 为什么要它：SPA 排错十次有八次要回到源码——「这个按钮点了走哪段逻辑」，
 * 源码在 webpack 的懒加载 chunk 里，DOM 上只剩一排 <script src>，靠手工 fetch 一个个捞太慢。
 * 必须用 performance 的 resource 列表，光看 document 里的 script 会漏掉懒加载 chunk。
 *
 * 注意：这是要被 toString() 塞进页面的函数，只能用它自己的参数，不许引用外部变量。
 */
const sourceSearchPageFn = async (opt) => {
  const list = []
  const seen = new Set()
  const add = (u) => {
    if (!u) return
    let s = String(u)
    // 1.19.0：支持显式传路径（/eam/js/x.js）——懒加载模块/importmap 的代码
    // 常常不在 script[src] 里，光靠自动收集会漏（2026-11-26 搜接口路径 0 命中）。
    if (!/^https?:/i.test(s)) {
      try { s = new URL(s, location.href).href } catch { return }
    }
    if (seen.has(s)) return
    if (!/\.js(\?|#|$)/i.test(s)) return
    seen.add(s)
    list.push(s)
  }
  ;(Array.isArray(opt.scripts) ? opt.scripts : []).forEach(add)
  try { Array.prototype.forEach.call(document.querySelectorAll('script[src]'), (s) => add(s.src)) } catch (e) { /* 没有就算了 */ }
  try {
    performance.getEntriesByType('resource').forEach((e) => { if (/\.js(\?|#|$)/i.test(e.name)) add(e.name) })
  } catch (e) { /* 老浏览器没有 */ }

  const matches = []
  const failed = []
  const scannedFiles = []
  let scanned = 0
  let hits = 0
  const maxFiles = Math.max(1, Math.min(80, opt.maxFiles || 40))
  const perFile = Math.max(1, Math.min(50, opt.perFile || 5))
  const maxMatches = Math.max(1, Math.min(200, opt.maxMatches || 40))
  const ctxLen = Math.max(60, Math.min(3000, opt.ctx || 400))

  for (const url of list.slice(0, maxFiles)) {
    if (matches.length >= maxMatches) break
    let text = ''
    try {
      const res = await fetch(url, { credentials: 'include' })
      if (!res || !res.ok) { failed.push(url + ' (' + (res && res.status) + ')'); continue }
      text = await res.text()
    } catch (e) {
      failed.push(url + ' (' + String((e && e.message) || e) + ')')
      continue
    }
    scanned++
    scannedFiles.push(url)
    const idx = []
    if (opt.regex) {
      let re
      try { re = new RegExp(opt.needle, opt.caseSensitive ? 'g' : 'gi') } catch (e) { return { error: '正则无效：' + String((e && e.message) || e) } }
      let m
      while ((m = re.exec(text)) && idx.length < perFile) {
        idx.push(m.index)
        if (m[0] === '') re.lastIndex++
      }
    } else {
      const hay = opt.caseSensitive ? text : text.toLowerCase()
      const nd = opt.caseSensitive ? String(opt.needle) : String(opt.needle).toLowerCase()
      let i = -1
      while ((i = hay.indexOf(nd, i + 1)) >= 0 && idx.length < perFile) idx.push(i)
    }
    hits += idx.length
    for (const at of idx) {
      matches.push({
        file: url,
        at,
        size: text.length,
        ctx: text.slice(Math.max(0, at - ctxLen), Math.min(text.length, at + ctxLen)),
      })
    }
  }
  // 只回「真正抓到并扫过」的，不回候选池：以前列 80 个候选，容易让人以为都扫了。
  return { scripts: list.length, scanned, hits, matches, failed: failed.slice(0, 10), scannedList: scannedFiles.slice(0, 80) }
}

/**
 * 页面里跑：从某个元素往上找 Vue 组件，回名字/方法/data 键/pick。
 *
 * Vue2 用 el.__vue__，Vue3（Element Plus 那套）用 el.__vueParentComponent。
 * 组件树只走「组件子节点」并限深限量——裸递归 vnode 会指数爆炸，把主线程占死（1.11.1 踩过）。
 */
const vueInspectPageFn = async (opt) => {
  const clean = (v) => String(v == null ? '' : v).replace(/["\\\s]/g, '')
  let el = null
  if (opt.ref) el = document.querySelector('[data-dsh-ref="' + clean(opt.ref) + '"]')
  if (!el && opt.selector) {
    const all = Array.prototype.slice.call(document.querySelectorAll(opt.selector))
    el = all.filter((e) => e.offsetParent || e.getClientRects().length)[0] || all[0] || null
  }
  if (!el) el = document.querySelector('#app') || document.body
  if (!el) return { found: false, note: '页面里连 body 都没有' }

  let node = el
  let hit = null
  while (node) {
    if (node.__vueParentComponent) { hit = { version: 3, inst: node.__vueParentComponent }; break }
    if (node.__vue__) { hit = { version: 2, inst: node.__vue__ }; break }
    node = node.parentElement
  }
  // 1.16.0 补充：Vue 3 生产构建的页面常常只有容器上的 __vue_app__，子节点没有
  // __vueParentComponent（Element Plus 页面实测）。退回 app._instance / container._vnode.component。
  if (!hit) {
    let host = el
    while (host && !host.__vue_app__) host = host.parentElement
    const app = host && host.__vue_app__
    const root = app && (app._instance || (app._container && app._container._vnode && app._container._vnode.component))
    if (root) hit = { version: 3, inst: root, fromApp: true }
  }
  if (!hit) return { found: false, note: '这个节点往上没有 Vue 实例（页面不是 Vue，或 ref 指向了组件之外的节点）' }

  let inst = hit.inst
  const nameOf = (i, v) => {
    const t = (v === 2 ? (i && i.$options) : (i && i.type)) || {}
    return t.name || t.__name || t._componentTag || (t.__file ? String(t.__file).split(/[\\/]/).pop() : '') || '(匿名)'
  }
  // 递归收集组件实例：只沿「组件 vnode → subTree」和 vnode.children 走，
  // 用 seen 去重（组件 vnode 会同时出现在 children / dynamicChildren 里）。
  const collectComponents = (rootInst, maxNodes, maxDepth) => {
    const out = []
    const seen = new Set()
    const limit = maxNodes || 800
    const cap = maxDepth || 40
    const pushV = (v, d) => {
      if (!v || typeof v !== 'object' || seen.has(v) || d > cap || out.length >= limit) return
      seen.add(v)
      if (v.component) {
        out.push({ inst: v.component, depth: d })
        pushV(v.component.subTree, d + 1)
      }
      if (Array.isArray(v.children)) {
        for (const c of v.children) pushV(c, v.component ? d + 1 : d)
      }
    }
    if (rootInst) pushV(rootInst.subTree, 1)
    return out
  }
  // 按组件名定位（可选）：弹窗组件往往在树的深处，必须能指名道姓地调它的方法。
  if (opt.name) {
    const want = String(opt.name).toLowerCase()
    const found = collectComponents(inst, 800, 40).find((c) => String(nameOf(c.inst, hit.version)).toLowerCase() === want)
    if (found) inst = found.inst
  }
  const dataOf = (i, v) => {
    if (v === 2) return (i && i.$data) || {}
    const p = i && (i.proxy || i.ctx)
    return (p && p.$data) || (i && i.setupState) || {}
  }
  const methodsOf = (i, v) => {
    if (v === 2) return Object.keys((i && i.$options && i.$options.methods) || {})
    const t = (i && i.type) || {}
    const out = Object.keys(t.methods || {})
    const s = (i && i.setupState) || {}
    for (const k of Object.keys(s)) if (typeof s[k] === 'function') out.push(k)
    return Array.from(new Set(out))
  }
  const propsOf = (i, v) => {
    if (v === 2) {
      const p = (i && i.$options && i.$options.props) || {}
      return Array.isArray(p) ? p : Object.keys(p)
    }
    const p = (i && i.type && i.type.props) || {}
    return Array.isArray(p) ? p : Object.keys(p)
  }
  const pathOf = (i, v) => {
    const out = []
    let cur = i
    let guard = 0
    while (cur && guard++ < 40) {
      out.unshift(nameOf(cur, v))
      const parent = v === 2 ? cur.$parent : cur.parent
      if (!parent) break
      cur = parent
    }
    return out
  }

  const data = dataOf(inst, hit.version)
  const res = {
    found: true,
    version: hit.version,
    name: nameOf(inst, hit.version),
    uid: hit.version === 3 ? inst.uid : (inst._uid != null ? inst._uid : null),
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    path: pathOf(inst, hit.version),
    dataKeys: Object.keys(data || {}),
    methods: methodsOf(inst, hit.version),
    props: propsOf(inst, hit.version),
  }

  if (opt.name) {
    res.nameWanted = opt.name
    res.nameMatched = String(res.name).toLowerCase() === String(opt.name).toLowerCase()
  }

  if (opt.call) {
    // 1.16.0：调用组件方法。弹窗（ElDialog/HFormDialog）常常没有可点的 DOM 入口，
    // 只能走 exposed / setupState / ctx 上暴露的 openDialog 之类方法。
    const fnName = String(opt.call)
    const args = Array.isArray(opt.args) ? opt.args : []
    const exposed = (inst && inst.exposed) || {}
    const setup = (inst && inst.setupState) || {}
    const ctx = (inst && (inst.ctx || inst.proxy)) || {}
    const v2methods = (hit.version === 2 && inst && inst.$options && inst.$options.methods) || {}
    let fn = exposed[fnName] || setup[fnName] || ctx[fnName] || v2methods[fnName]
    if (typeof fn !== 'function' && inst && typeof inst[fnName] === 'function') fn = inst[fnName]
    res.call = fnName
    res.args = args
    if (typeof fn !== 'function') {
      res.callError = '组件「' + res.name + '」上找不到方法 ' + fnName + '；不加 call 先看 methods 列表确认名字'
    } else {
      try {
        const out = await fn.apply(inst, args)
        try { res.callResult = JSON.parse(JSON.stringify(out === undefined ? null : out)) } catch (e) { res.callResult = String(out) }
      } catch (e) {
        res.callError = '方法执行报错：' + String((e && e.message) || e)
      }
    }
  }

  if (opt.pick) {
    const resolve = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
    let v = resolve(data, opt.pick)
    if (v === undefined) v = resolve(inst, opt.pick)
    res.pick = opt.pick
    try { res.picked = JSON.parse(JSON.stringify(v === undefined ? null : v)) } catch (e) { res.picked = String(v) }
  }

  if (opt.tree) {
    const depth = Math.max(1, Math.min(12, opt.maxDepth || 4))
    if (hit.version === 2) {
      const tree = []
      let root = inst
      let g = 0
      while (root && root.$parent && g++ < 40) root = root.$parent
      const walk = (i, d) => {
        if (!i || d > depth || tree.length > 200) return
        tree.push({ name: nameOf(i, hit.version), uid: i._uid, depth: d })
        ;(i.$children || []).forEach((c) => walk(c, d + 1))
      }
      walk(root, 0)
      res.tree = tree
    } else {
      res.tree = collectComponents(inst, 200, depth).map((c) => ({
        name: nameOf(c.inst, 3),
        uid: c.inst.uid,
        depth: c.depth,
      }))
    }
  }
  return res
}

const EXTRA_ACTIONS = new Set([
  'press', 'hover', 'dialog', 'logs', 'networkLog', 'networkDetail', 'networkClear', 'replay', 'netBlock',
  'pdf', 'mhtml', 'upload', 'drag', 'emulate', 'metrics', 'cdp', 'detach', 'storage', 'highlight',
  // 1.12.0：查标签页开关、在页面源码里搜字符串、看 Vue 组件
  'tabEvents', 'sourceSearch', 'vue',
  // 1.13.0：在页面上下文发任意请求（带 cookie），大响应直接落盘
  'fetch',
])

export function isExtraAction(action) {
  return EXTRA_ACTIONS.has(action)
}

function outDir(root) {
  return path.join(chromeHome(root), 'out')
}
async function saveBinary(root, name, base64, ext) {
  const target = resolveSavePath(root, name, `export-${Date.now().toString(36)}`, ext)
  await ensureDir(target.dir)
  const buffer = Buffer.from(String(base64 || ''), 'base64')
  await writeFile(target.file, buffer)
  return { file: target.file, bytes: buffer.length }
}

/** MHTML 是纯文本（quoted-printable），不是 base64——按二进制写会写出一堆乱码。 */
async function saveText(root, name, text, ext, pretty) {
  const target = resolveSavePath(root, name, `export-${Date.now().toString(36)}`, ext)
  await ensureDir(target.dir)
  const body = prettyIfJson(String(text == null ? '' : text), pretty, target.file)
  await writeFile(target.file, body, 'utf8')
  return { file: target.file, bytes: Buffer.byteLength(body, 'utf8') }
}

/**
 * 落盘 JSON 美化：能解析就缩进 2 空格，`pretty:false` 保留原样。
 * 只对 .json 文件生效——.txt/.html 落盘要原样，别把普通文本也改了。
 * 接口响应常是单行几千字，而 read 每行只回 2000 字——不缩进等于落盘即不可读
 * （2026-11-25 追溯投料量时，4000 字的 JSON 只能再写 Python 才看得完）。
 */
function prettyIfJson(text, pretty, file) {
  const s = String(text == null ? '' : text)
  if (pretty === false) return s
  if (file && !/\.json$/i.test(String(file))) return s
  const t = s.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return s
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return s }
}

/**
 * fetch 批量落盘的目录：像路径就按路径走，只给一个词（如 "flows"）就放到 out/ 下面。
 * 2026-11-24 抓 17 个流程定义时是手工 saveTo 17 次，名字还得自己排。
 */
function batchDir(root, dir) {
  const raw = String(dir == null ? '' : dir).trim()
  if (!raw) return ''
  if (raw.startsWith('~') || raw.startsWith('.') || path.isAbsolute(raw) || /[\\/]/.test(raw)) return raw
  return path.join(outDir(root), raw)
}

/**
 * @param {object} bridge
 * @param {string} action
 * @param {object} params
 * @param {number} started
 * @param {{root?:string}} opts
 * @returns {Promise<object>} 结果；调用方负责 action 名
 */
export async function performExtra(bridge, action, params, started, opts = {}) {
  const root = opts.root
  const call = (name, payload, timeoutMs) => bridge.call(name, payload, { timeoutMs })
  const tabLoc = { tabId: params.tabId, urlContains: params.urlContains, index: params.index }

  switch (action) {
    case 'press': {
      if (!params.key) return { ok: false, action, ms: Date.now() - started, message: '【chrome:press】需要 key，例如 "Enter"、"Tab"、"Ctrl+A"' }
      const r = await call('press', {
        ...tabLoc, key: params.key, modifiers: params.modifiers, ref: params.ref, selector: params.selector, frame: params.frame,
      }, params.timeoutMs || 20000)
      if (!r.ok) return null   // 交给 fail() 统一处理（错误码在 bridge 抛出的 error 里）
      const p = r.pressed || {}
      const lines = [
        `【chrome:press】按了 ${p.key || params.key} · ${tabLine(r.tab, r)}`,
        p.inserted ? '（带字符：按键本身就把字符插进去了，只发了一次）' : '（纯按键，不插字符）',
      ]
      if (r.focused) lines.push(`已聚焦：${r.focused.tag}${r.focused.name ? ' name=' + r.focused.name : ''}${r.focused.active === false ? '（页面没认这个焦点）' : ''}`)
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'hover': {
      const r = await call('hover', {
        ...tabLoc, ref: params.ref, selector: params.selector, x: params.x, y: params.y,
      }, params.timeoutMs || 15000)
      if (!r.ok) return null
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:hover】鼠标移到 (${Math.round(r.x)},${Math.round(r.y)}) · ${tabLine(r.tab, r)}\n（真实 mouseMoved，会触发 :hover 菜单/提示；不点击）`,
        detail: r,
      }
    }

    case 'storage': {
      const op = String(params.op || 'list').toLowerCase()
      const r = await call('storage', {
        ...tabLoc, kind: params.kind, op, key: params.key, value: params.value,
        limit: params.limit, maxChars: params.maxChars, showValues: params.showValues === true,
      }, 20000)
      if (!r.ok) return null
      const kind = r.kind === 'session' ? 'sessionStorage' : 'localStorage'
      const masked = (v) => (params.showValues === true ? clip(v, 200) : `***（${String(v || '').length} 字，showValues:true 才看）`)
      const lines = [`【chrome:storage】${kind}.${op} · ${tabLine(r.tab, r)}`]
      if (op === 'list') {
        lines.push(`${r.count} 个 key：`)
        for (const row of r.rows || []) {
          lines.push(`· ${row.key} = ${masked(row.value)}`)
        }
        if (!(r.rows || []).length) lines.push('—— 空 ——')
      } else if (op === 'get') {
        lines.push(r.found ? `${r.key} = ${masked(r.value)}` : `没有 ${r.key} 这个 key`)
      } else if (op === 'set') {
        lines.push(`已写入 ${r.key}（${r.valueLength} 字）`)
      } else if (op === 'remove') {
        lines.push(`已删除 ${r.key}`)
      } else if (op === 'clear') {
        lines.push(`清空 ${r.cleared} 个 key`)
      }
      if (!params.showValues && (op === 'list' || op === 'get')) lines.push('（值是凭据时别外传；要真值加 showValues:true）')
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'),
        detail: { kind: r.kind, op, count: r.count, key: r.key, found: r.found, rows: (r.rows || []).map((row) => ({ key: row.key, valueLength: row.valueLength, value: params.showValues === true ? row.value : '***' })) },
      }
    }

    case 'highlight': {
      const r = await call('highlight', {
        ...tabLoc, ref: params.ref, selector: params.selector, color: params.color, clear: params.clear === true,
      }, 15000)
      if (!r.ok) return null
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: params.clear
          ? `【chrome:highlight】已清掉高亮 · ${tabLine(r.tab, r)}`
          : `【chrome:highlight】已高亮 <${r.tag}>「${clip(r.text, 50)}」（红框，只是给你看的，不改数据）· ${tabLine(r.tab, r)}`,
        detail: r,
      }
    }

    case 'networkDetail': {
      const match = String(params.match || '').toLowerCase()
      const saving = Boolean(params.saveTo)
      const r = await call('networkDetail', {
        ...tabLoc, requestId: params.requestId, index: params.index, filter: params.filter,
        match: match || undefined, source: params.source, maxChars: saving ? 0 : params.maxChars,
      }, 25000)
      if (!r.ok) return null
      const lines = [
        `【chrome:networkDetail】${r.method} ${r.status ?? '?'} ${r.statusText || ''} · ${tabLine(r.tab, r)}`,
        `${clip(r.url, 200)}`,
      ]
      if (r.source === 'probe') lines.push('（来自页面探针：CDP 挂上之前的请求。请求体/请求头有（凭据已脱敏），响应头没有；响应体默认不记，开了 window.__dshProbeRespLimit 才有）')
      if (typeof r.frameId === 'number' && r.frameId > 0) lines.push(`帧：f${r.frameId}${r.frameUrl ? ' ' + clip(r.frameUrl, 120) : ''}`)
      if (r.failed) lines.push(`失败：${r.failed}`)
      // 命中多条时把候选摆出来：filter 默认子串匹配，很容易点到隔壁接口
      // （2026-11-25：filter "routeActivity/query" 实际命中的是 queryActivityInfo）。
      const cands = Array.isArray(r.candidates) ? r.candidates : []
      if (cands.length > 1) {
        lines.push(`—— 命中 ${cands.length} 条（上面是最后一条）；换 match:"path"/"regex"，或用 index ——`)
        for (const c of cands.slice(0, 6)) lines.push(`  index=${c.index}  ${c.method} ${c.status ?? '?'} ${clip(c.url, 150)}`)
      }
      const reqH = Object.entries(r.requestHeaders || {})
      if (reqH.length) lines.push('—— 请求头 ——', ...reqH.slice(0, 12).map(([k, v]) => `${k}: ${clip(v, 120)}`))
      if (r.postData) {
        lines.push(`—— 请求体（${String(r.postData).length} 字${r.postDataTruncated ? '，探针只存了前 1200 字' : ''}）——`, clip(r.postData, 2000))
      } else if (r.source === 'probe') {
        lines.push('（这条请求没有记录到请求体：可能是 GET，或 probe 装上之前就发出了）')
      }
      const resH = Object.entries(r.responseHeaders || {})
      if (resH.length) lines.push('—— 响应头 ——', ...resH.slice(0, 12).map(([k, v]) => `${k}: ${clip(v, 120)}`))
      let file = ''
      if (saving && r.body) {
        const saved = await saveText(root, params.saveTo, r.body, 'json', params.pretty)
        file = saved.file
        lines.push(`已落盘：${file}（${r.bodyLength} 字${r.bodyTruncated ? '，' + bodyBrief(r, 1500) : '，全文'}）`)
      }
      if (!r.body) {
        lines.push(`（没有响应体${r.bodyError ? '：' + r.bodyError : ''}）`)
      } else if (!file) {
        lines.push(`—— 响应体（${r.bodyLength} 字${r.bodyTruncated ? '，' + bodyBrief(r, 1500) : ''}）——\n${clip(r.body, 1500)}`)
      }
      // 1.19.0：内网网关超时页也是 4xx + text/html，别让它看起来像「接口不存在」。
      const ct = String((r.responseHeaders && (r.responseHeaders['content-type'] || r.responseHeaders['Content-Type'])) || r.mimeType || '')
      if (r.status >= 400 && /text\/html/i.test(ct)) {
        lines.push('（响应是 HTML 错误页：可能是网关/代理超时页，不一定是接口不存在）')
      }
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: { requestId: r.requestId, method: r.method, url: r.url, status: r.status, bodyLength: r.bodyLength, candidates: cands.length, file } }
    }

    case 'tabEvents': {
      const op = String(params.op || 'list').toLowerCase()
      const r = await call('tabEvents', {
        op, tabId: params.tabId, limit: params.limit, filter: params.filter,
        ignore: params.ignore, collapse: params.collapse,
      }, 20000)
      if (!r.ok) return null

      if (op === 'clear') {
        const c = r.cleared || {}
        return {
          ok: true, action, ms: Date.now() - started,
          message: `【chrome:tabEvents】已清空：事件 ${c.events ?? 0} 条，已关闭标签留证 ${c.closed ?? 0} 个`,
          detail: r,
        }
      }

      if (op === 'get' || op === 'net' || op === 'console') {
        if (!r.found) {
          const kept = (r.kept || []).map((id) => '#' + id).join('、')
          return {
            ok: true, action, ms: Date.now() - started,
            message: `【chrome:tabEvents】没有 #${params.tabId} 的留证。\n${r.note || ''}${kept ? `\n还留着这些：${kept}` : ''}`,
            detail: r,
          }
        }
        const head = [
          `【chrome:tabEvents】已关闭标签 #${r.tabId}《${clip(r.title || '(无标题)', 40)}》`,
          `URL：${r.url || '(没记到)'}`,
          `开启者：${r.openerTabId != null ? '#' + r.openerTabId : '(不是脚本开的／没记到)'} · 存活 ${r.livedMs != null ? (r.livedMs / 1000).toFixed(1) + ' 秒' : '?'} · 关闭于 ${r.closedAt ? timeOf(r.closedAt) : '?'}`,
          `关之前的证据：请求 ${r.networkCount} 条 · console ${r.consoleCount} 条`,
        ]
        if (op === 'get') {
          return { ok: true, action, ms: Date.now() - started, message: head.join('\n') + `\n（看请求：op=net tabId=${r.tabId}；看 console：op=console tabId=${r.tabId}）`, detail: r }
        }
        const rows = r.rows || []
        const lines = [head[0], head[1], head[2], `这里给了 ${rows.length} 条${r.matched != null ? `（匹配 ${r.matched}）` : ''}`]
        if (op === 'console') {
          if (!rows.length) lines.push('—— 空 ——')
          for (const row of rows) lines.push(`· [${timeOf(row.ts)}] ${row.level || 'log'} ${clip(row.text, 200)}`)
        } else {
          if (!rows.length) lines.push('—— 空 ——')
          for (const row of rows) {
            const status = row.status == null ? (row.failed ? '失败' : 'pending') : row.status
            const repeatTag = row.repeat > 1 ? `  ×${row.repeat}` : ''
            lines.push(`· [${timeOf(row.ts)}] ${row.method} ${status} ${row.url}${row.body ? `  ▣请求体 ${String(row.body).length} 字` : ''}${repeatTag}`)
          }
          if (r.truncated) lines.push('（匹配超过显示上限，加大 limit 看更多）')
        }
        return { ok: true, action, ms: Date.now() - started, message: lines.join('\n'), detail: r }
      }

      // op=list
      const ev = r.events || []
      const tabs = r.closed || []
      const lines = [
        `【chrome:tabEvents】最近 ${ev.length} 条标签页事件（共 ${r.totalEvents || ev.length}）· 已关闭留证 ${tabs.length} 个`,
      ]
      if (!ev.length) lines.push('—— 空 ——（扩展刚重载过？SW 重启会丢事件环）')
      for (const e of ev) {
        const t = timeOf(e.ts)
        if (e.kind === 'created') {
          lines.push(`· [${t}] 新建 #${e.tabId}${e.openerTabId != null ? `（由 #${e.openerTabId} 打开）` : ''}  ${e.url || '(还没地址)'}`)
        } else if (e.kind === 'removed') {
          lines.push(`· [${t}] 关闭 #${e.tabId}  存活 ${e.livedMs != null ? (e.livedMs / 1000).toFixed(1) + ' 秒' : '?'}  ${e.url || '(没记到地址)'}`)
        } else if (e.kind === 'url') {
          lines.push(`· [${t}] 跳转 #${e.tabId}  ${e.url || ''}`)
        } else if (e.kind === 'loaded') {
          lines.push(`· [${t}] 加载完 #${e.tabId}  ${clip(e.url || '', 120)}`)
        } else if (e.kind === 'active') {
          lines.push(`· [${t}] 切到 #${e.tabId}`)
        }
      }
      lines.push('（「新建 → 秒关」这种：看 removed 的存活时间和 URL；要它关之前的请求，用 op=net tabId=<关闭的 tabId>）')
      return { ok: true, action, ms: Date.now() - started, message: lines.join('\n'), detail: r }
    }

    case 'sourceSearch': {
      const needle = String(params.needle || params.text || '').trim()
      if (!needle) return { ok: false, action, ms: Date.now() - started, message: '【chrome:sourceSearch】需要 needle：要搜的字符串（脚本里的方法名、中文提示语、接口路径都行）' }
      const opt = {
        needle,
        regex: params.regex === true,
        caseSensitive: params.caseSensitive === true,
        // 1.19.0：显式指定要扫的脚本，优先扫（懒加载模块/importmap 常常不在 script[src] 里）
        scripts: Array.isArray(params.scripts) ? params.scripts.map((x) => String(x)) : [],
        maxFiles: Math.max(1, Math.min(80, Number(params.maxFiles) || 40)),
        perFile: Math.max(1, Math.min(50, Number(params.limit) || 5)),
        maxMatches: Math.max(1, Math.min(120, Number(params.maxMatches) || 40)),
        ctx: Math.max(60, Math.min(3000, Number(params.context) || 400)),
      }
      const code = `(${sourceSearchPageFn.toString()})(${JSON.stringify(opt)})`
      const r = await call('eval', { ...tabLoc, code, world: 'MAIN', maxChars: 0, timeoutMs: params.timeoutMs || 90000 }, { timeoutMs: (Number(params.timeoutMs) || 90000) + 10000 })
      if (!r.ok) return null
      let res = r.value
      if (typeof res === 'string') { try { res = JSON.parse(res) } catch { /* 原样 */ } }
      if (!res || typeof res !== 'object') return { ok: false, action, ms: Date.now() - started, message: `【chrome:sourceSearch】页面没回结果：${clip(r.value, 300)}` }
      if (res.error) return { ok: false, action, ms: Date.now() - started, message: `【chrome:sourceSearch】${res.error}` }
      const matches = res.matches || []
      const lines = [
        `【chrome:sourceSearch】在 ${res.scanned || 0}/${res.scripts || 0} 个脚本里搜「${clip(needle, 40)}」：命中 ${res.hits || 0} 处，取了 ${matches.length} 处 · ${tabLine(r.tab, r)}`,
      ]
      if (res.failed && res.failed.length) lines.push(`（${res.failed.length} 个脚本没抓下来：${res.failed.slice(0, 3).map((x) => clip(x, 80)).join('；')}）`)
      // 1.19.0：把「扫了哪些」摊开。以前只报 28/28，0 命中时分不清是漏扫还是真没有。
      const scannedList = Array.isArray(res.scannedList) ? res.scannedList : []
      if (scannedList.length) {
        const names = [...new Set(scannedList.map((u) => String(u).split('?')[0].split('/').pop()))]
        const shown = names.slice(0, 6).join('、')
        lines.push(`（扫过 ${scannedList.length} 个：${shown}${names.length > 6 ? '…' : ''}）`)
      }
      if (!matches.length) {
        lines.push('—— 没有命中 ——')
        lines.push('（可能是懒加载 chunk 还没请求过：先操作一下让页面加载那个模块再搜；也可以传 scripts:["/路径/x.js"] 直接指定文件）')
      }
      for (const m of matches) {
        const file = String(m.file || '').split('?')[0].split('/').pop()
        lines.push(`\n── ${file} @${m.at}（文件 ${Math.round((m.size || 0) / 1024)}KB）──`)
        lines.push(prettyCode(m.ctx))
      }
      const body = lines.join('\n')
      let file = ''
      if (params.saveTo) {
        const target = resolveSavePath(root, params.saveTo, 'source-search.txt')
        await ensureDir(target.dir)
        await writeFile(target.file, body, 'utf8')
        file = target.file
      }
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: file ? `${clip(body, 1200)}\n\n（完整 ${body.length} 字已落盘：${file}）` : clip(body, 12000),
        detail: { needle, scripts: res.scripts, scanned: res.scanned, hits: res.hits, matches: matches.length, file, files: matches.map((m) => m.file), scriptList: scannedList.slice(0, 20) },
      }
    }

    case 'vue': {
      const opt = {
        ref: params.ref || '',
        selector: params.selector || '',
        pick: params.pick || '',
        tree: params.tree === true,
        maxDepth: Math.max(1, Math.min(12, Number(params.maxDepth) || 4)),
        // 按组件名找（如 HFormDialog），再 call 它的方法
        name: params.name || '',
        // 1.16.0：弹窗类组件（ElDialog 等）没有可点的入口，只能调组件暴露的方法。
        call: params.call || '',
        args: Array.isArray(params.args) ? params.args : (params.args == null ? [] : [params.args]),
      }
      const code = `(${vueInspectPageFn.toString()})(${JSON.stringify(opt)})`
      const r = await call('eval', { ...tabLoc, code, world: 'MAIN', maxChars: 0, timeoutMs: params.timeoutMs || 30000 }, { timeoutMs: (Number(params.timeoutMs) || 30000) + 10000 })
      if (!r.ok) return null
      let res = r.value
      if (typeof res === 'string') { try { res = JSON.parse(res) } catch { /* 原样 */ } }
      if (!res || typeof res !== 'object') return { ok: false, action, ms: Date.now() - started, message: `【chrome:vue】页面没回结果：${clip(r.value, 300)}` }
      if (!res.found) {
        return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: `【chrome:vue】没找到 Vue 组件：${res.note || ''}\n（这页可能不是 Vue，或 ref 指到了组件外的节点；不给 ref/selector 时会从 #app 往下找）`, detail: res }
      }
      const lines = [`【chrome:vue】<${res.tag || '?'}> → 组件「${res.name}」 · Vue${res.version}${res.uid != null ? ` · uid=${res.uid}` : ''} · ${tabLine(r.tab, r)}`]
      if (res.path && res.path.length) lines.push(`从根到这里的链：${res.path.join(' > ')}`)
      if (res.nameWanted && !res.nameMatched) lines.push(`没找到名为「${res.nameWanted}」的组件，用的是「${res.name}」；先加 tree:true 看准确名字`)
      if (res.props && res.props.length) lines.push(`props：${res.props.join('、')}`)
      if (res.dataKeys && res.dataKeys.length) lines.push(`data 键（${res.dataKeys.length}）：${res.dataKeys.slice(0, 40).join('、')}${res.dataKeys.length > 40 ? ' …' : ''}`)
      if (res.methods && res.methods.length) lines.push(`方法（${res.methods.length}）：${res.methods.join('、')}`)
      if (res.picked != null) {
        const text = typeof res.picked === 'string' ? res.picked : JSON.stringify(res.picked, null, 2)
        lines.push(`pick=${res.pick}：\n${clip(text, 4000)}`)
      }
      if (res.tree) {
        lines.push('组件树：')
        for (const node of res.tree) lines.push(`${'  '.repeat(node.depth || 0)}· ${node.name}${node.uid != null ? ` (uid=${node.uid})` : ''}`)
      }
      if (res.call) {
        if (res.callError) {
          lines.push(`call=${res.call} 失败：${res.callError}`)
        } else {
          let text
          try { text = typeof res.callResult === 'string' ? res.callResult : JSON.stringify(res.callResult, null, 2) } catch { text = String(res.callResult) }
          lines.push(`call=${res.call}(${(res.args || []).map((a) => JSON.stringify(a)).join(', ')}) → ${clip(String(text == null ? 'null' : text), 1500)}`)
        }
      }
      lines.push('（要读某个值就加 pick=<data 键>，如 pick=AllDataSource；要调方法用 call=<methods 里的名字>，args 传参数数组）')
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: res }
    }

    case 'dialog': {
      // 注意：工具层的 action 已经被 'dialog' 占了，子操作用 op（get/set），别再叫 action
      const sub = String(params.op || 'get').toLowerCase()
      const r = await call('dialog', {
        ...tabLoc, op: sub, mode: params.mode, promptText: params.promptText,
      }, 15000)
      if (!r.ok) return null
      const policy = r.policy || {}
      const modeText = { accept: '弹窗自动按 OK', dismiss: '弹窗自动按取消', manual: '手动（会卡住页面线程直到超时）' }[policy.mode] || policy.mode
      const lines = [`【chrome:dialog】策略 ${policy.mode}（${modeText}）· ${tabLine(r.tab, r)}`]
      if (sub === 'set') lines.push('已改策略。')
      const rows = r.rows || []
      lines.push(rows.length ? `最近弹窗 ${rows.length} 条：` : '最近没有弹窗。')
      for (const row of rows) {
        lines.push(`· [${timeOf(row.ts)}] ${row.type}「${clip(row.message, 80)}」→ ${row.answered}`)
      }
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'logs': {
      const r = await call('logs', { ...tabLoc, limit: params.limit, level: params.levels || params.level }, 20000)
      if (!r.ok) return null
      const rows = r.rows || []
      const lines = [
        `【chrome:logs】${tabLine(r.tab, r)} · 缓冲 ${r.total} 条${r.level ? `（只看 ${r.level}）` : ''}`,
        '（只抓 CDP 挂上之后的日志；更早的抓不到，这是协议限制）',
      ]
      // 1.9.0：CDP 挂上之前的报错由页面探针补（probe.js）
      if (r.source === 'probe') lines.push('（这些来自页面探针：CDP 还没挂上时发生的，时间戳由页面记录）')
      else if (r.source === 'mixed') lines.push(`（其中 ${r.probeRows || '?'} 条来自页面探针，是 CDP 挂上之前的）`)
      if (!rows.length) lines.push('—— 空 ——')
      for (const row of rows.slice(-Number(params.limit) || -60)) {
        lines.push(`· [${timeOf(row.ts)}] ${row.level} ${clip(row.text, 200)}${row.url ? '  ← ' + clip(row.url, 80) : ''}`)
      }
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: { total: r.total, rows } }
    }

    case 'networkLog': {
      const r = await call('networkLog', {
        ...tabLoc, limit: params.limit, filter: params.filter, frame: params.frame,
        ignore: params.ignore, collapse: params.collapse, unique: params.unique === true,
      }, 20000)
      if (!r.ok) return null
      const rows = r.rows || []
      const matched = typeof r.matched === 'number' ? r.matched : rows.length
      const scope = [
        r.filter ? `filter=${r.filter}` : '',
        r.ignore ? `ignore=${r.ignore}` : '',
        r.frame != null ? `frame=${r.frame}` : '',
        r.unique ? 'unique' : '',
      ].filter(Boolean).join('，')
      const lines = [
        `【chrome:networkLog】${tabLine(r.tab, r)} · 缓冲 ${r.total} 条，匹配 ${matched} 条，显示 ${rows.length} 条${scope ? `（${scope}）` : ''}`,
        '（只抓 CDP 挂上之后的请求）',
      ]
      if (r.source === 'probe') lines.push('（这些来自页面探针：CDP 还没挂上时发生的，时间戳由页面记录）')
      else if (r.source === 'mixed') lines.push(`（其中 ${r.probeRows || '?'} 条来自页面探针，是 CDP 挂上之前的）`)
      if (r.probeFrames > 1) {
        lines.push(`（页面探针覆盖 ${r.probeFrames} 个帧，${r.framesWithTraffic} 个帧有请求——iframe 里的请求也收进来了；行首 f12 表示 frameId）`)
      }
      if (r.truncated) lines.push(`（匹配 ${matched} 条，这里只显示最新 ${rows.length} 条；要看更早的加大 limit（上限 400）或加 filter）`)
      if (r.unique) lines.push(`（已按 method+url 去重：${r.uniqueDropped || 0} 条重复调用合并，行尾 ×N 是次数；要看逐条加 unique:false）`)
      if (r.folded) lines.push(`（相邻重复请求折叠了 ${r.folded} 条，行尾 ×N 是次数；要逐条看加 collapse:false）`)
      if (r.ignored) lines.push(`（ignore 正则排掉 ${r.ignored} 条）`)
      if (!rows.length) lines.push('—— 空 ——')
      if (!rows.length && !r.filter && !r.ignore) lines.push('（缓冲是空的：请求要么还没发生，要么页面刷新后探针才装上）')
      if (!rows.length && (r.filter || r.ignore) && r.total > 0) lines.push(`（缓冲里 ${r.total} 条都不匹配；去掉 filter/ignore 再看一眼，或换个小一点的片段）`)
      for (const row of rows) {
        const status = row.status == null ? (row.failed ? '失败' : 'pending') : row.status
        const meta = [row.mime ? clip(row.mime, 30) : '', row.length ? Math.round(row.length / 1024) + 'KB' : ''].filter(Boolean).join(' ')
        const frameTag = typeof row.frameId === 'number' && row.frameId > 0 ? `f${row.frameId} ` : ''
        const bodyTag = row.body ? `  ▣请求体 ${String(row.body).length} 字` : ''
        const repeatTag = row.repeat > 1 ? `  ×${row.repeat}` : ''
        const idTag = row.id ? `  #${clip(String(row.id), 14)}` : ''
        // 关键头（X-*/moduleCode 这类）：数据权限、租户、版本经常由它们决定，
        // 只打名字+值，够判断「这条和那条是不是同一个调用口径」。
        const hs = row.requestHeaders || row.headers || null
        let headTag = ''
        if (hs) {
          // 排序而不是「只按优先级分组」：moduleCode 在页面里的插入顺序常常偏后，
          // 用「有两个优先级桶」的写法它还是排在末尾，被 slice(0,3) 截掉（1.11.1 踩过）。
          const rank = (k) => {
            if (/^modulecode$/i.test(k)) return 0
            if (/^x-function-code$/i.test(k)) return 1
            if (/^x-operator$/i.test(k)) return 2
            if (/^x-app-code$/i.test(k)) return 3
            return 4
          }
          const keys = Object.keys(hs)
            .filter((k) => /^(x-|modulecode$|app-?code$|tenant)/i.test(k))
            .sort((a, b) => rank(a) - rank(b))
          if (keys.length) {
            headTag = '  ⚑ ' + keys.slice(0, 3).map((k) => `${k}=${clip(String(hs[k]), 24)}`).join(' ')
            if (keys.length > 3) headTag += ' …'
          }
        }
        lines.push(`· [${timeOf(row.ts)}] ${frameTag}${row.method} ${status} ${clip(row.type || '', 12)} ${row.url}${meta ? '  ' + meta : ''}${bodyTag}${repeatTag}${idTag}${headTag}${row.failed ? '  ✗ ' + clip(row.failed, 60) : ''}`)
      }
      if (r.withBody) lines.push('（要看提交内容：networkDetail + filter=URL片段 或 requestId；想按同一条再发一次：replay）')
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: lines.join('\n'),
        detail: { total: r.total, matched, rows, withBody: r.withBody, probeFrames: r.probeFrames, truncated: r.truncated, folded: r.folded, ignored: r.ignored },
      }
    }

    case 'replay': {
      const saving = Boolean(params.saveTo)
      // authFrom 在这里真的生效（1.20.0 补）：探针行的 Authorization 被脱敏，
      // 不补就必 401；合并交给扩展的 headers 覆盖逻辑（大小写不敏感）。
      const auth = await resolveAuthFrom(call, params, tabLoc)
      if (auth.missing) {
        return {
          ok: false, action, ms: Date.now() - started,
          message: `【chrome:replay】authFrom 取不到令牌：localStorage["${auth.missing}"] 是空的。先确认已登录、键名对不对（action=storage 列出 key），或改用 headers 手动传。`,
        }
      }
      const r = await call('replay', {
        ...tabLoc, requestId: params.requestId, index: params.index, filter: params.filter, frame: params.frame,
        headers: auth.headers, dropHeaders: params.dropHeaders, body: params.body, method: params.method,
        dryRun: params.dryRun === true, maxChars: saving ? 0 : params.maxChars, timeoutMs: params.timeoutMs,
      }, Math.max(4000, Math.min(120000, Number(params.timeoutMs) || 30000)) + 12000)
      if (!r.ok) return null
      const masked = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${/^(authorization|cookie)$/i.test(k) ? '***' : clip(v, 120)}`)
      if (r.dryRun) {
        const lines = [
          `【chrome:replay】dryRun：只是给你看会发什么，**没有真的发** · ${tabLine(r.tab, r)}`,
          `${r.method} ${clip(r.url, 240)}`,
          `来源：${r.source === 'probe' ? '页面探针（头已脱敏：判据是请求头的字段可能要自己补）' : 'CDP 抓到的请求'}`,
        ]
        if (auth.note) lines.push(auth.note)
        const hs = masked(r.headers)
        if (hs.length) lines.push('—— 请求头 ——', ...hs.slice(0, 16))
        if (r.body) lines.push(`—— 请求体（${r.bodyLength} 字）——\n${clip(r.body, 1200)}`)
        else lines.push('（不带请求体）')
        return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: { dryRun: true, method: r.method, url: r.url } }
      }
      const lines = [
        `【chrome:replay】${r.method} → ${r.sent === false ? '没发出去' : String(r.status ?? '?') + ' ' + (r.statusText || '')} · ${tabLine(r.tab, r)}`,
        clip(r.url, 240),
        `来源：${r.source === 'probe' ? '页面探针（Authorization 等凭据已脱敏，必要时用 headers 补）' : 'CDP 抓到的请求'}`,
      ]
      if (auth.note) lines.push(auth.note)
      if (r.sent === false) {
        lines.push(`失败：${clip(r.error || '未知原因', 300)}`)
        if (r.triedHeaders) lines.push('（浏览器拒绝设置某些头，已退一步只留业务头重试）')
        return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
      }
      const eh = masked(r.headers)
      if (eh.length) lines.push(`—— 响应头（${eh.length} 个）——`, ...eh.slice(0, 10))
      if (r.requestBodyTruncated) {
        lines.push(`⚠️ 这次重放用的请求体是截断版：探针只存前 1200 字（原长 ${r.requestBodyLength ?? '?'}）。要完整就显式传 body。`)
      }
      let file = ''
      if (saving && r.body) {
        // 失败响应别覆盖目标文件：2026-11-27 重放 query_template 时没带凭据，
        // 401 的网关 HTML 直接盖掉了同名的模板 JSON，回执还写「已落盘（578 字，全量）」，
        // 等于把刚抓到的证据冲了。
        const want = String(params.saveTo)
        const badStatus = Number(r.status) >= 400 || r.sent === false
        const htmlInsteadOfData = /text\/html/i.test(String(r.contentType || '')) && !/\.html?$/i.test(want)
        if (badStatus || htmlInsteadOfData) {
          const errFile = want.replace(/(\.[\w]+)$/, '') + '.err.html'
          const saved = await saveText(root, errFile, r.body, 'html', false)
          lines.push(`⚠️ 响应 ${r.status ?? '?'} 不是成功响应：错误页另存为 ${saved.file}`)
          lines.push(`   你指定的 ${want} 没有被覆盖（避免把错误页当数据写进去）。`)
        } else {
          const saved = await saveText(root, params.saveTo, r.body, 'json', params.pretty)
          file = saved.file
          lines.push(`已落盘：${file}（${r.bodyLength} 字${r.bodyTruncated ? '，' + bodyBrief(r, 2000) : '，全量'}）`)
        }
      }
      if (!file) {
        lines.push(`—— 响应体（${r.bodyLength} 字${r.bodyTruncated ? '，' + bodyBrief(r, 2000) : ''}）——`)
        lines.push(clip(r.jsonHead || r.body, 2000) || '（空）')
      }
      if (Number(r.status) === 401) lines.push(AUTH_HINT)
      lines.push('（这是一次真实请求：写接口会被真的执行。想只看不发用 dryRun:true）')
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: { status: r.status, bodyLength: r.bodyLength, source: r.source, file, requestBodyTruncated: r.requestBodyTruncated === true } }
    }

    case 'fetch': {
      const urlList = Array.isArray(params.urls) ? params.urls.map((u) => String(u == null ? '' : u).trim()).filter(Boolean) : []
      if (!params.url && !urlList.length) {
        return { ok: false, action, ms: Date.now() - started, message: '【chrome:fetch】需要 url，或 urls:[...] 批量抓（相对地址按当前页面解析，页面 cookie 自动带上）' }
      }
      const method = String(params.method || 'GET').toUpperCase()
      // authFrom：从页面 localStorage 取令牌自动加头。之前每条要鉴权的请求都得先 eval
      // 读一次 m5_token 再把头拼进去，401 之后才发现（2026-11-24 备份接口时）。
      const auth = await resolveAuthFrom(call, params, tabLoc)
      if (auth.missing) {
        return {
          ok: false, action, ms: Date.now() - started,
          message: `【chrome:fetch】authFrom 取不到令牌：localStorage["${auth.missing}"] 是空的。先确认已登录、键名对不对（action=storage 列出 key），或改用 headers 手动传。`,
        }
      }
      const headers = auth.headers
      const authNote = auth.note || ''
      const saveDir = params.saveToDir ? batchDir(root, params.saveToDir) : ''
      // 落盘了就别再回显大段正文：saveTo/saveToDir 的意图就是「正文去磁盘，别进上下文」。
      // 没显式 quiet:false 时自动安静（2026-11-24 抓流程定义时每批白读几千 token）。
      const quiet = params.quiet === true || (params.quiet == null && Boolean(params.saveTo || saveDir))
      const wantShape = params.shape === true || String(params.shape || '').toLowerCase() === 'keys' || String(params.shape) === '1'
      // headersList：与 urls 一一对应的额外头。MOM 这类平台每个接口的 moduleCode 都不同，
      // 一次批量只能共用一组 headers 的话，只能拆成多次调用（2026-11-25 抓 5 个接口拆了 3 次）。
      const headersList = Array.isArray(params.headersList) ? params.headersList : []
      const callFetch = (url, body, extraHeaders) => call('fetch', {
        ...tabLoc,
        url, method,
        headers: extraHeaders && typeof extraHeaders === 'object' ? { ...(headers || {}), ...extraHeaders } : headers,
        body: body === undefined ? params.body : body,
        // 1.19.0：saveTo 不再顺带强开 JSON 解析——落盘用的是原始 body，
        // 页面侧会按 content-type/首字符自己判断，JSON 照样缩进，`.js` 不再刷解析失败。
        json: params.json === true || wantShape,
        frame: params.frame,
        maxChars: (params.saveTo || saveDir) ? 0 : params.maxChars,
        timeoutMs: params.timeoutMs,
      }, Math.max(4000, Math.min(120000, Number(params.timeoutMs) || 30000)) + 8000)
      const shapeText = (r) => (wantShape && r && r.json !== undefined
        ? shapeOf(r.json, { depth: params.shapeDepth, maxKeys: params.shapeKeys })
        : '')

      // —— 批量：一次给一串 URL，一个 URL 一个文件 ——
      if (urlList.length) {
        const names = Array.isArray(params.names) ? params.names : []
        const bodies = Array.isArray(params.bodies) ? params.bodies : []
        // nameFrom（1.20.0）：从请求体里取字段当文件名主干，省得 22 个同 URL 的请求
        // 落成 01_/02_… 之后还要按顺序反推。
        const nameFrom = params.nameFrom ? String(params.nameFrom) : ''
        let nameFromMiss = 0
        const lines = [`【chrome:fetch】批量 ${urlList.length} 个 URL · ${method}${authNote ? ' · ' + authNote : ''}${headersList.length ? ' · 分接口表头 ' + headersList.length + ' 组' : ''}`]
        if (headersList.length && headersList.length !== urlList.length) {
          lines.push(`（headersList 有 ${headersList.length} 组、urls 有 ${urlList.length} 个：多余的忽略，缺的用基础 headers）`)
        }
        const detailRows = []
        let okCount = 0
        let firstTab = null
        for (let i = 0; i < urlList.length; i++) {
          const url = urlList[i]
          let r
          try {
            r = await callFetch(url, bodies.length ? bodies[i] : undefined, headersList.length ? headersList[i] : undefined)
          } catch (error) {
            r = { ok: false, error: String((error && error.message) || error) }
          }
          if (!r || !r.ok) {
            lines.push(`✗ ${String(i + 1).padStart(2, '0')} ${clip(url, 90)} → ${clip((r && (r.error || r.errorCode)) || '失败', 90)}`)
            detailRows.push({ index: i, url, ok: false, error: (r && r.error) || '失败' })
            if (params.stopOnError === true) break
            continue
          }
          okCount++
          if (!firstTab && r.tab) firstTab = r.tab
          let file = ''
          if (saveDir) {
            const explicit = names[i] && String(names[i]).trim()
            let stem = ''
            if (!explicit && nameFrom) {
              stem = stemFromBody(bodies.length ? bodies[i] : params.body, nameFrom)
              if (!stem) nameFromMiss++
            }
            const name = explicit
              || (stem ? `${String(i + 1).padStart(2, '0')}_${stem}` : fileNameFromUrl(url, i, params.namePrefix))
            const target = resolveSavePath(root, path.join(saveDir, name), name, r.json !== undefined ? 'json' : 'txt')
            await ensureDir(target.dir)
            await writeFile(target.file, prettyIfJson(String(r.body == null ? '' : r.body), params.pretty, target.file), 'utf8')
            file = target.file
          }
          lines.push(`${String(i + 1).padStart(2, '0')} ${r.status} ${r.length} 字${file ? ' → ' + file : ''}${r.status === 401 ? '（鉴权失败，见下）' : ''}`)
          const st = shapeText(r)
          if (st) lines.push(st.split('\n').map((l) => '   ' + l).join('\n'))
          detailRows.push({ index: i, url, status: r.status, length: r.length, file, contentType: r.contentType })
        }
        if (saveDir) {
          // 相对目录是按宿主进程 cwd 解析的（通常是 ~/.dsh/profiles/<profile>），
          // 回执里给绝对路径，省得拿相对名去猜文件到底在哪儿。
          const absDir = path.isAbsolute(saveDir) ? saveDir : path.resolve(saveDir)
          lines.push(`落盘目录：${absDir}`)
        }
        lines.push(`完成 ${okCount}/${urlList.length}${okCount < urlList.length && params.stopOnError === true ? '（已按 stopOnError 中断）' : ''}`)
        if (nameFrom && nameFromMiss) lines.push(`（nameFrom:"${nameFrom}" 有 ${nameFromMiss} 条取不到值，已按 URL 命名）`)
        if (detailRows.some((x) => x.status === 401)) lines.push(AUTH_HINT)
        return {
          ok: okCount > 0, action, ms: Date.now() - started, tab: firstTab,
          message: lines.join('\n'),
          detail: { batch: true, rows: detailRows, okCount, total: urlList.length, dir: saveDir },
        }
      }

      const r = await callFetch(params.url)
      if (!r.ok) return null
      let file = ''
      if (params.saveTo && r.body) {
        // 名字已经带扩展名就原样落，别落成 flows.json.txt
        const saved = await saveText(root, params.saveTo, r.body, r.json !== undefined ? 'json' : 'txt', params.pretty)
        file = saved.file
      }
      const lines = [`【chrome:fetch】${method} ${clip(r.url, 200)} → ${r.status} ${r.statusText || ''} · ${tabLine(r.tab, r)}`]
      if (authNote) lines.push(authNote)
      if (r.frameUrl) lines.push(`执行帧：${clip(r.frameUrl, 200)}${params.frame != null ? `（frame=${params.frame}）` : ''}`)
      if (r.redirected) lines.push('（发生了重定向，上面的 URL 是最终地址）')
      if (r.contentType) lines.push(`Content-Type：${clip(r.contentType, 100)}`)
      lines.push(`响应体 ${r.length} 字 · ${r.ms}ms${r.truncated ? '（回执只给预览）' : ''}`)
      if (file) lines.push(`已落盘：${file}（全量）`)
      if (r.readError) lines.push(`读取响应体失败：${clip(r.readError, 200)}`)
      const st = shapeText(r)
      const preview = r.json !== undefined ? JSON.stringify(r.json, null, 2) : String(r.body || '')
      if (st) lines.push('—— 结构（只看字段，不看值）——', st)
      else if (preview) lines.push('—— 响应体 ——', clip(preview, quiet ? 160 : 2500))
      else lines.push('（响应体为空）')
      if (r.jsonError) lines.push(`（json:true 但解析失败：${clip(r.jsonError, 160)}）`)
      if (r.status === 401) lines.push(AUTH_HINT)
      // 1.19.0：网关 15s 超时常回 404 HTML，先点破，别让人以为是路由不对。
      if (r.status >= 400 && /text\/html/i.test(String(r.contentType || ''))) {
        lines.push('（响应是 HTML 错误页：内网网关超时也常返回 404，不一定是接口不存在；可看耗时或隔一会儿再打一次）')
      }
      if (r.truncated && !file) lines.push('（要看全文：maxChars:0，或加 saveTo 落盘）')
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: lines.join('\n'),
        detail: { status: r.status, length: r.length, url: r.url, frameUrl: r.frameUrl, file },
      }
    }

    case 'netBlock': {
      const sub = String(params.op || 'set').toLowerCase()
      const r = await call('netBlock', {
        ...tabLoc, op: sub, patterns: params.patterns, blockMode: params.blockMode,
        dryRun: params.dryRun === true, frame: params.frame, allFrames: params.allFrames === true, limit: params.limit,
      }, 25000)
      if (!r.ok) return null
      if (sub === 'hits' || sub === 'get') {
        const hits = r.hits || []
        const lines = [
          `【chrome:netBlock】拦截记录 ${r.total} 条（模式 ${r.mode}${r.dryRun ? ' · dryRun' : ''}${r.installed ? '' : ' · 还没装'}）· ${tabLine(r.tab, r)}`,
        ]
        if (r.rules && r.rules.length) lines.push('规则：' + r.rules.map((x) => clip(x, 80)).join(' | '))
        if (!hits.length) lines.push('—— 空 ——（触发一下要观察的操作，再取一次）')
        for (const h of hits) {
          const frameTag = typeof h.frameId === 'number' && h.frameId > 0 ? `f${h.frameId} ` : ''
          lines.push(`· [${timeOf(h.ts)}] ${frameTag}${h.method} ${h.blocked ? '已拦截' : '已放行'} ${clip(h.url, 160)}${h.body ? `\n    请求体（${String(h.body).length} 字）：${clip(h.body, 600)}` : ''}`)
        }
        return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
      }
      const applied = r.applied || []
      const lines = [
        `【chrome:netBlock】${sub === 'off' ? '已解除拦截' : '已装拦截规则'} · ${tabLine(r.tab, r)}`,
        `模式：${r.mode}${r.dryRun ? '（dryRun：拦所有非 GET/HEAD/OPTIONS）' : ''} · 帧：${applied.map((a) => 'f' + a.frameId).join('、') || '主帧'}`,
      ]
      if (r.rules && r.rules.length) lines.push('规则：' + r.rules.map((x) => clip(x, 100)).join(' | '))
      if (r.note) lines.push(r.note)
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'networkClear': {
      const r = await call('networkClear', tabLoc, 15000)
      if (!r.ok) return null
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: `【chrome:networkClear】清掉 ${r.cleared} 条网络记录 · ${tabLine(r.tab, r)}`, detail: r }
    }

    case 'pdf': {
      const r = await call('pdf', {
        ...tabLoc, printBackground: params.printBackground, paperWidth: params.paperWidth, paperHeight: params.paperHeight, margin: params.margin,
      }, params.timeoutMs || 40000)
      if (!r.ok) return null
      const saved = await saveBinary(root, params.saveTo || `page-${Date.now().toString(36)}`, r.data, 'pdf')
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:pdf】已导出 ${tabLine(r.tab, r)}\n文件：${saved.file}（${Math.round(saved.bytes / 1024)} KB）`,
        detail: { file: saved.file, bytes: saved.bytes },
      }
    }

    case 'mhtml': {
      const r = await call('mhtml', tabLoc, params.timeoutMs || 40000)
      if (!r.ok) return null
      const saved = await saveText(root, params.saveTo || `page-${Date.now().toString(36)}`, r.data, 'mhtml')
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:mhtml】整页存成单文件 ${tabLine(r.tab, r)}\n文件：${saved.file}（${Math.round(saved.bytes / 1024)} KB）\n（是快照：内嵌脚本不会跑，当文本 grep 用）`,
        detail: { file: saved.file, bytes: saved.bytes },
      }
    }

    case 'upload': {
      if (!params.selector) return { ok: false, action, ms: Date.now() - started, message: '【chrome:upload】需要 selector（指向 input[type=file]）和 files' }
      const files = (Array.isArray(params.files) ? params.files : [params.files]).filter(Boolean).map(String)
      if (!files.length) return { ok: false, action, ms: Date.now() - started, message: '【chrome:upload】需要 files（一个或多个绝对路径）' }
      // 上传是唯一会把本机文件交给页面的动作：默认只允许环境变量指定的目录（设了就只认它）
      const confine = process.env.DSH_CHROME_UPLOAD_DIR || ''
      const resolved = []
      for (const file of files) {
        const abs = path.resolve(file)
        try {
          const info = await stat(abs)
          if (!info.isFile()) throw new Error('不是文件')
        } catch (error) {
          return { ok: false, action, ms: Date.now() - started, message: `【chrome:upload】文件不可用：${abs}（${error.code || error.message}）` }
        }
        if (confine) {
          const base = path.resolve(confine)
          const rel = path.relative(base, abs)
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return { ok: false, action, ms: Date.now() - started, message: `【chrome:upload】只允许上传 ${base} 里的文件（当前 DSH_CHROME_UPLOAD_DIR），拒绝了：${abs}` }
          }
        }
        resolved.push(abs)
      }
      const r = await call('upload', { ...tabLoc, selector: params.selector, files: resolved }, params.timeoutMs || 30000)
      if (!r.ok) return null
      const lines = [`【chrome:upload】已把 ${(r.files || []).length} 个文件设到 ${params.selector} · ${tabLine(r.tab, r)}`]
      for (const file of r.files || []) lines.push('· ' + file)
      lines.push('（走 CDP，没弹系统选择器。页面是不是真收下了，用 read 看文件名/数量确认）')
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'drag': {
      const r = await call('drag', { ...tabLoc, from: params.from, to: params.to, steps: params.dragSteps }, params.timeoutMs || 30000)
      if (!r.ok) return null
      const f = r.from || {}
      const t = r.to || {}
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:drag】(${Math.round(f.x)},${Math.round(f.y)}) → (${Math.round(t.x)},${Math.round(t.y)}) · ${tabLine(r.tab, r)}\n（真实鼠标：按下 → 插值移动 → 抬起；中途失败会补发抬起，不会卡在按住状态）`,
        detail: r,
      }
    }

    case 'emulate': {
      const r = await call('emulate', {
        ...tabLoc, device: params.device, width: params.width, height: params.height,
        deviceScaleFactor: params.deviceScaleFactor, mobile: params.mobile, network: params.network, cpuThrottlingRate: params.cpuThrottlingRate,
      }, params.timeoutMs || 20000)
      if (!r.ok) return null
      const a = r.applied || {}
      const lines = [`【chrome:emulate】${tabLine(r.tab, r)}`]
      if (a.device) lines.push(a.device === 'reset' ? '· 视口：已还原' : `· 视口：${a.device.name} ${a.device.width}×${a.device.height} @${a.device.deviceScaleFactor}x`)
      if (a.network) lines.push(`· 网络：${a.network.name}（延迟 ${a.network.latency}ms）`)
      if (a.cpuThrottlingRate) lines.push(`· CPU：${a.cpuThrottlingRate}x 降速`)
      lines.push('（节流挂在 debugger 会话上，会话一断就失效）')
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'metrics': {
      const r = await call('metrics', tabLoc, 20000)
      if (!r.ok) return null
      const lines = [
        `【chrome:metrics】${tabLine(r.tab, r)}`,
        `· DOM 节点 ${r.nodes ?? '?'} · 文档 ${r.documents ?? '?'} · frame ${r.frames ?? '?'} · 事件监听 ${r.listeners ?? '?'}`,
        `· 布局 ${r.layouts ?? '?'} 次 / ${r.layoutMs ?? 0}ms · 样式重算 ${r.recalcStyles ?? '?'} 次`,
        `· 脚本 ${r.scriptMs ?? 0}ms · 任务 ${r.taskMs ?? 0}ms · JS 堆 ${r.heapMB ?? '?'}MB`,
      ]
      return { ok: true, action, ms: Date.now() - started, tab: r.tab, message: lines.join('\n'), detail: r }
    }

    case 'cdp': {
      if (!params.method) return { ok: false, action, ms: Date.now() - started, message: '【chrome:cdp】需要 method，例如 "Page.getNavigationHistory"；params 是原样透传的对象' }
      const r = await call('cdp', { ...tabLoc, method: params.method, params: params.params }, params.timeoutMs || 30000)
      if (!r.ok) return null
      let text = ''
      try { text = JSON.stringify(r.result, null, 2) } catch { text = String(r.result) }
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:cdp】${r.method} · ${tabLine(r.tab, r)}\n${clip(text, 6000)}`,
        detail: { method: r.method, result: r.result },
      }
    }

    case 'detach': {
      const r = await call('detach', tabLoc, 15000)
      if (!r.ok) return null
      return {
        ok: true, action, ms: Date.now() - started, tab: r.tab,
        message: `【chrome:detach】已断开 CDP 会话${r.alreadyGone ? '（本来就没连着）' : ''} · ${tabLine(r.tab, r)}\n（「正受控制」横幅会消失；日志/网络缓冲也停了）`,
        detail: r,
      }
    }

    default:
      return null
  }
}

export { EXTRA_ACTIONS }
