/**
 * CDP 通道 + 事件化导航的自测（无浏览器）。
 *
 * 假 chrome.* API：debugger.attach/sendCommand/onEvent 全部可控，
 * 导航事件按剧本注入，验的是「到达判定」和「命令参数对不对」。
 */
import { execFileSync } from 'node:child_process'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

/* ------------------------------ 假 chrome ------------------------------ */
const sent = []
let attachError = ''
let hangMethod = ''
let hangWhen = null
let errorPage = false
let navPlan = []
let tabState = { id: 7, windowId: 1, index: 0, active: true, title: '测试页', url: 'https://example.com/a', status: 'complete' }
const eventListeners = []
const detachListeners = []

function emit(method, params) {
  for (const fn of eventListeners) fn({ tabId: tabState.id }, method, params)
}

function responder(method, params) {
  if (hangMethod && method === hangMethod && (!hangWhen || hangWhen(params || {}))) return new Promise(() => {})
  switch (method) {
    case 'Performance.getMetrics':
      return {
        metrics: [
          { name: 'Nodes', value: 1200 }, { name: 'Documents', value: 1 }, { name: 'Frames', value: 2 },
          { name: 'JSEventListeners', value: 340 }, { name: 'LayoutCount', value: 12 }, { name: 'RecalcStyleCount', value: 30 },
          { name: 'LayoutDuration', value: 0.0432 }, { name: 'ScriptDuration', value: 1.234 }, { name: 'TaskDuration', value: 2.5 },
          { name: 'JSHeapUsedSize', value: 12 * 1048576 },
        ],
      }
    case 'Page.printToPDF': return { data: Buffer.from('%PDF-1.4 fake').toString('base64') }
    case 'Page.captureSnapshot': return { data: 'From: <Saved by Blink>\r\n\r\nhello' }
    case 'Page.captureScreenshot': return { data: 'iVBORw0KGgo=' }
    case 'DOM.getDocument': return { root: { nodeId: 1 } }
    case 'DOM.querySelector': return { nodeId: params.selector === '#missing' ? 0 : 42 }
    case 'Page.getNavigationHistory': return { currentIndex: 0, entries: [{ url: 'https://example.com/a', title: '测试页' }] }
    case 'Network.getResponseBody': return { body: '{"ok":true,"rows":3}', base64Encoded: false }
    default: return {}
  }
}

globalThis.chrome = {
  runtime: {
    id: 'test-ext', getManifest: () => ({ version: '1.3.0' }),
    getPlatformInfo: async () => ({ os: 'win' }),
    onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
  },
  tabs: {
    async get(id) { return { ...tabState, id } },
    async query() { return [tabState] },
    async update(id, props) {
      if (props.url) {
        tabState = { ...tabState, url: props.url, status: 'loading' }
        for (const step of navPlan) setTimeout(() => { if (step.url) tabState = { ...tabState, url: step.url }; emit(step.method, step.params || {}) }, step.at)
        if (navPlan.some((s) => s.method === 'Page.loadEventFired')) {
          setTimeout(() => { tabState = { ...tabState, status: 'complete' } }, 5)
        }
      }
      if (props.active != null) tabState = { ...tabState, active: props.active }
      return tabState
    },
    async create(props) {
      tabState = { id: 8, windowId: 1, index: 1, active: true, title: '', url: props.url, status: 'loading' }
      return tabState
    },
    async remove() {}, async reload() {}, async goBack() {}, async goForward() {},
    sendMessage(id, msg, opts, cb) { if (cb) cb({ ok: false, errorCode: 'NO_CONTENT_SCRIPT', error: 'no cs' }) },
    onActivated: { addListener() {} }, onUpdated: { addListener() {} },
  },
  windows: {
    async getAll() { return [{ id: 1, focused: true, state: 'normal', type: 'normal' }] },
    async update() {}, async create() { return { id: 2, tabs: [{ id: 9, windowId: 2 }] } },
  },
  alarms: { async create() {}, onAlarm: { addListener() {} } },
  storage: { local: { async get() { return {} }, async set() {} } },
  cookies: { async getAll() { return [] } },
  scripting: {
    async executeScript(opts) {
      if (errorPage) throw new Error('Frame with ID 0 is showing error page')
      const src = String((opts && opts.func) || '')
      if (src.includes('innerHTML.length')) return [{ result: true }]   // documentAlive 探针
      return [{ result: { ok: false, errorCode: 'INJECT_FAILED', error: 'fake: 这个页面注入不了' } }]
    },
  },
  debugger: {
    async attach() { if (attachError) throw new Error(attachError) },
    async detach() {},
    async sendCommand(target, method, params) { sent.push({ method, params }); return responder(method, params || {}) },
    onEvent: { addListener(fn) { eventListeners.push(fn) } },
    onDetach: { addListener(fn) { detachListeners.push(fn) } },
  },
}

