/**
 * 新动作的消息格式化自测（假 bridge，不连扩展）：
 * tabEvents / sourceSearch / vue / networkLog 的新字段。
 */
import { performAction } from '../lib/actions.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

const tab = { id: 7, title: '详情页', url: 'http://x/detail' }

const bridge = {
  async call(action, params = {}) {
    if (action === 'networkLog') {
      return {
        ok: true, tab, total: 120, matched: 9, returned: 2, truncated: true, folded: 3, ignored: 4,
        filter: 'stockout', frame: null, ignore: 'heartbeat', source: 'mixed', probeRows: 20,
        probeFrames: 1, framesWithTraffic: 1, withBody: 1, withHeaders: 1,
        rows: [
          { ts: Date.now() - 5000, method: 'POST', url: 'http://x/im/v1/stockOut/page', status: 200, type: 'Fetch', repeat: 3, firstTs: Date.now() - 9000, id: '1234.56', body: '{"a":1}', requestHeaders: { moduleCode: 'MOM_X' } },
          { ts: Date.now(), method: 'GET', url: 'http://x/im/v1/stockOut/selectByPushId/96df', status: 200, type: 'Fetch', id: '1234.57' },
        ],
      }
    }
    if (action === 'tabEvents') {
      if (params.op === 'net') {
        return {
          ok: true, found: true, tabId: 1234, url: 'http://x/stock-out-monitor/CKD1/96df', title: '出库单',
          openerTabId: 740030639, createdAt: Date.now() - 2500, closedAt: Date.now(), livedMs: 2100,
          networkCount: 2, consoleCount: 1, matched: 2,
          rows: [{ ts: Date.now(), method: 'POST', url: 'http://x/api/im/stockOut/page', status: 200 }],
        }
      }
      if (params.op === 'get') {
        return { ok: true, found: false, tabId: 99, note: '没有这个已关闭标签的留证。', kept: [1234] }
      }
      return {
        ok: true, events: [
          { ts: Date.now() - 3000, kind: 'created', tabId: 1234, openerTabId: 740030639, url: 'http://x/stock-out-monitor/CKD1/96df' },
          { ts: Date.now(), kind: 'removed', tabId: 1234, url: 'http://x/stock-out-monitor/CKD1/96df', livedMs: 2100 },
        ],
        closed: [{ tabId: 1234, url: 'http://x/a', title: '出库单' }], totalEvents: 2, totalClosed: 1,
      }
    }
    if (action === 'eval') {
      const code = String(params.code || '')
      if (code.includes('sourceSearchPageFn') || code.includes('scan') || code.includes('getEntriesByType')) {
        return {
          ok: true, tab, type: 'object',
          value: {
            scripts: 34, scanned: 30, hits: 2, failed: [],
            matches: [{ file: 'http://x/mom-produce-manage.js', at: 175510, size: 7429879, ctx: 'case 5:i=t.sent,1==i.code?this.$message.success("重新推送成功"):this.$message.error("重新推送失败");c=origin+"/main/inventory/stock-out-monitor/"+i.data.outboundCode' }],
          },
        }
      }
      return {
        ok: true, tab, type: 'object',
        value: {
          found: true, version: 2, name: '(匿名)', uid: 42, tag: 'div', path: ['LibsMain', 'Right', '(匿名)'],
          dataKeys: ['AllDataSource', 'columns', 'pushStatus'], methods: ['handleActionRow', 'actions', 'queryTableData'],
          props: [], pick: 'pushStatus', picked: 2,
        },
      }
    }
    return { ok: false, errorCode: 'UNEXPECTED', error: action }
  },
}

const show = async (action, params) => {
  const r = await performAction(bridge, action, { tabId: 7, ...params })
  return r
}

console.log('1) networkLog：匹配数/折叠/ignore 都要出现在回执里')
{
  const r = await show('networkLog', { filter: 'stockOut', ignore: 'heartbeat' })
  ok(r.ok === true, '成功')
  ok(/匹配 9 条/.test(r.message), '写了匹配数', r.message.split('\n')[0])
  ok(/只显示最新/.test(r.message), '截断有提示')
  ok(/×3/.test(r.message), '折叠次数有标出来')
  ok(/排掉 4 条/.test(r.message), 'ignore 排掉数有写')
  ok(r.message.includes('http://x/im/v1/stockOut/selectByPushId/96df'), 'URL 不再被截断')
}

console.log('2) tabEvents：新建/关闭成对出现，op=net 能给留证')
{
  const r = await show('tabEvents', {})
  ok(r.ok === true, '成功')
  ok(/新建 #1234/.test(r.message) && /由 #740030639 打开/.test(r.message), '谁开了谁', r.message)
  ok(/关闭 #1234/.test(r.message) && /2\.1 秒/.test(r.message), '存活时长', r.message)

  const net = await show('tabEvents', { op: 'net', tabId: 1234 })
  ok(net.ok === true, 'op=net 成功')
  ok(/post \/api\/im\/stockOut\/page/i.test(net.message) || net.message.includes('stockOut/page'), '列出了关之前的请求')

  const miss = await show('tabEvents', { op: 'get', tabId: 99 })
  ok(/没有 #99 的留证/.test(miss.message), '没留证时说明白')
  ok(/#1234/.test(miss.message), '还列出哪些 tabId 有留证')
}

console.log('3) sourceSearch：命中按 chunk + 偏移给上下文，且自动折行')
{
  const r = await show('sourceSearch', { needle: '重新推送' })
  ok(r.ok === true, '成功')
  ok(/命中 2 处/.test(r.message), '命中数', r.message.split('\n')[0])
  ok(/mom-produce-manage\.js @175510/.test(r.message), '标了 chunk 和偏移')
  ok(/重新推送成功/.test(r.message), '上下文带出来了')
  ok(r.message.split('\n').length > 5, '上下文折成了多行')
}

console.log('4) vue：组件名/方法/data 键/pick 值')
{
  const r = await show('vue', { pick: 'pushStatus' })
  ok(r.ok === true, '成功')
  ok(/组件「\(匿名\)」/.test(r.message) && /Vue2/.test(r.message), '组件名 + Vue 版本')
  ok(/handleActionRow/.test(r.message), '方法列表')
  ok(/AllDataSource/.test(r.message), 'data 键')
  ok(/pick=pushStatus/.test(r.message) && /2/.test(r.message), 'pick 取到值')
  ok(/LibsMain > Right/.test(r.message), '从根到这里的链')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
