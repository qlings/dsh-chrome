// 1.11.0 新能力自测：inPageNetBlock（拦请求/只登记）+ inPageEval 的 pick 投影。
// 假 window：给一个记录型 fetch 和 XHR，验的是「规则命中才拦、拦了不发、记录里带请求体」。
import '../extension/page.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

/* ---------------- 假 window / document ---------------- */
const calls = { fetch: [], xhr: [] }
class FakeXHR {
  constructor() { this.readyState = 0; this.status = 0; this.events = [] }
  open(method, url) { this.method = method; this.url = url }
  send(body) { calls.xhr.push({ method: this.method, url: this.url, body }) }
  dispatchEvent(e) { this.events.push(e && e.type) ; return true }
  addEventListener() {}
  getResponseHeader() { return '' }
}
const fakeFetch = (input, init) => {
  calls.fetch.push({ url: typeof input === 'string' ? input : input && input.url, init })
  return Promise.resolve({ status: 200, headers: { get: () => '' } })
}

const body = { innerText: '', querySelectorAll: () => [] }
globalThis.window = {
  fetch: fakeFetch,
  XMLHttpRequest: FakeXHR,
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  getSelection: () => '',
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600,
}
globalThis.document = { title: 't', readyState: 'complete', body, documentElement: body, querySelector: () => null, querySelectorAll: () => [] }
globalThis.location = { href: 'https://example.com/page' }
globalThis.CSS = { escape: (s) => String(s) }
globalThis.Event = class { constructor(type) { this.type = type } }
globalThis.ProgressEvent = class { constructor(type) { this.type = type } }
globalThis.MouseEvent = class { constructor(type) { this.type = type } }
globalThis.KeyboardEvent = class { constructor(type) { this.type = type } }
globalThis.InputEvent = class { constructor(type) { this.type = type } }

const P = globalThis.__dshPage
const tick = () => new Promise((r) => setTimeout(r, 5))

/* ---------------- 1. set：block 模式 ---------------- */
console.log('1) netBlock · set(block)')
{
  const set = P.inPageNetBlock({ op: 'set', patterns: ['update_template', '/api/v1/wf/'] })
  ok(set.ok === true, 'set 成功', JSON.stringify(set))
  ok(set.mode === 'block', '默认 block 模式', set.mode)
  ok(set.rules.length === 2, '规则编译了两条', JSON.stringify(set.rules))
  ok(window.__dshNetBlock.installed === true, '已装钩子')

  const p = window.fetch('/api/v1/wf/update_template', { method: 'POST', body: '{"nodes":[1,2]}' })
  const rejected = await p.then(() => false, () => true)
  ok(rejected === true, '命中规则的 fetch 被 reject（不是假装成功）')
  ok(calls.fetch.length === 0, '被拦的请求没有真的发出去', String(calls.fetch.length))

  const pass = await window.fetch('/api/v1/sm/sm_role/query', { method: 'POST', body: '{}' })
  ok(pass.status === 200 && calls.fetch.length === 1, '不命中的请求照常放行')

  const hits = P.inPageNetBlock({ op: 'hits' })
  ok(hits.total === 1 && hits.hits.length === 1, '记录里只有 1 条（放行的不记）', String(hits.total))
  ok(hits.hits[0].body === '{"nodes":[1,2]}', '请求体记下来了', hits.hits[0].body)
  ok(hits.hits[0].blocked === true, '标了 blocked')
  ok(hits.hits[0].method === 'POST', '方法记对了')
}

/* ---------------- 2. dryRun：非 GET 全拦 ---------------- */
console.log('2) netBlock · dryRun')
{
  P.inPageNetBlock({ op: 'off' })
  calls.fetch.length = 0
  const set = P.inPageNetBlock({ op: 'set', dryRun: true })
  ok(set.ok === true && set.dryRun === true, 'dryRun 装上了')
  await window.fetch('/whatever', { method: 'POST', body: 'x' }).then(() => {}, () => {})
  await window.fetch('/whatever', { method: 'GET' }).then(() => {}, () => {})
  ok(calls.fetch.length === 1 && calls.fetch[0].init.method === 'GET', 'POST 被拦、GET 放行', JSON.stringify(calls.fetch))
  const hits = P.inPageNetBlock({ op: 'hits' })
  ok(hits.total === 1 && /whatever/.test(hits.hits[0].url), 'dryRun 也记录了命中')
}

/* ---------------- 3. XHR：不发、但派发 error/loadend ---------------- */
console.log('3) netBlock · XHR')
{
  P.inPageNetBlock({ op: 'off' })
  calls.xhr.length = 0
  P.inPageNetBlock({ op: 'set', patterns: ['savedata'] })
  const xhr = new window.XMLHttpRequest()
  xhr.open('POST', '/api/savedata')
  xhr.send('{"a":1}')
  await tick()
  ok(calls.xhr.length === 0, 'XHR 没有真的 send', String(calls.xhr.length))
  ok(xhr.events.includes('error') && xhr.events.includes('loadend'), '派发了 error + loadend（调用方不会挂死）', JSON.stringify(xhr.events))

  const okXhr = new window.XMLHttpRequest()
  okXhr.open('GET', '/api/list')
  okXhr.send()
  ok(calls.xhr.length === 1 && calls.xhr[0].url === '/api/list', '不命中的 XHR 照常发')
}