const { runCommand } = await import('../extension/executor.js')
const cdpMod = await import('../extension/cdp.js')
const call = async (action, params = {}) => runCommand({ action, params })

const reset = () => {
  sent.length = 0
  navPlan = []
  attachError = ''
  tabState = { id: 7, windowId: 1, index: 0, active: true, title: '测试页', url: 'https://example.com/a', status: 'complete' }
}
const cmds = (method) => sent.filter((c) => c.method === method)

/* ------------------------------ 1. 能力握手 ------------------------------ */
console.log('1) ping / 能力握手')
reset()
{
  const r = await call('ping')
  ok(r.ok === true, 'ping 成功')
  ok(r.data.cdp && r.data.cdp.available === true, '报了 cdp 可用')
  ok((r.data.cdp.capabilities || []).includes('press'), 'capabilities 里有 press', JSON.stringify(r.data.cdp.capabilities))
  ok((r.data.cdp.capabilities || []).length >= 12, 'capabilities 数量', String(r.data.cdp.capabilities.length))
}

/* ------------------------------ 2. 导航：完整到达 ------------------------------ */
console.log('2) navigate · waitUntil=load（commit→dcl→load 全来）')
reset()
navPlan = [
  { at: 10, method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.com/b' } } },
  { at: 20, method: 'Page.domContentEventFired', params: {} },
  { at: 30, method: 'Page.loadEventFired', params: {} },
]
{
  const r = await call('navigate', { tabId: 7, url: 'https://example.com/b' })
  ok(r.ok === true, 'navigate 成功')
  ok(r.data.landed === true, 'landed=true', JSON.stringify({ landed: r.data.landed, reason: r.data.reason }))
  ok(r.data.waitUntil === 'load', 'waitUntil=load')
  ok(r.data.commit === true && r.data.dcl === true && r.data.load === true, '三段事件都记到了')
  ok(r.data.waitedMs >= 20 && r.data.waitedMs < 3000, '耗时是事件驱动的（不是死等）', String(r.data.waitedMs))
  ok(cmds('Page.enable').length === 1, 'Page.enable 只发一次')
  ok(cmds('Page.enable')[0] && cmds('Page.enable')[0].params && Object.keys(cmds('Page.enable')[0].params).length === 0, 'Page.enable 参数为空对象')
}

/* ------------------------------ 3. 导航：只提交，load 没来 ------------------------------ */
console.log('3) navigate · 只来了 commit，预算内没 load → 诚实报 loadPending')
reset()
navPlan = [{ at: 10, method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.com/slow' } } }]
{
  const r = await call('navigate', { tabId: 7, url: 'https://example.com/slow', timeoutMs: 250 })
  ok(r.data.landed === false, 'landed=false')
  ok(r.data.loadPending === true, 'loadPending=true')
  ok(r.data.commit === true && r.data.load === false, 'commit 有、load 没有')
  ok(r.data.reason === 'budget-spent', '原因是预算用完', String(r.data.reason))
}

/* ------------------------------ 4. 导航：同文档 ------------------------------ */
console.log('4) navigate · 同一个地址（同文档跳转）')
reset()
tabState = { ...tabState, url: 'https://example.com/page#top', status: 'complete' }
navPlan = [{ at: 10, method: 'Page.navigatedWithinDocument', params: { url: 'https://example.com/page#section' } }]
{
  const r = await call('navigate', { tabId: 7, url: 'https://example.com/page#section', timeoutMs: 400 })
  ok(r.data.landed === true, '地址对上了就算到达（不报假失败）')
  ok(r.data.sameDocument === true, '标明 sameDocument')
  ok(r.data.waitedMs < 300, '没白等满预算', String(r.data.waitedMs))
}

/* ------------------------------ 5. 导航：CDP 挂不上 → 轮询兜底 ------------------------------ */
console.log('5) navigate · CDP 挂不上时退回轮询，并说明原因')
reset()
await call('detach', { tabId: 7 })
attachError = 'Cannot attach to this target'
tabState = { ...tabState, status: 'complete' }
{
  const r = await call('navigate', { tabId: 7, url: 'https://example.com/c', timeoutMs: 300 })
  ok(r.ok === true, 'navigate 没整条失败')
  ok(r.data.via === 'poll', 'via=poll', String(r.data.via))
  ok(/Cannot attach/.test(r.data.cdpFallback || ''), '把挂不上的原因带回来了', String(r.data.cdpFallback))
}

/* ------------------------------ 5b. 地址没变但页面已死（错误页） ------------------------------ */
console.log('5b) navigate · 同地址但当前是错误页 → 必须真的重新导航')
reset()
errorPage = true
tabState = { ...tabState, url: 'http://127.0.0.1:18799/', status: 'complete' }
navPlan = [
  { at: 10, method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'http://127.0.0.1:18799/' } } },
  { at: 20, method: 'Page.loadEventFired', params: {} },
]
{
  const r = await call('navigate', { tabId: 7, url: 'http://127.0.0.1:18799/', timeoutMs: 500 })
  ok(r.data.commit === true, '真的走了导航（commit 事件到了），没被「地址一样」骗过去', JSON.stringify({ commit: r.data.commit, sameDocument: r.data.sameDocument }))
  ok(r.data.sameDocument === false, '没有标 sameDocument')
}
errorPage = false
/* ------------------------------ 6. 错误页 ------------------------------ */
console.log('6) navigate · 落到 chrome-error')
reset()
navPlan = [
  { at: 10, url: 'chrome-error://chromewebdata/', method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'chrome-error://chromewebdata/' } } },
  { at: 20, method: 'Page.loadEventFired', params: {} },
]
{
  const r = await call('navigate', { tabId: 7, url: 'https://no-such-host.invalid/', timeoutMs: 500 })
  ok(r.data.landed === true, '事件到了（错误页也是文档）')
  ok(r.data.siteUnreachable && r.data.siteUnreachable.reason, '报了 siteUnreachable', JSON.stringify(r.data.siteUnreachable))
}

