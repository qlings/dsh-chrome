/**
 * 1.17.0 的自测：接口取证链路的四个补丁。
 *
 * 全部来自 2026-11-25 追溯「工单确认弹窗 C00314 投料量 2750.7493」的真实卡点：
 *   - 一次批量抓 5 个 MOM 接口，每条 moduleCode 不同，只能拆成 3 次调用（还要先吃一次未授权）；
 *   - networkDetail 的 filter 是子串匹配，`routeActivity/query` 命中了 `queryActivityInfo`；
 *   - 响应体只回前 1500 字、不能落盘；replay 拿到 4281 字也被截到 2000，只能改用 fetch 手拼；
 *   - 落盘 JSON 是单行几千字，read 每行只回 2000 字，得再写脚本才看得完。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-probe-'))
const { performAction } = await import('../lib/actions.js')

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

const tab = { id: 3, title: '生产制造单', url: 'http://192.168.0.3:7077/bsm/html/product-manage/product-manufacture-order.html' }
const bridgeOf = (table) => ({
  async call(action, params) {
    const fn = table[action]
    if (!fn) { const e = new Error('unexpected action ' + action); e.errorCode = 'TEST'; throw e }
    return fn(params || {})
  },
})
const act = (bridge, action, params = {}) => performAction(bridge, action, params, { root })

/* ------------------------------ 1. fetch · 分接口表头 ------------------------------ */
console.log('1) fetch · headersList 按 url 合并表头')
{
  const seen = []
  const r = await act(bridgeOf({
    fetch: (p) => {
      seen.push(p)
      return {
        ok: true, status: 200, statusText: 'OK', url: 'http://192.168.0.3:7077' + p.url,
        body: '{"code":0}', length: 9, truncated: false, ms: 4, tab,
      }
    },
  }), 'fetch', {
    urls: ['/api/a', '/api/b'],
    method: 'POST',
    headers: { language: 'zh-cn', platform: 'pc' },
    headersList: [{ moduleCode: 'BSM_ProcessProject' }, { moduleCode: 'BSM_ProcessLine' }],
    authFrom: undefined,
  })

  ok(r.ok, '批量成功')
  ok(seen.length === 2, '两个 URL 都发了', seen.length)
  ok(seen[0] && seen[0].headers && seen[0].headers.moduleCode === 'BSM_ProcessProject', '第 1 个用第 1 组表头', seen[0] && JSON.stringify(seen[0].headers))
  ok(seen[1] && seen[1].headers && seen[1].headers.moduleCode === 'BSM_ProcessLine', '第 2 个用第 2 组表头', seen[1] && JSON.stringify(seen[1].headers))
  ok(seen[0] && seen[0].headers.language === 'zh-cn', '基础 headers 仍然合并进来')
  ok(/分接口表头 2 组/.test(r.message), '回执标出分接口表头', r.message.split('\n')[0])
}

/* ------------------------------ 2. 落盘 JSON 美化 ------------------------------ */
console.log('2) saveTo · .json 缩进、.txt 原样、pretty:false')
{
  const body = JSON.stringify({ code: 0, datas: [{ id: 'x', qty: 2750.7493 }] })
  const call = () => act(bridgeOf({
    fetch: () => ({ ok: true, status: 200, statusText: 'OK', url: 'http://x/api', body, length: body.length, truncated: false, ms: 1, tab }),
  }), 'fetch', { url: '/api', json: true, saveTo: 'detail.json' })

  await call()
  const pretty = await readFile(path.join(root, 'out', 'detail.json'), 'utf8')
  ok(/\n {2}"code": 0/.test(pretty), '.json 落盘带缩进', JSON.stringify(pretty.slice(0, 40)))
  ok(JSON.parse(pretty).code === 0, '缩进后仍是合法 JSON')

  await act(bridgeOf({
    fetch: () => ({ ok: true, status: 200, statusText: 'OK', url: 'http://x/api', body, length: body.length, truncated: false, ms: 1, tab }),
  }), 'fetch', { url: '/api', json: true, saveTo: 'raw.json', pretty: false })
  const raw = await readFile(path.join(root, 'out', 'raw.json'), 'utf8')
  ok(raw === body, 'pretty:false 保留单行', JSON.stringify(raw.slice(0, 40)))

  await act(bridgeOf({
    fetch: () => ({ ok: true, status: 200, statusText: 'OK', url: 'http://x/api', body, length: body.length, truncated: false, ms: 1, tab }),
  }), 'fetch', { url: '/api', saveTo: 'detail.txt' })
  const txt = await readFile(path.join(root, 'out', 'detail.txt'), 'utf8')
  ok(txt === body, '.txt 不美化，原样落')
}