/* ---------------- 4. off：解除 ---------------- */
console.log('4) netBlock · off')
{
  const off = P.inPageNetBlock({ op: 'off' })
  ok(off.ok === true, 'off 成功')
  ok(P.inPageNetBlock({ op: 'hits' }).total === 0, '记录清空')
  calls.fetch.length = 0
  const r = await window.fetch('/api/v1/wf/update_template', { method: 'POST' })
  ok(r.status === 200 && calls.fetch.length === 1, '解除后同一条请求放行')
}

/* ---------------- 5. 参数缺失要明确报错 ---------------- */
console.log('5) netBlock · 参数校验')
{
  const bad = P.inPageNetBlock({ op: 'set' })
  ok(bad.ok === false && bad.errorCode === 'BAD_ARGS', '没有 patterns 也没有 dryRun → BAD_ARGS')
}

/* ---------------- 6. eval 的 pick 投影 ---------------- */
console.log('6) inPageEval · pick')
{
  const data = { data: { nodes: [{ id: 'a', roles: 'x,y' }, { id: 'b', roles: 'z' }] } }
  window.__dshPickData = data
  const one = P.inPageEval({ code: 'window.__dshPickData', pick: 'data.nodes[1].id' })
  ok(one.ok === true && one.value === 'b', 'pick 取数组下标', JSON.stringify(one.value))
  ok(one.picked === 'data.nodes[1].id', '回执里带上 picked（说明用了投影）', String(one.picked))

  const ids = P.inPageEval({ code: 'window.__dshPickData', pick: 'data.nodes[*].id' })
  ok(Array.isArray(ids.value) && ids.value.join(',') === 'a,b', 'pick 的 * 逐项取', JSON.stringify(ids.value))

  const obj = P.inPageEval({ code: 'window.__dshPickData', pick: 'data.nodes[*]' })
  ok(Array.isArray(obj.value) && obj.value.length === 2 && obj.value[0].roles === 'x,y', 'pick 取整项')

  const bad = P.inPageEval({ code: 'window.__dshPickData', pick: 'no.such.path' })
  ok(bad.ok === true, '路径不存在也返回 ok（不把 eval 判失败）')
  ok(bad.value === undefined || bad.type === 'undefined', '路径不存在 → undefined', JSON.stringify(bad.value))

  const noPick = P.inPageEval({ code: 'window.__dshPickData' })
  ok(noPick && noPick.value && noPick.value.data, '不传 pick 行为不变')
}

/* ---------------- 7. 唯一可见元素自动选中 ---------------- */
console.log('7) locate · 唯一可见优先')
{
  const mk = (visible) => {
    const el = {
      tagName: 'DIV',
      innerText: visible ? '可见浮层' : '隐藏浮层',
      value: '',
      disabled: false,
      className: '',
      id: '',
      getClientRects: () => (visible ? [{ width: 100, height: 40 }] : []),
      offsetWidth: visible ? 100 : 0,
      offsetHeight: visible ? 40 : 0,
      isConnected: true,
      ownerDocument: globalThis.document,
      scrollIntoView() {},
      focus() {},
      dispatchEvent() { return true },
      getBoundingClientRect: () => ({ width: 100, height: 40, left: 0, top: 0 }),
      querySelectorAll: () => [],
      querySelector: () => null,
      parentElement: null,
      click() { this.clickedCount = (this.clickedCount || 0) + 1 },
      getAttribute: () => null,
      setAttribute() {},
      closest: () => null,
    }
    return el
  }
  const visibleEl = mk(true)
  const hiddenEl = mk(false)
  const prevQSA = document.querySelectorAll
  document.querySelectorAll = (sel) => (sel === '.popper' ? [hiddenEl, visibleEl] : [])
  document.querySelector = (sel) => (sel === '.popper' ? hiddenEl : null)
  const r = P.inPageClick({ selector: '.popper' })
  ok(r.ok === true, '只有一个可见时点得动', JSON.stringify(r).slice(0, 160))
  ok(r.how === 'selector+visible' && r.autoVisible === true, '回执说明是按可见性自动选的')
  ok(visibleEl.clickedCount === 1 && !hiddenEl.clickedCount, '点的是可见的那个')

  // 两个都可见：仍然 MULTI_MATCH
  const v2 = mk(true)
  document.querySelectorAll = (sel) => (sel === '.popper' ? [visibleEl, v2] : [])
  const multi = P.inPageClick({ selector: '.popper' })
  ok(multi.ok === false && multi.errorCode === 'MULTI_MATCH', '两个都可见仍然 MULTI_MATCH')
  document.querySelectorAll = prevQSA
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
