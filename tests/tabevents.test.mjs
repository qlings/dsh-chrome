/**
 * tabevents 的自测：标签页开/关留证。
 *
 * 为什么值得测：这套东西只在「页面自己 window.close() 把标签关掉」时才有价值
 * （2026-11-23 排查产成品入库重新推送那次），现场一过就没了，靠人工复现几乎不可能。
 */
let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

const listeners = { created: [], updated: [], activated: [], removed: [] }
const fakeChrome = {
  tabs: {
    async query() { return [{ id: 100, url: 'http://a/', title: '已有标签' }] },
    onCreated: { addListener: (fn) => listeners.created.push(fn) },
    onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    onActivated: { addListener: (fn) => listeners.activated.push(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
  },
  // cdp.js 在模块加载时就要用 chrome.debugger 注册监听，缺了会 ReferenceError
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
}
globalThis.chrome = fakeChrome

const { initTabEvents, readTabEvents } = await import('../extension/tabevents.js')

initTabEvents({ chromeApi: fakeChrome })
initTabEvents({ chromeApi: fakeChrome }) // 幂等：不能重复注册

ok(listeners.created.length === 1, '监听只注册一次', listeners.created.length)

console.log('1) 新建标签：记下 opener 和地址')
{
  listeners.created[0]({ id: 200, openerTabId: 100, url: '', pendingUrl: 'http://a/detail' })
  const r = readTabEvents({ op: 'list' })
  const ev = r.events[r.events.length - 1]
  ok(ev.kind === 'created' && ev.tabId === 200, 'created 事件', ev)
  ok(ev.openerTabId === 100, 'opener 记到了', ev.openerTabId)
  ok(String(ev.url).includes('detail'), 'pendingUrl 也当地址用', ev.url)
}

console.log('2) 关闭标签：留证 + 存活时长 + 能按 tabId 取回')
{
  // 先给这个标签一条「加载完」，模拟真实时序
  listeners.updated[0](200, { status: 'complete' }, { id: 200, url: 'http://a/detail', title: '出库单' })
  // 再模拟它被自己 window.close() 关掉
  listeners.removed[0](200, { isWindowClosing: false })
  const list = readTabEvents({ op: 'list' })
  const closed = list.closed.find((x) => x.tabId === 200)
  ok(Boolean(closed), '已关闭列表里有它', list.closed)
  ok(closed.title === '出库单', '标题留了下来', closed.title)
  ok(typeof closed.livedMs === 'number' && closed.livedMs >= 0, '有存活时长', closed.livedMs)

  const one = readTabEvents({ op: 'get', tabId: 200 })
  ok(one.found === true, 'op=get 找得到', one)
  ok(one.networkCount === 0, '没有网络记录时是 0 而不是报错', one.networkCount)
  ok(one.url.includes('detail'), 'URL 也在', one.url)
}

console.log('3) 不存在的 tabId：如实说明，不抛异常')
{
  const r = readTabEvents({ op: 'get', tabId: 999 })
  ok(r.found === false, 'found=false')
  ok(typeof r.note === 'string' && r.note.length > 0, '给了说明', r.note)
  ok(Array.isArray(r.kept), '还列出了留着哪些', r.kept)
}

console.log('4) op=net 对没有网络记录的标签不炸')
{
  const r = readTabEvents({ op: 'net', tabId: 200, filter: 'x' })
  ok(r.found === true && Array.isArray(r.rows), '返回空数组', r.rows)
}

console.log('5) 清理')
{
  const r = readTabEvents({ op: 'clear' })
  ok(r.cleared.closed >= 1, '清掉了留证', r.cleared)
  ok(readTabEvents({ op: 'list' }).closed.length === 0, '清空后没了')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
