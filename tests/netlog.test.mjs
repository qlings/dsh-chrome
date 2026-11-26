/**
 * netlog.selectRows 的自测：过滤 / 折叠 / 截断的顺序。
 *
 * 重点回归 2026-11-23 的坑：`limit` 很小 + `filter` 时，
 * 必须先在**整个缓冲**里过滤，再取最新 N 条；以前是先截断再过滤，
 * 结果缓冲里明明有的请求会过滤成 0 条。
 */
import { selectRows, fold, DEFAULT_SHOW, MAX_SHOW } from '../extension/netlog.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

const row = (i, url, extra = {}) => ({ ts: 1000 + i, method: 'POST', url, status: 200, ...extra })

console.log('1) 过滤先生效，再按 limit 截断（1.12.0 修的 bug）')
{
  const rows = [
    row(1, 'http://x/heartbeat'),
    row(2, 'http://x/im/v1/stockOut/page'),
    row(3, 'http://x/heartbeat'),
    row(4, 'http://x/heartbeat'),
    row(5, 'http://x/heartbeat'),
  ]
  const r = selectRows(rows, { filter: 'stockOut', limit: 3 })
  ok(r.matched === 1, '匹配到 1 条（不是 0 条）', r.matched)
  ok(r.rows.length === 1 && r.rows[0].url.includes('stockOut'), '返回的就是那条')
  ok(r.truncated === false, '没触发截断提示')
}

console.log('2) 匹配数 > limit 时给 truncated，并只回最新 N 条')
{
  const rows = []
  for (let i = 0; i < 10; i++) rows.push(row(i, 'http://x/api/' + i))
  const r = selectRows(rows, { filter: '/api/', limit: 3 })
  ok(r.matched === 10, 'matched=10', r.matched)
  ok(r.rows.length === 3, '只回 3 条')
  ok(r.truncated === true, 'truncated=true')
  ok(r.rows[2].url === 'http://x/api/9', '取的是最新的那 3 条', r.rows.map((x) => x.url))
}

console.log('3) ignore 正则排掉心跳')
{
  const rows = [
    row(1, 'http://x/gw/actuator/heartbeat'),
    row(2, 'http://x/me/v1/pushRecord/unReadCount'),
    row(3, 'http://x/im/v1/stockOut/page'),
  ]
  const r = selectRows(rows, { ignore: 'heartbeat|unreadcount' })
  ok(r.rows.length === 1, '只剩 1 条', r.rows.length)
  ok(r.ignored === 2, 'ignored=2', r.ignored)
  ok(r.rows[0].url.includes('stockOut'), '留下的是业务请求')
}

console.log('4) 相邻重复折叠成一条，不相邻不合并')
{
  const same = row(1, 'http://x/unReadCount')
  const rows = [
    same,
    { ...same, ts: 1002 },
    { ...same, ts: 1003 },
    row(4, 'http://x/other'),
    { ...same, ts: 1005 },
  ]
  const folded = fold(rows)
  ok(folded.length === 3, '5 行折成 3 行', folded.map((r) => r.url))
  ok(folded[0].repeat === 3, '第一条 ×3', folded[0].repeat)
  ok(folded[0].firstTs === 1001 && folded[0].ts === 1003, '保留首尾时间')
  ok(folded[2].repeat === undefined, '单条不带 repeat')
}

console.log('5) collapse:false 时逐条给')
{
  const rows = [row(1, 'http://x/a'), row(2, 'http://x/a')]
  const r = selectRows(rows, { collapse: false })
  ok(r.rows.length === 2, '不折叠')
  ok(!r.rows.some((x) => x.repeat), '没有 repeat 字段')
}

console.log('6) frame 过滤 + method 全等 + 大小写')
{
  const rows = [
    { ...row(1, 'http://x/a'), frameId: 12 },
    { ...row(2, 'http://x/b'), frameId: 0 },
    { ...row(3, 'http://x/c'), method: 'GET', frameId: 0 },
  ]
  ok(selectRows(rows, { frame: 12 }).rows.length === 1, 'frame=12 只剩 1 条')
  ok(selectRows(rows, { filter: 'get' }).rows.length === 1, '按 method 全等能命中')
  ok(selectRows(rows, { filter: 'HTTP://X/A' }).rows.length === 1, 'URL 过滤大小写不敏感')
}

console.log('7) 默认值与上限')
{
  const many = []
  for (let i = 0; i < 900; i++) many.push(row(i, 'http://x/n' + i))
  ok(selectRows(many, {}).rows.length === DEFAULT_SHOW, '默认显示 DEFAULT_SHOW 条')
  ok(selectRows(many, { limit: 9999 }).rows.length === MAX_SHOW, 'limit 被 MAX_SHOW 收口')
  ok(selectRows([], {}).rows.length === 0, '空输入不炸')
  ok(selectRows(null, {}).rows.length === 0, 'null 输入不炸')
}

console.log('8) unique：按 method+url 去重，只留最后一次（1.15.0）')
{
  const rows = [
    row(1, 'http://x/im/v1/stockOut/page'),
    row(2, 'http://x/heartbeat'),
    row(3, 'http://x/im/v1/stockOut/page'),
    row(4, 'http://x/im/v1/stockIn/page'),
    row(5, 'http://x/heartbeat'),
  ]
  const r = selectRows(rows, { unique: true })
  ok(r.rows.length === 3, '5 条合成 3 个接口', r.rows.map((x) => x.url))
  ok(r.uniqueDropped === 2, 'uniqueDropped=2', r.uniqueDropped)
  ok(r.matched === 3, 'matched 按去重后算', r.matched)
  const hb = r.rows.find((x) => x.url.endsWith('heartbeat'))
  ok(hb.repeat === 2, '次数记在 repeat', hb.repeat)
  ok(hb.ts === 1005 && hb.firstTs === 1002, '留最后一次的时间 + 首次时间', { ts: hb.ts, firstTs: hb.firstTs })
  // 不同 method 同 URL 不算同一个接口
  const m = selectRows([row(1, 'http://x/a'), { ...row(2, 'http://x/a'), method: 'GET' }], { unique: true })
  ok(m.rows.length === 2, 'method 不同不合并')
}

console.log('9) unique 在 limit 之前生效（先数清接口数，再截断）')
{
  const rows = []
  for (let i = 0; i < 30; i++) rows.push(row(i, 'http://x/heartbeat'))
  for (let i = 0; i < 3; i++) rows.push(row(100 + i, 'http://x/biz/' + i))
  const r = selectRows(rows, { unique: true, limit: 10 })
  ok(r.matched === 4, '去重后一共 4 个接口', r.matched)
  ok(r.truncated === false, '4 < limit 10，不算截断')
  ok(r.rows.length === 4, '4 条都在')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