/* ------------------------------ 7. press ------------------------------ */
console.log('7) press · 真实键盘')
reset()
{
  const r = await call('press', { tabId: 7, key: 'Enter' })
  const down = cmds('Input.dispatchKeyEvent')
  ok(r.ok === true && r.data.pressed.key === 'Enter', '回车按下去了')
  ok(down.length === 2, '正好两个事件（keyDown + keyUp），不重复插字符', String(down.length))
  ok(down[0].params.type === 'keyDown' && down[0].params.text === '\r', 'Enter 带 \\r 文本（表单会提交）')
  ok(down[1].params.type === 'keyUp', '第二下是 keyUp')
}
reset()
{
  const r = await call('press', { tabId: 7, key: 'Ctrl+A' })
  const down = cmds('Input.dispatchKeyEvent')
  ok(r.data.pressed.modifiers.includes('ctrl'), '认出了 ctrl')
  ok(r.data.pressed.inserted === false, '组合键不插字符', String(r.data.pressed.inserted))
  ok(down[0].params.type === 'rawKeyDown' && down[0].params.text === undefined, '用 rawKeyDown、无 text（才会被当成全选）')
  ok(down[0].params.modifiers === 2, 'ctrl 修饰位 = 2', String(down[0].params.modifiers))
  ok(down[0].params.key === 'a', '快捷键里的字母是小写 key', String(down[0].params.key))
}
reset()
{
  const r = await call('press', { tabId: 7, key: 'A' })
  const single = cmds('Input.dispatchKeyEvent')
  ok(r.data.pressed.inserted === true, '单字符插入')
  ok(single[0].params.key === 'A', '不带修饰键就保留大小写', String(single[0].params.key))
}
reset()
{
  const bad = await call('press', { tabId: 7, key: 'Ctrl+NoSuchKey' })
  ok(bad.ok === false && bad.errorCode === 'BAD_ARGS', '不认识的键明确报错', JSON.stringify(bad.errorCode))
}

