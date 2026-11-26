/**
 * netlog.js —— networkLog 的纯函数：过滤 / 折叠 / 截断。
 *
 * 1.12.0 修的两个坑（2026-11-23 实测踩到，都是"明明在缓冲里，过滤却是 0 条"）：
 *  1. 以前 limit 先截断、filter 后置：`limit:3` + `filter:"stockOut"` 只剩最新 3 条
 *     再去过滤，等于对空气过滤。现在顺序是 过滤 → 折叠 → 取最新 N 条。
 *  2. 高频轮询（心跳/unReadCount 每 10 秒一条）会把环填满、把关键请求挤掉，
 *     而且回执全是重复行。现在相邻的同 method+url+status 行折叠成一条，带 ×N。
 *
 * 放在单独文件里是为了能单测：这里不碰 chrome.*，只吃数组。
 */

/** 面板默认显示多少条 */
export const DEFAULT_SHOW = 60
/** 单次回执最多显示多少条（再多模型也读不完） */
export const MAX_SHOW = 400
/** 合并 CDP + 探针时的上限：要能装下整个环（MAX_NETWORK）+ 探针多出来的那些 */
export const MAX_MERGE = 4000
/** 取"全部"时给 networkRows 的哨兵：它内部按 Math.min(MAX_NETWORK, limit) 收口 */
export const ALL_ROWS = 1000000

const isDup = (a, b) => Boolean(a) && Boolean(b)
  && String(a.method || '') === String(b.method || '')
  && String(a.url || '') === String(b.url || '')
  && String(a.status == null ? '' : a.status) === String(b.status == null ? '' : b.status)
  && Boolean(a.failed) === Boolean(b.failed)

/**
 * 过滤 → 折叠 → 取最新 limit 条。
 *
 * @param {Array} rows 已经按 ts 升序排好的行（CDP + 探针合并结果）
 * @param {object} opts
 * @param {string} [opts.filter]  URL 子串（大小写不敏感）或 method 全等
 * @param {string} [opts.ignore]  URL 正则（大小写不敏感）：命中就整条不看，用来排掉心跳
 * @param {number} [opts.frame]   只要这个 frameId
 * @param {boolean}[opts.collapse] 默认 true：相邻重复行折叠
 * @param {number} [opts.limit]   显示条数，默认 60，上限 400
 * @param {boolean}[opts.unique]  按 method+url 去重，只留最后一次（看「有哪些接口」而不是看重复次数）
 * @returns {{rows:Array, matched:number, total:number, ignored:number, folded:number, kept:number, truncated:boolean, filter:string, unique:boolean, uniqueDropped:number}}
 */
export function selectRows(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const filter = String(opts.filter == null ? '' : opts.filter).trim()
  const needle = filter.toLowerCase()
  const wantFrame = opts.frame == null ? null : Number(opts.frame)

  let ignoreRe = null
  if (opts.ignore) {
    try { ignoreRe = new RegExp(String(opts.ignore), 'i') } catch { ignoreRe = null }
  }

  const kept = []
  let ignored = 0
  for (const row of list) {
    if (!row) continue
    if (needle) {
      const url = String(row.url || '').toLowerCase()
      const method = String(row.method || '').toLowerCase()
      if (!url.includes(needle) && method !== needle) continue
    }
    if (wantFrame != null && Number(row.frameId || 0) !== wantFrame) continue
    if (ignoreRe && ignoreRe.test(String(row.url || ''))) { ignored++; continue }
    kept.push(row)
  }

  // unique 必须在 limit 之前：轮询接口能把缓冲塞满，先按接口去重才数得清「一共几个接口」。
  const unique = opts.unique === true
  const deduped = unique ? uniqueRows(kept) : kept
  const matched = deduped.length
  const limit = Math.max(1, Math.min(MAX_SHOW, Number(opts.limit) || DEFAULT_SHOW))
  const truncated = matched > limit
  const windowed = truncated ? deduped.slice(-limit) : deduped
  const foldedRows = (opts.collapse === false || unique) ? windowed.map((r) => ({ ...r })) : fold(windowed)

  return {
    rows: foldedRows,
    matched,
    total: list.length,
    ignored,
    folded: windowed.length - foldedRows.length,
    kept: windowed.length,
    truncated,
    filter,
    unique,
    uniqueDropped: kept.length - deduped.length,
  }
}

/**
 * 按 method + url 去重：同一接口只留最后一次，次数记在 repeat，首尾时间都留着。
 * 与 fold 的区别：fold 只合并**相邻**的，unique 跨整段缓冲合并。
 */
export function uniqueRows(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!row) continue
    const key = String(row.method || '') + ' ' + String(row.url || '')
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...row, repeat: 1, firstTs: row.ts })
      continue
    }
    prev.repeat = (prev.repeat || 1) + (row.repeat || 1)
    prev.firstTs = prev.firstTs || row.ts
    prev.ts = row.ts
    if (row.body) prev.body = row.body
    if (row.requestHeaders) prev.requestHeaders = row.requestHeaders
    if (row.headers) prev.headers = row.headers
    if (row.status != null) prev.status = row.status
    if (row.failed) prev.failed = row.failed
  }
  const out = Array.from(map.values())
  for (const row of out) {
    if (row.repeat === 1) { delete row.repeat; delete row.firstTs }
  }
  return out
}

/**
 * 相邻重复折叠：同 method+url+status 的连续行合成一条，记 repeat / firstTs / lastTs。
 * 只折叠**相邻**的：中间隔了别的请求就不合并，免得把因果顺序搅乱。
 */
export function fold(rows) {
  const out = []
  for (const row of rows) {
    if (!row) continue
    const prev = out[out.length - 1]
    if (prev && isDup(prev, row)) {
      prev.repeat = (prev.repeat || 1) + 1
      prev.firstTs = prev.firstTs || prev.ts
      prev.ts = row.ts
      if (row.body) prev.body = row.body
      if (row.requestHeaders) prev.requestHeaders = row.requestHeaders
      continue
    }
    out.push({ ...row, repeat: 1, firstTs: row.ts })
  }
  // repeat 恒为 1 的脏字段去掉，回执干净些
  for (const row of out) {
    if (row.repeat === 1) { delete row.repeat; delete row.firstTs }
  }
  return out
}
