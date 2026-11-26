/**
 * 插件侧（actions/extra）渲染自测：假桥，只看「模型会看到什么」。
 * 覆盖导航到达的三种说法、press/dialog/logs/network/导出/模拟/metrics 的回执。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-test-'))

const { performAction } = await import('../lib/actions.js')

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

const tab = { id: 7, title: '测试页', url: 'https://example.com/a' }
const bridgeOf = (table) => ({
  async call(action, params) {
    const fn = table[action]
    if (!fn) { const e = new Error('unexpected action ' + action); e.errorCode = 'TEST'; throw e }
    return fn(params || {})
  },
})
const act = (bridge, action, params = {}) => performAction(bridge, action, params, { root })

/* ------------------------------ 1. navigate 三种说法 ------------------------------ */
console.log('1) navigate · 到达 / 没等到 / 兜底')
{
  const landed = await act(bridgeOf({
    navigate: () => ({
      ok: true, landed: true, waitUntil: 'load', waitedMs: 812, commit: true, dcl: true, load: true,
      url: 'https://example.com/b', loadPending: false, tab,
    }),
  }), 'navigate', { url: 'https://example.com/b' })
  ok(/已到达/.test(landed.message), '到达写「已到达」', landed.message.split('\n')[0])
  ok(/事件判定/.test(landed.message) && /812ms/.test(landed.message), '标明事件判定与耗时')

  const pending = await act(bridgeOf({
    navigate: () => ({
      ok: true, landed: false, waitUntil: 'load', waitedMs: 15000, commit: true, dcl: true, load: false,
      loadPending: true, pendingUrl: 'https://example.com/slow', tab,
    }),
  }), 'navigate', { url: 'https://example.com/slow' })
  ok(/没等到 load/.test(pending.message), '没等到就说没等到', pending.message.split('\n')[0])
  ok(/可能还在加载/.test(pending.message), '提醒别当成功')
  ok(/action=wait/.test(pending.message), '给了下一步')

  const fallback = await act(bridgeOf({
    navigate: () => ({
      ok: true, landed: true, waitUntil: 'load', via: 'poll', waitedMs: 900, loadPending: false,
      cdpFallback: 'Cannot attach to this target', tab,
    }),
  }), 'navigate', { url: 'https://example.com/c' })
  ok(/轮询兜底/.test(fallback.message), '说明这次是兜底')
  ok(/CDP 没挂上/.test(fallback.message), '把失败原因带出来')

  const same = await act(bridgeOf({
    navigate: () => ({ ok: true, landed: true, sameDocument: true, waitUntil: 'load', waitedMs: 40, tab }),
  }), 'navigate', { url: 'https://example.com/a#x' })
  ok(/同文档跳转/.test(same.message), '同文档单独说明')

  const err = await act(bridgeOf({
    navigate: () => ({ ok: true, landed: true, siteUnreachable: { reason: 'unreachable' }, waitUntil: 'load', waitedMs: 300, tab }),
  }), 'navigate', { url: 'https://no.invalid/' })
  ok(/站点打不开/.test(err.message), '错误页单独说明')
}

console.log('2) open · 到达判定挂在 arrival 里')
{
  const r = await act(bridgeOf({
    open: () => ({ ok: true, tab, arrival: { landed: true, waitUntil: 'load', waitedMs: 500 } }),
  }), 'open', { url: 'https://example.com/d' })
  ok(/新标签已打开/.test(r.message), '开标签')
  ok(/到达判定：load · 500ms/.test(r.message), '带到达判定')
}

/* ------------------------------ 3. press ------------------------------ */
console.log('3) press · 回执说清插没插字符')
{
  const r = await act(bridgeOf({
    press: () => ({ ok: true, tab, pressed: { key: 'Enter', inserted: true, modifiers: [] }, focused: { tag: 'input', name: 'q', active: true } }),
  }), 'press', { key: 'Enter', selector: '#q' })
  ok(/按了 Enter/.test(r.message), '报告按了什么')
  ok(/已经插进去了|按键本身就把字符插进去了/.test(r.message), '说清带字符')
  ok(/已聚焦：input name=q/.test(r.message), '说清聚焦到谁')

  const combo = await act(bridgeOf({
    press: () => ({ ok: true, tab, pressed: { key: 'ctrl+a', inserted: false, modifiers: ['ctrl'] } }),
  }), 'press', { key: 'Ctrl+A' })
  ok(/纯按键/.test(combo.message), '组合键说「不插字符」')
}