/* ------------------------------ 7b. 聚焦失败要带错误码 ------------------------------ */
console.log('7b) press · 聚焦失败保留原始错误码')
reset()
{
  const r = await call('press', { tabId: 7, ref: 'e9', key: 'Enter' })
  ok(r.ok === false, '按不下去')
  ok(['NO_CONTENT_SCRIPT', 'REF_STALE', 'INJECT_FAILED'].includes(r.errorCode), '不是笼统的 COMMAND_FAILED', String(r.errorCode))
}
/* ------------------------------ 8. 原生弹窗 ------------------------------ */
console.log('8) dialog · 默认自动按 OK')
reset()
{
  emit('Page.javascriptDialogOpening', { type: 'confirm', message: '确定删除？', defaultPrompt: '' })
  await new Promise((r) => setTimeout(r, 30))
  const handles = cmds('Page.handleJavaScriptDialog')
  ok(handles.length === 1, '自动应答了一次', String(handles.length))
  ok(handles[0].params.accept === true, '默认 accept')

  const got = await call('dialog', { tabId: 7 })
  ok(got.data.rows.length === 1 && got.data.rows[0].message === '确定删除？', '弹窗记录读得到')
  ok(got.data.policy.mode === 'accept', '策略默认 accept')

  const set = await call('dialog', { tabId: 7, action: 'set', mode: 'manual' })
  ok(set.data.policy.mode === 'manual', '能改策略')
  sent.length = 0
  emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hello' })
  await new Promise((r) => setTimeout(r, 30))
  ok(cmds('Page.handleJavaScriptDialog').length === 0, 'manual 下不自动应答')
}

/* ------------------------------ 9. console / 网络 ------------------------------ */
console.log('9) logs / networkLog · 抓得到、格式对')
reset()
{
  emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: '接口 500' }, { value: ' /api/x' }], stackTrace: { callFrames: [{ url: 'https://example.com/app.js' }] } })
  emit('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR', request: { method: 'POST', url: 'https://example.com/api/x' } })
  emit('Network.responseReceived', { requestId: 'r1', response: { status: 500, mimeType: 'application/json' } })
  await new Promise((r) => setTimeout(r, 20))
  const logs = await call('logs', { tabId: 7, limit: 10 })
  ok(logs.data.rows.length === 1, 'console 抓到 1 条', String(logs.data.rows.length))
  ok(logs.data.rows[0].level === 'error' && /接口 500/.test(logs.data.rows[0].text), '内容与级别对')
  const net = await call('networkLog', { tabId: 7, limit: 10 })
  ok(net.data.rows.length === 1 && net.data.rows[0].status === 500, '网络行带状态码')
  ok(net.data.rows[0].method === 'POST', '方法对')
  const filtered = await call('networkLog', { tabId: 7, filter: 'nomatch' })
  ok(filtered.data.rows.length === 0, 'filter 生效')
  const cleared = await call('networkClear', { tabId: 7 })
  ok(cleared.data.cleared === 1, '清空回报清了几条')
}

