/**
 * fetchplan.js —— fetch 的「批量落盘」与「只看结构」两件事，纯函数，单测友好。
 *
 * 为什么单独一份：2026-11-24 备接口时，17 个流程定义要分 3 次 eval、手写 slice(0,6)，
 * 回执还得读一遍 2.8 万字的响应体才知道抓没抓到。这里把「一个 URL → 一个文件名」
 * 和「一份 JSON → 一段结构说明」定成可测的规则，fetch 只管发请求。
 */

/**
 * 从 URL 推文件名主干：取路径最后两段，非字母数字下划线化，去掉 query/hash。
 * @param {string} rawUrl
 * @param {number} [index] 序号（从 0 开始），会补成两位数前缀，保证落盘顺序和入参一致
 * @param {string} [prefix] 额外前缀
 * @returns {string} 不含扩展名的文件名
 */
export function fileNameFromUrl(rawUrl, index = 0, prefix = '') {
  let stem = ''
  const raw = String(rawUrl == null ? '' : rawUrl).trim()
  if (!raw) stem = ''
  else {
    try {
      const u = new URL(raw, 'http://local.invalid')
      const parts = String(u.pathname || '').split('/').filter(Boolean)
      stem = parts.slice(-2).join('_') || u.hostname || ''
    } catch {
      stem = raw.replace(/[?#].*$/, '')
    }
  }
  stem = String(stem)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
  if (!stem) stem = 'item'
  if (stem.length > 80) stem = stem.slice(0, 80).replace(/[_.]+$/, '')
  const num = String(Math.max(0, Number(index) || 0) + 1).padStart(2, '0')
  const pre = prefix ? String(prefix).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') + '_' : ''
  // 序号在前：批量落盘后按名字排序就是入参顺序
  return num + '_' + pre + stem
}

const typeName = (v) => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `array(${v.length})`
  if (typeof v === 'number') return Number.isInteger(v) ? 'number(int)' : 'number'
  return typeof v
}

/**
 * 把一份 JSON 描述成「字段 + 类型」的树，只留结构不留值。
 * 用途：先看接口返回有哪些字段，再决定要不要把全文落盘。
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.depth]   递归深度，默认 3
 * @param {number} [opts.maxKeys] 每层最多列几个字段，默认 40
 * @param {number} [opts.maxLines] 总行数上限，默认 80
 * @returns {string}
 */
export function shapeOf(value, opts = {}) {
  const maxDepth = Math.max(1, Math.min(6, Number(opts.depth) || 3))
  const maxKeys = Math.max(1, Math.min(200, Number(opts.maxKeys) || 40))
  const maxLines = Math.max(5, Math.min(400, Number(opts.maxLines) || 80))
  const lines = []
  let cut = false

  const push = (line) => {
    if (lines.length >= maxLines) { cut = true; return }
    lines.push(line)
  }

  const walk = (v, depth, indent, label) => {
    const head = indent + (label ? label + ': ' : '')
    if (v === null || typeof v !== 'object') { push(head + typeName(v)); return }
    if (Array.isArray(v)) {
      push(head + `array(${v.length})` + (v.length ? ' of' : ''))
      if (!v.length || depth >= maxDepth) return
      // 数组只看第一个元素的结构：接口返回的列表通常同构
      walk(v[0], depth + 1, indent + '  ', '[0]')
      return
    }
    const keys = Object.keys(v)
    push(head + '{' + (keys.length ? '' : '}'))
    if (!keys.length) return
    for (const k of keys.slice(0, maxKeys)) {
      const child = v[k]
      if (child && typeof child === 'object') {
        if (depth + 1 >= maxDepth) {
          push(indent + '  ' + k + ': ' + typeName(child))
        } else {
          walk(child, depth + 1, indent + '  ', k)
        }
      } else {
        push(indent + '  ' + k + ': ' + typeName(child))
      }
      if (cut) break
    }
    if (keys.length > maxKeys) push(indent + '  …（另有 ' + (keys.length - maxKeys) + ' 个字段）')
    push(indent + '}')
  }

  walk(value, 0, '', '')
  if (cut) lines.push('…（结构太长，已截断；加 depth/maxKeys 调细，或直接 saveTo 落全文）')
  return lines.join('\n')
}