/* ------------------------------ 4. dialog ------------------------------ */
console.log('4) dialog')
{
  const r = await act(bridgeOf({
    dialog: () => ({
      ok: true, tab, policy: { mode: 'accept' },
      rows: [{ ts: Date.now(), type: 'confirm', message: '确定删除？', answered: 'accept' }],
    }),
  }), 'dialog', {})
  ok(/策略 accept/.test(r.message) && /弹窗自动按 OK/.test(r.message), '策略翻成人话')
  ok(/confirm「确定删除？」→ accept/.test(r.message), '弹窗记录逐条列')

  // mode 直接传就该生效（工具层的 action 被 'dialog' 占了，子操作走 op）
  let seen = null
  const setMode = await act(bridgeOf({
    dialog: (p) => { seen = p; return { ok: true, tab, policy: { mode: p.mode }, rows: [] } },
  }), 'dialog', { mode: 'dismiss' })
  ok(seen && seen.mode === 'dismiss', 'mode 原样传到扩展', JSON.stringify(seen))
  ok(seen && seen.op === 'get', '没写 op 时按 get 走（不会误改）', JSON.stringify(seen && seen.op))
  ok(/策略 dismiss（弹窗自动按取消）/.test(setMode.message), '策略改成功后的回执')
}

/* ------------------------------ 5. logs / network ------------------------------ */
console.log('5) logs / networkLog')
{
  const r = await act(bridgeOf({
    logs: () => ({ ok: true, tab, total: 5, returned: 2, level: '', rows: [
      { ts: Date.now(), level: 'error', text: '接口 500 /api/x' },
      { ts: Date.now(), level: 'log', text: 'ok' },
    ] }),
  }), 'logs', { limit: 10 })
  ok(/缓冲 5 条/.test(r.message), '说清缓冲总量')
  ok(/只抓 CDP 挂上之后的日志/.test(r.message), '诚实说明抓取范围')
  ok(/error 接口 500/.test(r.message), '逐条列内容')

  const net = await act(bridgeOf({
    networkLog: () => ({ ok: true, tab, total: 2, returned: 1, filter: 'api', rows: [
      { ts: Date.now(), method: 'POST', status: 500, type: 'XHR', url: 'https://example.com/api/x' },
    ] }),
  }), 'networkLog', { filter: 'api' })
  ok(/POST 500 XHR/.test(net.message), '方法/状态/类型都在')
  ok(/filter=api/.test(net.message), '说明过滤条件')
}

/* ------------------------------ 6. 导出落盘 ------------------------------ */
console.log('6) pdf / mhtml · 落盘不塞进上下文')
{
  const pdfData = Buffer.from('%PDF-1.4 hello').toString('base64')
  const pdf = await act(bridgeOf({ pdf: () => ({ ok: true, tab, data: pdfData, format: 'pdf' }) }), 'pdf', { saveTo: 'unit.pdf' })
  ok(pdf.ok === true, 'pdf 成功')
  ok(/unit\.pdf/.test(pdf.message), '回执带路径')
  const files = await readdir(path.join(root, 'out'))
  ok(files.includes('unit.pdf'), '文件真的写出来了', files.join(','))
  const bytes = await readFile(path.join(root, 'out', 'unit.pdf'))
  ok(bytes.length === 14, '字节数对', String(bytes.length))

  const mhtml = await act(bridgeOf({ mhtml: () => ({ ok: true, tab, data: 'From: <Saved by Blink>\\r\\nbody' }) }), 'mhtml', { saveTo: 'unit.mhtml' })
  ok(/unit\.mhtml/.test(mhtml.message), 'mhtml 落盘')
  ok(/快照/.test(mhtml.message), '说明它是快照')
  const mhtmlText = await readFile(path.join(root, 'out', 'unit.mhtml'), 'utf8')
  ok(mhtmlText.startsWith('From: <Saved by Blink>'), 'MHTML 按文本写（不是 base64 解码的乱码）', JSON.stringify(mhtmlText.slice(0, 20)))
}