/* ------------------------------ 10. 导出 / 上传 / 截图 ------------------------------ */
console.log('10) pdf / mhtml / 整页截图 / upload / metrics')
reset()
{
  const pdf = await call('pdf', { tabId: 7 })
  ok(pdf.ok === true && /Page.printToPDF/.test(sent.map((c) => c.method).join(',')), '走了 Page.printToPDF')
  const mh = await call('mhtml', { tabId: 7 })
  ok(mh.ok === true && cmds('Page.captureSnapshot').length === 1, '走了 Page.captureSnapshot')
  const shot = await call('screenshot', { tabId: 7, fullPage: true })
  const cap = cmds('Page.captureScreenshot')[0]
  ok(shot.ok === true && /^data:image\/png;base64,/.test(shot.data.dataUrl), '整页截图回了 dataUrl')
  ok(cap && cap.params.captureBeyondViewport === true, 'captureBeyondViewport=true')
  const front = sent.findIndex((c) => c.method === 'Page.bringToFront')
  const capIndex = sent.findIndex((c) => c.method === 'Page.captureScreenshot')
  ok(front >= 0 && front < capIndex, '截图前先 bringToFront（否则标签被盖住时永远不返回）')
  const jpg = await call('screenshot', { tabId: 7, selector: '#name', format: 'jpeg', quality: 55 })
  ok(/^data:image\/jpeg;base64,/.test(jpg.data.dataUrl), 'jpeg 参数真的透传到 CDP', String(jpg.data.dataUrl).slice(0, 30))
  const jpgCall = cmds('Page.captureScreenshot').pop()
  ok(jpgCall.params.format === 'jpeg' && jpgCall.params.quality === 55, 'format/quality 到了协议层', JSON.stringify({ f: jpgCall.params.format, q: jpgCall.params.quality }))
  const up = await call('upload', { tabId: 7, selector: 'input[type=file]', files: ['' + process.execPath] })
  ok(up.ok === true, 'upload 成功', JSON.stringify(up.error || up.data))
  ok(cmds('DOM.setFileInputFiles').length === 1, '走了 setFileInputFiles')
  const missing = await call('upload', { tabId: 7, selector: '#missing', files: [process.execPath] })
  ok(missing.ok === false && missing.errorCode === 'NOT_FOUND', '选择器没命中就明确失败（不发 setFileInputFiles）', String(missing.errorCode))
  const shotSel = await call('screenshot', { tabId: 7, selector: '#name', scale: 0.5 })
  ok(shotSel.ok === true && shotSel.data.via === 'cdp', '局部截图也走 CDP（不再依赖 captureVisibleTab）', JSON.stringify({ ok: shotSel.ok, via: shotSel.data && shotSel.data.via }))
  ok(shotSel.data.crop && shotSel.data.crop.selectorFailed === true, '量不到元素时如实标 selectorFailed')
  const met = await call('metrics', { tabId: 7 })
  ok(met.data.nodes === 1200 && met.data.heapMB === 12, '指标解析对', JSON.stringify({ nodes: met.data.nodes, heap: met.data.heapMB }))
}

/* ------------------------------ 11. 透传 / 模拟 / detach ------------------------------ */
console.log('11) cdp 透传 / emulate / detach')
reset()
{
  const raw = await call('cdp', { tabId: 7, method: 'Page.getNavigationHistory' })
  ok(raw.ok === true && raw.data.result.entries.length === 1, '透传回来了')
  const bad = await call('cdp', { tabId: 7, method: 'nonsense' })
  ok(bad.ok === false && bad.errorCode === 'BAD_ARGS', 'method 格式不对明确报错', String(bad.errorCode))

  const em = await call('emulate', { tabId: 7, device: 'mobile', network: 'slow3g', cpuThrottlingRate: 4 })
  ok(em.ok === true, 'emulate 成功')
  ok(!sent.some((c) => c.method === 'Emulation.enable'), '不去调并不存在的 Emulation.enable')
  ok(cmds('Emulation.setDeviceMetricsOverride')[0].params.width === 390, '移动视口 390')
  ok(cmds('Network.emulateNetworkConditions')[0].params.latency === 400, 'slow3g 延迟 400')
  ok(cmds('Emulation.setCPUThrottlingRate')[0].params.rate === 4, 'CPU 4x')
  const badEm = await call('emulate', { tabId: 7 })
  ok(badEm.ok === false && badEm.errorCode === 'BAD_ARGS', 'emulate 没参数明确报错')

  const det = await call('detach', { tabId: 7 })
  ok(det.ok === true && det.data.ok === true, 'detach 干净')
}

