// dsh-chrome 1.2.0 改动自测：假桥 + 假页面返回，只看 actions 层渲染与错误语义。
import { performAction } from '../lib/actions.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')) }
}

const tab = { id: 7, title: '测试页', url: 'https://example.com/a' }
const fakeBridge = (handler) => ({ call: async (action, params) => handler(action, params) })

/* 1. read 分页：offset 回显、nextOffset、页头 */
{
  console.log('1) read 分页')
  const text = 'A'.repeat(6000) + '😀' + 'B'.repeat(5000)
  const bridge = fakeBridge((action, p) => {
    if (action !== 'read') throw new Error('unexpected ' + action)
    const offset = p.offset || 0
    let end = Math.min(text.length, offset + (p.maxChars || 20000))
    if (end < text.length && end > 0) {
      const c = text.charCodeAt(end - 1)
      if (c >= 0xD800 && c <= 0xDBFF) end -= 1
    }
    return { ok: true, tab, title: '测试页', textLength: text.length, offset, text: text.slice(offset, end), truncated: end < text.length, nextOffset: end < text.length ? end : null }
  })
  const r1 = await performAction(bridge, 'read', {}, { root: 'C:/tmp/chrome-test' })
  ok(r1.ok, 'read 成功')
  ok(/正文 11002 字 · 本次第 0–6000 字，还有下文/.test(r1.message), '页头带总数与窗口', r1.message.split('\n')[2])
  ok(/offset:6000/.test(r1.message), '给出下一次 offset', r1.message.split('\n').slice(-2).join(' | '))
  ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r1.message), '没有孤立高位代理')

  const r2 = await performAction(bridge, 'read', { offset: 6000, maxChars: 500 }, { root: 'C:/tmp/chrome-test' })
  ok(/本次第 6000–6500 字/.test(r2.message), '第二页窗口正确', r2.message.split('\n')[2])
}

/* 2. 截断不切半个 emoji（clip 走 safeSlice） */
{
  console.log('2) 截断安全')
  const bridge = fakeBridge(() => ({ ok: true, tab, url: 'https://e.com', title: 't', textLength: 4, offset: 0, text: 'ab😀cd', truncated: false }))
  const r = await performAction(bridge, 'read', { maxChars: 500 }, { root: 'C:/tmp/chrome-test' })
  ok(r.ok, 'read 成功')
  ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.message), '正文里代理对完整')
}

/* 3. outline 渲染 */
{
  console.log('3) outline')
  const bridge = fakeBridge((action) => {
    if (action !== 'outline') throw new Error('unexpected ' + action)
    return {
      ok: true, tab, url: 'https://e.com', title: 't', total: 3, shown: 2, skippedInvisible: 1, truncated: true,
      rows: [
        { ref: 'e1', role: 'button', name: '登录', tag: 'button' },
        { ref: 'e2', role: 'link', name: '帮助', tag: 'a', href: '/help' },
      ],
    }
  })
  const r = await performAction(bridge, 'outline', {}, { root: 'C:/tmp/chrome-test' })
  ok(r.ok, 'outline 成功')
  ok(/e1 button 登录/.test(r.message), 'ref 行格式（紧凑）', r.message.split('\n')[2])
  ok(/→ \/help/.test(r.message), '链接带 href')
  ok(!/接下来直接用 ref/.test(r.message), '不再带尾巴提示（省 90 字符/次）')
  ok(/可交互元素 3 个，列 2 个（跳过 1 个隐藏/.test(r.message), '计数与隐藏说明', r.message.split('\n')[1])
}

/* 4. ref 失效 → REF_STALE + 下一步 */
{
  console.log('4) ref 失效')
  const bridge = fakeBridge(() => { const e = new Error('ref e9 找不到'); e.errorCode = 'REF_STALE'; throw e })
  const r = await performAction(bridge, 'click', { ref: 'e9' }, { root: 'C:/tmp/chrome-test' })
  ok(!r.ok, 'click 失败')
  ok(/\[REF_STALE\]/.test(r.message), '错误码可见', r.message)
  ok(/重新 action=outline/.test(r.message), '带下一步建议', r.message)
}

/* 5. 写操作超时 → effectState=unknown；只读超时不给这句 */
{
  console.log('5) 超时语义')
  const timeout = () => { const e = new Error('命令超时（30000ms）：扩展连着但没在时限内回话'); e.errorCode = 'COMMAND_TIMEOUT'; throw e }
  const rw = await performAction(fakeBridge(timeout), 'click', { text: '提交' }, { root: 'C:/tmp/chrome-test' })
  ok(/effectState=unknown/.test(rw.message), '写操作提示可能已生效', rw.message)
  ok(rw.detail.effectState === 'unknown', 'detail 里也记了')
  const rr = await performAction(fakeBridge(timeout), 'read', {}, { root: 'C:/tmp/chrome-test' })
  ok(!/effectState=unknown/.test(rr.message), '只读动作不提「可能已生效」', rr.message)
  ok(/\[COMMAND_TIMEOUT\]/.test(rr.message), '只读也报错误码')
}

/* 6. cookies 渲染 */
{
  console.log('6) cookies')
  const bridge = fakeBridge((action, p) => {
    if (action !== 'cookies') throw new Error('unexpected ' + action)
    return { ok: true, tab, url: 'https://e.com', count: 2, cookies: [
      { name: 'sid', domain: '.e.com', path: '/', httpOnly: true, secure: true, expirationDate: 1790000000 },
      { name: 'lang', domain: '.e.com', path: '/', httpOnly: false, secure: false },
    ] }
  })
  const r = await performAction(bridge, 'cookies', {}, { root: 'C:/tmp/chrome-test' })
  ok(r.ok, 'cookies 成功')
  ok(/· sid @\.e\.com\/ httpOnly secure 到期/.test(r.message), 'cookie 行格式', r.message.split('\n')[2])
  ok(!/值=/.test(r.message), '默认不回值')
}

/* 7. 未知 action 不炸 */
{
  const r = await performAction(fakeBridge(() => ({ ok: true })), 'nope', {}, { root: 'C:/tmp/chrome-test' })
  ok(!r.ok && /不认识的 action/.test(r.message), '未知 action 明确报错')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