/* ------------------------------ 3. networkDetail · 落盘 + 候选 ------------------------------ */
console.log('3) networkDetail · saveTo 全量 + 命中多条列候选')
{
  let seen = null
  const r = await act(bridgeOf({
    networkDetail: (p) => {
      seen = p
      return {
        ok: true, requestId: 'r1', method: 'POST', url: 'http://192.168.0.3:7077/api/v1/bsm/routeActivity/query',
        status: 200, statusText: 'OK',
        requestHeaders: { moduleCode: 'BSM_ProcessLine' },
        postData: '{"nodeId":"x"}', responseHeaders: { 'content-type': 'application/json' },
        body: '{"code":0,"data":{"baseNumber":85.7}}', bodyLength: 36, bodyTruncated: false,
        candidates: [
          { index: 0, method: 'POST', status: 200, url: 'http://192.168.0.3:7077/api/v1/bsm/routeActivity/query' },
          { index: 1, method: 'POST', status: 200, url: 'http://192.168.0.3:7077/api/v1/bsm/routeActivity/queryActivityInfo' },
        ],
        tab,
      }
    },
  }), 'networkDetail', { filter: 'routeActivity/query', match: 'path', saveTo: 'nd.json' })

  ok(r.ok, '成功')
  ok(seen && Number(seen.maxChars) === 0, 'saveTo 时向扩展要全文（maxChars=0）', seen && seen.maxChars)
  ok(seen && seen.match === 'path', 'match 透传给扩展', seen && seen.match)
  ok(/命中 2 条/.test(r.message), '回执列出候选', r.message)
  ok(/index=1 .*queryActivityInfo/.test(r.message), '候选带 index 和 URL')
  ok(/已落盘：/.test(r.message), '提示已落盘')
  const text = await readFile(path.join(root, 'out', 'nd.json'), 'utf8')
  ok(/\n {2}"code": 0/.test(text), '落盘的内容缩进过')
}

/* ------------------------------ 4. replay · 落盘 + 截断告警 ------------------------------ */
console.log('4) replay · saveTo 全量 + 探针请求体截断告警')
{
  let seen = null
  const r = await act(bridgeOf({
    replay: (p) => {
      seen = p
      return {
        ok: true, sent: true, status: 200, statusText: 'OK', source: 'probe',
        url: 'http://192.168.0.3:7077/api/v1/bsm/proWorkOrder/clickGetParamsAndAct',
        headers: { 'content-type': 'application/json' },
        body: '{"code":0,"data":{"feedingQuantity":2750.7493}}', bodyLength: 44, bodyTruncated: false,
        requestBodyTruncated: true, requestBodyLength: 5000,
        tab,
      }
    },
  }), 'replay', { filter: 'clickGetParamsAndAct', saveTo: 'replay.json' })

  ok(r.ok, '成功')
  ok(seen && Number(seen.maxChars) === 0, 'saveTo 时 maxChars=0', seen && seen.maxChars)
  ok(/探针只存前 1200 字/.test(r.message), '截断的请求体当场告警', r.message)
  ok(/已落盘：/.test(r.message), '提示已落盘')
  const text = await readFile(path.join(root, 'out', 'replay.json'), 'utf8')
  ok(/2750\.7493/.test(text), '落盘拿到完整响应体')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
if (fails) process.exit(1)