/* ------------------------------ 11b. hover / networkDetail ------------------------------ */
console.log('11b) hover 与请求详情')
reset()
{
  const h = await call('hover', { tabId: 7, x: 120, y: 80 })
  const moves = cmds('Input.dispatchMouseEvent').filter((c) => c.params.type === 'mouseMoved')
  ok(h.ok === true && h.data.x === 120, 'hover 成功')
  ok(moves.length === 2, '发了两次 mouseMoved（进元素 + 稳定）', String(moves.length))
  ok(moves[0].params.buttons === 0, '不按键')

  emit('Network.requestWillBeSent', {
    requestId: 'r9', type: 'Fetch',
    request: {
      method: 'POST', url: 'https://example.com/api/save',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      postData: '{"id":7}',
    },
  })
  emit('Network.responseReceived', {
    requestId: 'r9',
    response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Content-Type': 'application/json' } },
  })
  await new Promise((r) => setTimeout(r, 20))
  const d = await call('networkDetail', { tabId: 7, filter: 'api/save' })
  ok(d.ok === true, 'networkDetail 成功', JSON.stringify(d.error))
  ok(d.data.status === 200 && d.data.statusText === 'OK', '带状态')
  ok(d.data.requestHeaders.Authorization === 'Bearer x', '请求头带回来了')
  ok(d.data.postData === '{"id":7}', '请求体带回来了')
  ok(/ok":true/.test(d.data.body), '响应体带回来了', String(d.data.body))
  ok(d.data.responseHeaders['Content-Type'] === 'application/json', '响应头带回来了')
}

/* ------------------------------ 11b2. networkDetail 的 index 属于 filter 命中集合 ------------------------------ */
console.log('11b2) networkDetail：index 按 filter 命中集合取（1.19.0）')
reset()
{
  const hit = (id, url) => {
    emit('Network.requestWillBeSent', {
      requestId: id, type: 'XHR',
      request: { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, postData: '{"q":1}' },
    })
    emit('Network.responseReceived', {
      requestId: id,
      response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Content-Type': 'application/json' } },
    })
  }
  hit('ix1', 'https://example.com/api/ret/one')
  hit('ix2', 'https://example.com/api/ret/two')
  hit('ix3', 'https://example.com/api/other/three')
  await new Promise((r) => setTimeout(r, 20))

  const i0 = await call('networkDetail', { tabId: 7, filter: '/api/ret/', index: 0 })
  const i1 = await call('networkDetail', { tabId: 7, filter: '/api/ret/', index: 1 })
  ok(i0.ok && /\/api\/ret\/two$/.test(i0.data.url), 'index:0 取 filter 命中里最新的一条', i0.ok ? i0.data.url : i0.error)
  ok(i1.ok && /\/api\/ret\/one$/.test(i1.data.url), 'index:1 取上一条（不是整个缓冲的倒数第 1 条）', i1.ok ? i1.data.url : i1.error)
  const cands = i0.data.candidates || []
  ok(cands.length === 2, '候选只算 filter 命中的两条', String(cands.length))
  ok(cands[0].index === 0 && /\/two$/.test(cands[0].url), '候选 index:0 与上面的 index:0 同一条', JSON.stringify(cands[0]))
  ok(cands[1].index === 1 && /\/one$/.test(cands[1].url), '候选 index:1 与上面一致', JSON.stringify(cands[1]))
}

/* ------------------------------ 12b. 协议卡住：必须超时，不许挂死 ------------------------------ */
console.log('12b) CDP 超时与截图回退')
reset()
{
  hangMethod = 'Page.getNavigationHistory'
  cdpMod.CFG.sendTimeoutMs = 80
  const t0 = Date.now()
  const r = await call('cdp', { tabId: 7, method: 'Page.getNavigationHistory' })
  const ms = Date.now() - t0
  ok(r.ok === false && r.errorCode === 'CDP_TIMEOUT', '协议不回话时报 CDP_TIMEOUT', String(r.errorCode))
  ok(ms < 3000, '没有无限等（' + ms + 'ms）')
  ok(/别直接重试写操作/.test(r.error || ''), '错误里给了下一步')

  hangMethod = 'Page.captureScreenshot'
  hangWhen = (p) => p.captureBeyondViewport === true
  cdpMod.CFG.screenshotTimeoutMs = 80
  const shot = await call('screenshot', { tabId: 7, fullPage: true })
  ok(shot.ok === true && shot.data.fullPage === false, '整页截图超时后退回视口截图')
  ok(/整页截图超时/.test(shot.data.note || ''), '回执说明退回了', String(shot.data.note))
  hangMethod = ''
  hangWhen = null
  cdpMod.CFG.sendTimeoutMs = 15000
  cdpMod.CFG.screenshotTimeoutMs = 20000
}
/* ------------------------------ 11c. eval 走 CDP（CSP 兜底） ------------------------------ */
console.log('11c) eval · 页面 CSP 禁 eval 时自动走 Runtime.evaluate')
{
  reset()
  const origExec = chrome.scripting.executeScript
  // 让 page.js 的 inPageEval 报「CSP 挡住」，模拟真实页面
  chrome.scripting.executeScript = async (opts) => {
    const src = String((opts && opts.func) || '')
    if (src.includes('EVAL_CSP_BLOCKED')) return [{ result: { ok: false, errorCode: 'EVAL_CSP_BLOCKED', error: 'fake csp' } }]
    if (src.includes('__dshEvalMark')) return [{ result: true }]   // 标记探测：注入成功
    return [{ result: { ok: false, errorCode: 'INJECT_FAILED', error: 'fake: 注入不了' } }]
  }
  const origSend = chrome.debugger.sendCommand
  chrome.debugger.sendCommand = async (target, method, params) => {
    sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression || '')
      if (/__dshEvalMark ===/.test(expr)) return { result: { type: 'boolean', value: true } }
      if (/delete window.__dshEvalMark/.test(expr)) return { result: { type: 'undefined' } }
      return { result: { type: 'string', value: JSON.stringify({ t: 'object', s: '{"picked":true}' }) } }
    }
    return responder(method, params || {})
  }

  const r = await call('eval', { tabId: 7, code: '({a:{b:1}})', pick: 'a.b' })
  ok(r.ok === true, 'CSP 挡住了照样跑成功', JSON.stringify(r).slice(0, 200))
  ok(r.data.fellBackTo === 'CDP', '标了 fellBackTo=CDP', String(r.data.fellBackTo))
  ok(r.data.via === 'cdp', '标了 via=cdp', String(r.data.via))
  ok(r.data.value && r.data.value.picked === true, 'CDP 返回的值解析出来了', JSON.stringify(r.data.value))
  const evaled = sent.filter((c) => c.method === 'Runtime.evaluate')
  ok(evaled.length === 1, '只发了一次 Runtime.evaluate', String(evaled.length))
  ok(evaled[0].params.awaitPromise === true, 'awaitPromise=true（async IIFE 也能吃）')
  ok(evaled[0].params.returnByValue === true, 'returnByValue=true')
  ok(/__pick/.test(evaled[0].params.expression) && /a\.b/.test(evaled[0].params.expression), 'pick 在表达式里做了投影')

  // 子 frame：CDP 的 frameId 是字符串，和动作里的数字 frameId 不是一套编号，
  // 所以走「标记探测」——先注入随机串，再逐个上下文问它等不等于这个串。
  sent.length = 0
  emit('Runtime.executionContextCreated', { context: { id: 555, auxData: { isDefault: true, frameId: 'CDPFRAME1' } } })
  const sub = await cdpMod.evaluate(7, { expression: '1+1', frameId: 150, timeoutMs: 3000 })
  ok(sub && sub.contextId === 555, '子 frame 通过标记找到执行上下文', JSON.stringify(sub))
  ok(sent.some((c) => c.method === 'Runtime.evaluate' && /__dshEvalMark ===/.test(String(c.params.expression))), '先问了标记')
  ok(sent.some((c) => c.method === 'Runtime.evaluate' && /delete window.__dshEvalMark/.test(String(c.params.expression))), '用完把标记清掉了')

  chrome.scripting.executeScript = origExec
  chrome.debugger.sendCommand = origSend
}

