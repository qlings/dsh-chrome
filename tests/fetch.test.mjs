/**
 * 1.13.0 的自测：fetch 动作、eval 帧坐标、history 的 iframe 提示、eval quiet。
 *
 * 这几条都来自 2026-11-23 排查「业务流引擎」的真实卡点：
 *   - 拿一份 159KB 的 flows.json，只能 eval + fetch + 手动切片，来回十几次；
 *   - GET /api/v1/... 连吃 5 个 401，没人告诉模型「token 在 localStorage、接口只收 POST」；
 *   - 同一条 eval 在 frame:39 上偶发 `RED is not defined`，回执却不写执行帧；
 *   - history 查 iframe 里的页面永远是 0 条。
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-fetch-'))
const { performAction } = await import('../lib/actions.js')

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

const tab = { id: 9, title: '流程设计器', url: 'http://192.168.10.231:7077/flow/' }
const bridgeOf = (table) => ({
  async call(action, params) {
    const fn = table[action]
    if (!fn) { const e = new Error('unexpected action ' + action); e.errorCode = 'TEST'; throw e }
    return fn(params || {})
  },
})
const act = (bridge, action, params = {}) => performAction(bridge, action, params, { root })

/* ------------------------------ 1. fetch 正常返回 ------------------------------ */
console.log('1) fetch · 状态 / 长度 / 预览 / 落盘')
{
  const body = JSON.stringify({ code: 0, rows: Array.from({ length: 200 }, (_, i) => ({ id: i })) })
  let seen = null
  const r = await act(bridgeOf({
    fetch: (p) => {
      seen = p
      return {
        ok: true, status: 200, statusText: 'OK', url: 'http://192.168.10.231:7077/flow/flows',
        body, length: body.length, truncated: false, contentType: 'application/json; charset=utf-8',
        frameUrl: 'http://192.168.10.231:7077/flow/', ms: 12, tab,
      }
    },
  }), 'fetch', { url: '/flow/flows', method: 'post', body: { page: 1 }, json: true, saveTo: 'flows' })

  ok(r.ok, '成功')
  ok(/^【chrome:fetch】POST .*→ 200 OK/.test(r.message), '状态行带方法与大写状态码', r.message.split('\n')[0])
  ok(/执行帧：http:\/\/192\.168\.10\.231:7077\/flow\//.test(r.message), '标出执行帧（哪个 iframe 发的）')
  ok(/响应体 \d+ 字/.test(r.message), '给了全量长度')
  ok(/已落盘：/.test(r.message), '提示已落盘')
  ok(seen && Number(seen.maxChars) === 0, 'saveTo 时向扩展要全量（maxChars=0）', seen && seen.maxChars)
  ok(seen && seen.method === 'POST', '方法转成大写再下发', seen && seen.method)
  ok(seen && seen.body && seen.body.page === 1, '请求体原样透传（对象不提前字符串化）')

  const dir = path.join(root, 'out')
  const text = await readFile(path.join(dir, 'flows.txt'), 'utf8')
  ok(text === body, '落盘的是完整响应体')
}

/* ------------------------------ 1b. saveTo 不再强开 JSON；404 HTML 给出网关提示 ------------------------------ */
console.log('1b) fetch · 落盘不强制 JSON 解析；404 HTML 点破是网关页')
{
  let seen = null
  const r = await act(bridgeOf({
    fetch: (p) => {
      seen = p
      return {
        ok: true, status: 200, statusText: 'OK', url: 'http://192.168.10.231:7077/eam/js/page.js',
        body: 'import x from "y"', length: 18, truncated: false, contentType: 'application/javascript', ms: 2, tab,
      }
    },
  }), 'fetch', { url: '/eam/js/page.js', saveTo: 'page.js' })
  ok(seen && seen.json !== true, '只有 saveTo 时不下发 json:true（不再刷解析失败）', seen && seen.json)
  ok(!/json:true 但解析失败/.test(r.message), '回执里没有 JSON 解析噪声', r.message)

  const g = await act(bridgeOf({
    fetch: () => ({
      ok: true, status: 404, statusText: 'Not Found', url: 'http://192.168.10.231:7077/esb/api/x',
      body: 'Sorry, Page Not Found', length: 21, truncated: false, contentType: 'text/html', ms: 15008, tab,
    }),
  }), 'fetch', { url: '/esb/api/x', method: 'post' })
  ok(/可能是网关|网关超时/.test(g.message), '404 + HTML 提示网关超时页', g.message.split('\n').slice(-1)[0])
}

/* ------------------------------ 2. 401 鉴权提示 ------------------------------ */
console.log('2) fetch · 401 给出「去哪儿看鉴权」')
{
  const r = await act(bridgeOf({
    fetch: () => ({
      ok: true, status: 401, statusText: 'Unauthorized', url: 'http://192.168.10.231:7077/api/v1/esb/flows/list',
      body: '<html><head><title>401 Authorization Required</title></head></html>',
      length: 70, truncated: false, ms: 3, tab,
    }),
  }), 'fetch', { url: '/api/v1/esb/flows/list' })
  ok(/401 = 网关鉴权失败/.test(r.message), '401 追加鉴权提示')
  ok(/networkDetail/.test(r.message), '提示去看页面自己的请求头')
  ok(/localStorage/.test(r.message), '提示 token 在 localStorage')
  ok(/只接受 POST/.test(r.message), '提示网关常常只认 POST')
}

/* ------------------------------ 3. eval 帧坐标 ------------------------------ */
console.log('3) eval · 标出 frame，帧不一致时告警')
{
  const same = await act(bridgeOf({
    eval: () => ({ ok: true, value: '"ok"', type: 'string', world: 'MAIN', runId: 'r1', execFrameId: 39 }),
  }), 'eval', { code: 'document.title', frame: 39 })
  ok(/frame=39/.test(same.message), '回执写明请求帧')
  ok(!/⚠️/.test(same.message), '帧一致不告警')

  const drift = await act(bridgeOf({
    eval: () => ({ ok: true, value: '{"settings":"ReferenceError: RED is not defined"}', type: 'string', world: 'MAIN', runId: 'r2', execFrameId: 0 }),
  }), 'eval', { code: 'RED.settings.version', frame: 39 })
  ok(/⚠️ 请求 frame=39，实际在 frame=0 执行/.test(drift.message), '帧不一致当场告警', drift.message)
  ok(/先 action=frames 核对帧号/.test(drift.message), '给了下一步')

  const quiet = await act(bridgeOf({
    eval: () => ({ ok: true, value: '1', type: 'number', world: 'MAIN', execFrameId: 39 }),
  }), 'eval', { code: '(() => 1)()', frame: 39, quiet: true })
  ok(!/代码：/.test(quiet.message), 'quiet 不回显代码')
  ok(/结果（number）/.test(quiet.message), '结果照常给')
}

/* ------------------------------ 4. eval 里的 401 也提示 ------------------------------ */
console.log('4) eval · 返回值里有 401 也提示鉴权')
{
  const r = await act(bridgeOf({
    eval: () => ({ ok: true, type: 'string', world: 'MAIN', value: '<html><head><title>401 Authorization Required</title></head></html>' }),
  }), 'eval', { code: 'await fetch("/api/x")', quiet: true })
  ok(/401 = 网关鉴权失败/.test(r.message), 'eval 的 401 页面也认出来')
}

/* ------------------------------ 5. history 的 iframe 盲区 ------------------------------ */
console.log('5) history · 0 条时说明 iframe 不进历史')
{
  const r = await act(bridgeOf({ history: () => ({ ok: true, rows: [] }) }), 'history', { keyword: '业务流引擎' })
  ok(/iframe/.test(r.message), '提示 iframe 里的页面查不到')
  ok(/action=frames/.test(r.message), '给了替代入口')
}

/* ------------------------------ 6. fetch 超时如实报 ------------------------------ */
console.log('6) fetch · 超时不装成功')
{
  const bridge = {
    async call() {
      const e = new Error('请求超时（20000ms）：/api/slow')
      e.errorCode = 'FETCH_TIMEOUT'
      throw e
    },
  }
  const r = await act(bridge, 'fetch', { url: '/api/slow' })
  ok(r.ok === false, '失败就是失败')
  ok(/FETCH_TIMEOUT/.test(r.message) && /超时/.test(r.message), '把码和原因都带出来', r.message)
}

/* ------------------------------ 7. fetch 批量：urls + saveToDir（1.15.0） ------------------------------ */
console.log('7) fetch · 批量抓取落盘')
{
  const urls = [
    'http://h/flow/flow/aaa111',
    'http://h/flow/flow/bbb222',
    'http://h/flow/flow/ccc333',
  ]
  const seen = []
  const r = await act(bridgeOf({
    fetch: (p) => {
      seen.push(p.url)
      if (p.url.endsWith('bbb222')) return { ok: false, error: '403 拒绝' }
      const body = JSON.stringify({ id: p.url.split('/').pop() })
      return { ok: true, status: 200, url: p.url, body, json: JSON.parse(body), length: body.length, tab }
    },
  }), 'fetch', { urls, saveToDir: 'batch', namePrefix: 'flow' })

  ok(r.ok === true, '有成功就算 ok')
  ok(seen.length === 3, '三个 URL 都发了（失败的没中断）', seen.length)
  ok(r.detail.okCount === 2, '成功 2 条', String(r.detail && r.detail.okCount))
  ok(/完成 2\/3/.test(r.message), '回执给完成数', r.message.split('\n').pop())
  ok(/✗ 02 .*403/.test(r.message), '失败那条标 ✗ 和原因', r.message)
  const dir = path.join(root, 'out', 'batch')
  const f1 = await readFile(path.join(dir, '01_flow_flow_aaa111.json'), 'utf8')
  const f3 = await readFile(path.join(dir, '03_flow_flow_ccc333.json'), 'utf8')
  ok(f1.includes('aaa111') && f3.includes('ccc333'), '文件名按序号+URL 生成且内容对得上', f1)
  const all = await readdir(dir)
  ok(all.length === 2, '失败的那条不落盘', all.join(','))
}

/* ------------------------------ 8. fetch shape：只看结构 ------------------------------ */
console.log('8) fetch · shape 只要字段不要值')
{
  const payload = { code: 0, data: { total: 3, datas: [{ mat_code: 'M1', mat_name: '桶' }] } }
  const r = await act(bridgeOf({
    fetch: () => ({ ok: true, status: 200, url: 'http://h/api', body: JSON.stringify(payload), json: payload, length: 99, tab }),
  }), 'fetch', { url: '/api', shape: true })
  ok(/结构（只看字段，不看值）/.test(r.message), '给了结构段')
  ok(/mat_code: string/.test(r.message), '列出字段与类型')
  ok(!/桶/.test(r.message) && !/M1/.test(r.message), '不带具体值', r.message)
  ok(/datas: array\(1\)/.test(r.message), '数组给长度')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