console.log('6b) screenshot · 文件名跟着实际格式走')
{
  const jpg = await act(bridgeOf({
    screenshot: () => ({ ok: true, tab, dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', width: 100, height: 20, via: 'cdp' }),
  }), 'screenshot', { format: 'jpeg' })
  ok(jpg.ok === true, '截图成功')
  ok(/\.jpg$/.test(jpg.detail.file), 'jpeg 写成 .jpg（不是 .png）', jpg.detail.file)
  ok(jpg.message.includes('shots'), '落在 shots 目录')
}
/* ------------------------------ 7. upload 参数校验 ------------------------------ */
console.log('7) upload · 本机文件先验，别把路径直接丢给页面')
{
  const missing = await act(bridgeOf({ upload: () => { throw new Error('不该调到这里') } }), 'upload', { selector: 'input[type=file]', files: [path.join(root, 'nope.bin')] })
  ok(missing.ok === false, '不存在的文件直接失败')
  ok(/文件不可用/.test(missing.message), '说清是哪个文件不行', missing.message)

  const good = await act(bridgeOf({
    upload: (p) => ({ ok: true, tab, files: p.files, nodeId: 42 }),
  }), 'upload', { selector: 'input[type=file]', files: [process.execPath] })
  ok(good.ok === true, '存在的文件能传')
  ok(/把 1 个文件设到 input\[type=file\]/.test(good.message), '回执说清设了几个')
  ok(/没弹系统选择器/.test(good.message), '说明走的 CDP')
}

/* ------------------------------ 8. metrics / emulate ------------------------------ */
console.log('8) metrics / emulate')
{
  const m = await act(bridgeOf({
    metrics: () => ({ ok: true, tab, nodes: 1200, documents: 1, frames: 2, listeners: 340, layouts: 12, layoutMs: 43, recalcStyles: 30, scriptMs: 1234, taskMs: 2500, heapMB: 12 }),
  }), 'metrics', {})
  ok(/DOM 节点 1200/.test(m.message), '节点数')
  ok(/JS 堆 12MB/.test(m.message), '堆大小')

  const e = await act(bridgeOf({
    emulate: () => ({ ok: true, tab, applied: { device: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3 }, network: { name: 'slow3g', latency: 400 }, cpuThrottlingRate: 4 } }),
  }), 'emulate', { device: 'mobile', network: 'slow3g', cpuThrottlingRate: 4 })
  ok(/视口：mobile 390×844 @3x/.test(e.message), '视口生效值')
  ok(/网络：slow3g（延迟 400ms）/.test(e.message), '网络生效值')
  ok(/CPU：4x/.test(e.message), 'CPU 生效值')
}

/* ------------------------------ 9. cdp 透传 / 未知动作 ------------------------------ */
console.log('9) cdp 透传 / 未知动作')
{
  const r = await act(bridgeOf({
    cdp: () => ({ ok: true, tab, method: 'Page.getNavigationHistory', result: { currentIndex: 0, entries: [{ url: 'https://example.com/a' }] } }),
  }), 'cdp', { method: 'Page.getNavigationHistory' })
  ok(/Page\.getNavigationHistory/.test(r.message), '回执带方法名')
  ok(/"currentIndex": 0/.test(r.message), '结果 JSON 进来了')

  const unknown = await act(bridgeOf({}), 'nonsense', {})
  ok(unknown.ok === false && /不认识的 action/.test(unknown.message), '未知动作明确报错')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
/* ------------------------------ 10. hover / storage / highlight / networkDetail ------------------------------ */
console.log('10) hover / storage / highlight / networkDetail')
{
  const h = await act(bridgeOf({ hover: () => ({ ok: true, tab, x: 120, y: 80 }) }), 'hover', { ref: 'e3' })
  ok(/鼠标移到 \(120,80\)/.test(h.message), 'hover 回执带坐标', h.message.split('\n')[0])
  ok(/不点击/.test(h.message), '说明没有点击')

  const st = await act(bridgeOf({ storage: () => ({ ok: true, kind: 'local', op: 'list', count: 2, rows: [
    { key: 'token', value: 'abc123', valueLength: 6 },
    { key: 'user', value: 'nono', valueLength: 4 },
  ] }) }), 'storage', {})
  ok(/localStorage\.list/.test(st.message), 'storage 回执说清哪份存储')
  ok(/token = \*\*\*（6 字/.test(st.message), '默认打码并给长度', st.message.split(String.fromCharCode(10))[1])
  ok(!/abc123/.test(st.message), '值没漏进上下文')
  ok(!/abc123/.test(JSON.stringify(st.detail)), 'detail 里也没漏')

  const stv = await act(bridgeOf({ storage: () => ({ ok: true, kind: 'local', op: 'get', key: 'token', found: true, value: 'abc123', valueLength: 6 }) }), 'storage', { op: 'get', key: 'token', showValues: true })
  ok(/token = abc123/.test(stv.message), 'showValues 才回真值')

  const hi = await act(bridgeOf({ highlight: () => ({ ok: true, tab, tag: 'button', text: '保存' }) }), 'highlight', { ref: 'e3' })
  ok(/已高亮 <button>「保存」/.test(hi.message), 'highlight 回执')

  const nd = await act(bridgeOf({ networkDetail: () => ({ ok: true, tab, requestId: 'r1', method: 'POST', url: 'https://example.com/api/save', status: 200, statusText: 'OK', requestHeaders: { 'Content-Type': 'application/json' }, postData: '{"id":7}', responseHeaders: { 'Content-Type': 'application/json' }, body: '{"ok":true}', bodyLength: 11 }) }), 'networkDetail', { filter: 'api' })
  ok(/POST 200 OK/.test(nd.message), 'networkDetail 带状态')
  ok(/请求体/.test(nd.message) && /响应体/.test(nd.message), '请求体/响应体都列了')
}

/* ------------------------------ 11. replay（1.11.1） ------------------------------ */
console.log('11) replay · 原样重放 / dryRun / 鉴权脱敏')
{
  const rep = await act(bridgeOf({
    replay: () => ({
      ok: true, sent: true, source: 'cdp', method: 'POST', url: 'https://example.com/api/v1/lim/x/querypower',
      status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
      body: '{"code":0,"data":{"total":0}}', jsonHead: '{"code":0,"data":{"total":0}}',
      bodyLength: 33, bodyTruncated: false, ms: 12,
    }),
  }), 'replay', { filter: 'querypower' })
  ok(/POST → 200 OK/.test(rep.message), '重放回执带状态', rep.message.split('\n')[0])
  ok(/total":0/.test(rep.message), '响应体进回执')
  ok(/真实请求/.test(rep.message), '明确提示这是真发')

  const dry = await act(bridgeOf({
    replay: () => ({
      ok: true, dryRun: true, source: 'probe', method: 'POST', url: 'https://example.com/api/v1/lim/x/querypower',
      headers: { authorization: '***', moduleCode: 'LIM_InspReportQuery' }, body: '{"pageIndex":1}', bodyLength: 14,
    }),
  }), 'replay', { filter: 'querypower', dryRun: true })
  ok(/没有真的发/.test(dry.message), 'dryRun 说清没发')
  ok(/moduleCode/.test(dry.message), 'dryRun 列出将带的头')
  ok(!/Bearer /.test(dry.message), '鉴权头不外泄')

  const failed = await act(bridgeOf({
    replay: () => ({ ok: true, sent: false, source: 'cdp', method: 'GET', url: 'https://example.com/x', error: 'Failed to fetch' }),
  }), 'replay', { filter: 'x' })
  ok(/没发出去/.test(failed.message) && /Failed to fetch/.test(failed.message), '发不出去时给原因')
}
process.exit(fails ? 1 : 0)