/* ------------------------------ 11d. networkLog 跨帧聚合 ------------------------------ */
console.log('11d) networkLog · 主帧 + iframe 的探针一起收')
{
  reset()
  chrome.webNavigation = {
    async getAllFrames() {
      return [
        { frameId: 0, parentFrameId: -1, url: 'https://example.com/a' },
        { frameId: 150, parentFrameId: 0, url: 'https://example.com/design' },
      ]
    },
  }
  const origExec = chrome.scripting.executeScript
  chrome.scripting.executeScript = async (opts) => {
    const ids = (opts && opts.target && opts.target.frameIds) || [0]
    const fid = Number(ids[0]) || 0
    const net = fid === 150
      ? [{ ts: Date.now() - 1000, method: 'POST', url: 'https://example.com/api/v1/wf/update_template', status: 200, type: 'xhr', via: 'probe', body: '{"nodes":[]}', bodyLen: 11 }]
      : [{ ts: Date.now() - 2000, method: 'POST', url: 'https://example.com/api/v1/msg/msg/station/getUnhandledMsgCount', status: 200, type: 'xhr', via: 'probe' }]
    return [{ result: { net, con: [], version: 1, startedAt: 0 } }]
  }
  const r = await call('networkLog', { tabId: 7, limit: 10 })
  ok(r.ok === true, 'networkLog 成功', JSON.stringify(r).slice(0, 160))
  const rows = r.data.rows || []
  ok(rows.some((x) => Number(x.frameId) === 150), 'iframe 里的请求收进来了', JSON.stringify(rows.map((x) => x.frameId)))
  ok(rows.some((x) => x.body && /update_template/.test(x.url)), '请求体跟着回来了')
  ok(r.data.withBody === 1, '统计了带请求体的条数', String(r.data.withBody))
  ok(r.data.probeFrames === 2, '报告读了几个帧', String(r.data.probeFrames))

  const only = await call('networkLog', { tabId: 7, frame: 150 })
  ok((only.data.rows || []).length === 1 && Number(only.data.rows[0].frameId) === 150, 'frame 过滤生效', JSON.stringify(only.data.rows))

  const all = await call('networkLog', { tabId: 7, frame: 0 })
  ok((all.data.rows || []).every((x) => Number(x.frameId || 0) === 0), 'frame=0 只看主帧')

  chrome.scripting.executeScript = origExec
  delete chrome.webNavigation
}

