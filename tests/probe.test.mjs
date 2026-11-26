/**
 * probe.js 自测（1.11.1）：假 window / fetch / XHR，验三件事——
 *   1. fetch 和 XHR 的请求头都记下来了；
 *   2. authorization / cookie 这类凭据**一个字都不落**（名字和值都不留）；
 *   3. Bearer / JWT 形状的值，就算挂了个无害的头名，也打成 ***。
 *
 * 为什么值得单独测：探针是常驻页面世界的黑匣子，写坏了会一直毒化后面所有请求记录，
 * 而它又不在任何一条正常路径上，跑测试最难覆盖。
 */
const okdb = []
let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

/* ---------------- 假环境（必须在 import probe.js 之前装好） ---------------- */
class FakeXHR {
  constructor() { this.headers = {}; this.listeners = {}; this.status = 200 }
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(k, v) { this.headers[k] = v }
  send(body) { this.sentBody = body; this.done = true }
  addEventListener(name, fn) { this.listeners[name] = fn }
  getResponseHeader(k) {
    return { 'content-type': 'application/json', 'content-length': '77' }[String(k).toLowerCase()] || null
  }
}
globalThis.XMLHttpRequest = FakeXHR
globalThis.location = { href: 'https://example.com/page' }
globalThis.URL = URL
const fakeWindow = {
  addEventListener() {},
  fetch: async () => ({ status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : k === 'content-length' ? '120' : null) } }),
}
globalThis.window = fakeWindow

await import('../extension/probe.js')

/* ------------------------------ 1. fetch 请求头 ------------------------------ */
console.log('1) fetch：头记下来了，凭据不落地')
{
  await fakeWindow.fetch('https://example.com/api/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      moduleCode: 'LIM_InspReportQuery',
      'X-Function-Code': 'LIM_InspReportQuery',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      Cookie: 'session=abc',
    },
    body: '{"pageIndex":1}',
  })
  const rows = fakeWindow.__dshProbe.net
  const row = rows[rows.length - 1]
  ok(rows.length === 1, '记到一条', rows.length)
  ok(row.method === 'POST' && /query$/.test(row.url), '方法/URL 对', row.method + ' ' + row.url)
  ok(row.headers && row.headers.moduleCode === 'LIM_InspReportQuery', 'moduleCode 记到了', JSON.stringify(row.headers))
  ok(row.headers['X-Function-Code'] === 'LIM_InspReportQuery', 'X-Function-Code 记到了')
  ok(!('Authorization' in row.headers) && !('Cookie' in row.headers), '凭据头整条丢掉', JSON.stringify(row.headers))
  ok(!JSON.stringify(row).includes('eyJhbGci'), 'JWT 没留在任何字段里')
  ok(row.body === '{"pageIndex":1}', '请求体照旧记着')
}

/* ------------------------------ 2. XHR 请求头 ------------------------------ */
console.log('2) XHR：setRequestHeader 攒下来的头也记')
{
  const xhr = new FakeXHR()
  xhr.open('POST', '/api/v1/lim/v_lim_inspreportdtl/querypower')
  xhr.setRequestHeader('Content-Type', 'application/json')
  xhr.setRequestHeader('X-Operator', '%E9%A9%AC%E7%90%B3')
  xhr.setRequestHeader('authorization', 'Bearer abc.def.ghi')
  xhr.send('{"pageIndex":1,"pageSize":20}')
  xhr.listeners.loadend()
  const rows = fakeWindow.__dshProbe.net
  const row = rows[rows.length - 1]
  ok(row.type === 'xhr' && row.status === 200, 'XHR 行记下来了', JSON.stringify(row).slice(0, 120))
  ok(row.headers['X-Operator'] === '%E9%A9%AC%E7%90%B3', 'X-Operator 记到了')
  ok(!row.headers.authorization && !row.headers.Authorization, '小写 authorization 也丢掉')
  ok(row.body === '{"pageIndex":1,"pageSize":20}', 'XHR 请求体记着')
}

/* ------------------------------ 3. 隐蔽凭据 ------------------------------ */
console.log('3) 值像凭据的，不管头名一律 ***')
{
  const xhr = new FakeXHR()
  xhr.open('GET', '/api/other')
  xhr.setRequestHeader('X-Trace-Token', 'Bearer 8f3a9c')
  xhr.send()
  xhr.listeners.loadend()
  const rows = fakeWindow.__dshProbe.net
  const row = rows[rows.length - 1]
  ok(row.headers['X-Trace-Token'] === '***（凭据，已脱敏）', 'Bearer 值被打码', row.headers['X-Trace-Token'])
}

/* ------------------------------ 4. 开关 ------------------------------ */
console.log('4) window.__dshProbeHeaderLimit = 0 时不记头')
{
  fakeWindow.__dshProbeHeaderLimit = 0
  const xhr = new FakeXHR()
  xhr.open('GET', '/api/no-headers')
  xhr.setRequestHeader('X-Foo', 'bar')
  xhr.send()
  xhr.listeners.loadend()
  const rows = fakeWindow.__dshProbe.net
  const row = rows[rows.length - 1]
  ok(!row.headers, '关掉后没有 headers 字段', JSON.stringify(row.headers))
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