/* ------------------------------ 11e. 子帧 eval 必须进页面世界 ------------------------------ */
console.log('11e) eval(frame) · world=MAIN 直接注入子帧，不走 content script')
{
  reset()
  const called = []
  let csCalls = 0
  const origExec = chrome.scripting.executeScript
  const origSendMessage = chrome.tabs.sendMessage
  chrome.scripting.executeScript = async (opts) => {
    called.push({ target: opts.target, world: opts.world, func: String(opts.func).slice(0, 40) })
    return [{ result: { ok: true, value: 42, type: 'number', runId: 'r1' } }]
  }
  chrome.tabs.sendMessage = (id, msg, opts, cb) => { csCalls++; if (cb) cb({ ok: false, errorCode: 'NO_CONTENT_SCRIPT' }) }
  const r = await call('eval', { tabId: 7, frame: 150, code: '1+1' })
  ok(r.ok === true && r.data.value === 42, '子帧 eval 跑通了', JSON.stringify(r).slice(0, 160))
  ok(csCalls === 0, '没有先走 content script（那会把 eval 送进隔离世界）', String(csCalls))
  ok(called.length === 1 && called[0].world === 'MAIN' && called[0].target.frameIds[0] === 150, '注入到 frame 150 的 MAIN 世界', JSON.stringify(called))
  chrome.scripting.executeScript = origExec
  chrome.tabs.sendMessage = origSendMessage
}

/* ------------------------------ 12. 命令面完整性 ------------------------------ */
console.log('12) 插件侧动作 ↔ 扩展命令对照')
{
  const fs = await import('node:fs/promises')
  const actionsSrc = await fs.readFile(new URL('../lib/extra.js', import.meta.url), 'utf8')
  const executorSrc = await fs.readFile(new URL('../extension/executor.js', import.meta.url), 'utf8')
  const missing = []
  for (const action of ['press', 'dialog', 'logs', 'networkLog', 'networkClear', 'replay', 'pdf', 'mhtml', 'upload', 'drag', 'emulate', 'metrics', 'cdp', 'detach', 'screenshot']) {
    if (!new RegExp("case '" + action + "'").test(executorSrc)) missing.push('executor:' + action)
  }
  for (const fn of ['performExtra', 'isExtraAction']) {
    if (!actionsSrc.includes('export async function ' + fn) && !actionsSrc.includes('export function ' + fn)) missing.push('extra:' + fn)
  }
  ok(missing.length === 0, '没有漏接的动作', missing.join(', '))
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
