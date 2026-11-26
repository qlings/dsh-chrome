/**
 * 桥自测：扩展掉线时别让调用方各自干等 90 秒（2026-11-18 Chrome 被关掉那次踩的）。
 * 不起真扩展，只用「没人来轮询」这个事实模拟掉线。
 */
import { Bridge } from '../lib/bridge.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 1. 从没连过扩展：立刻判死，不等超时 ---------------- */
console.log('1) 扩展开没连上就发命令')
{
  const bridge = new Bridge({ port: 18971 })
  await bridge.start()
  try {
    const t0 = Date.now()
    let error = null
    await bridge.call('ping', {}, { timeoutMs: 30000 }).catch((e) => { error = e })
    const ms = Date.now() - t0
    ok(error && error.errorCode === 'EXT_OFFLINE', '直接报 EXT_OFFLINE', error && error.errorCode)
    ok(ms < 1000, '没有干等到 timeoutMs（' + ms + 'ms）', String(ms))
    ok(/没轮询|没连上/.test(String(error.message)), '错误里说清是掉线不是超时', String(error.message).slice(0, 80))

    const info = bridge.info()
    ok(info.connected === false && typeof info.hint === 'string' && info.hint.length > 0, 'status 带人话提示', String(info.hint).slice(0, 60))
    ok(info.idleFor === null, '从没轮询时 idleFor 是 null（不是 NaN）', String(info.idleFor))
  } finally { await bridge.stop() }
}

/* ---------------- 2. 掉线后排队的命令一次清光 ---------------- */
console.log('2) 掉线后清队列')
{
  const bridge = new Bridge({ port: 18972 })
  await bridge.start()
  try {
    // 造 3 条「发不出去」的命令：不连扩展，直接塞进队列（模拟扩展刚好在这一刻没了）
    bridge.lastPollAt = Date.now() - 120000   // 2 分钟没轮询 = 早掉线了
    const pending = [
      bridge.call('ping', {}, { timeoutMs: 30000 }).catch((e) => e),
      bridge.call('ping', {}, { timeoutMs: 30000 }).catch((e) => e),
    ]
    // 先让它们进队列（第一条已经把队列清空了，这里再看后面的）
    bridge.queue.push({ id: 'fake-1', action: 'ping', params: {}, ts: Date.now() })
    const before = bridge.queue.length
    await bridge.call('ping', {}, { timeoutMs: 30000 }).catch(() => {})
    const after = bridge.queue.length
    ok(after === 0, '队列被清空', before + ' → ' + after)
    const settled = await Promise.all(pending)
    ok(settled.every((e) => e && e.errorCode === 'EXT_OFFLINE'), '在等的命令都被判成 EXT_OFFLINE', JSON.stringify(settled.map((e) => e && e.errorCode)))
    ok(bridge.info().droppedCount >= 1, '掉落计数记下来了', String(bridge.info().droppedCount))
  } finally { await bridge.stop() }
}

/* ---------------- 3. /cmd 鉴权（有 token 文件才启用） ---------------- */
console.log('3) /cmd token')
{
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'))
  process.env.DSH_CHROME_HOME = dir
  await writeFile(path.join(dir, 'bridge.token'), 'secret-token\n', 'utf8')

  const bridge = new Bridge({ port: 18973 })
  await bridge.start()
  try {
    ok(bridge.info().tokenRequired === true, '读到 token 文件就要求鉴权')

    const post = async (body, headers = {}) => {
      const res = await fetch('http://127.0.0.1:18973/cmd', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      return { status: res.status, json: await res.json() }
    }

    const denied = await post({ action: 'tabs' })
    ok(denied.status === 401 && denied.json.errorCode === 'UNAUTHORIZED', '没带 token → 401', String(denied.status))

    const wrong = await post({ action: 'tabs' }, { 'x-dsh-token': 'nope' })
    ok(wrong.status === 401, '带错 token → 401', String(wrong.status))

    const right = await post({ action: 'tabs' }, { 'x-dsh-token': 'secret-token' })
    ok(right.status === 200, '带对 token 放行（这时扩展没连，所以是 ok:false 的掉线错）', String(right.status))
    ok(right.json.ok === false && right.json.errorCode === 'EXT_OFFLINE', '放行后正常走掉线判断', JSON.stringify(right.json).slice(0, 120))
  } finally {
    await bridge.stop()
    delete process.env.DSH_CHROME_HOME
  }
}

/* ---------------- 4. 没 token 文件 = 老用法照旧 ---------------- */
console.log('4) 没 token 文件时 /cmd 不收鉴权')
{
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'))
  process.env.DSH_CHROME_HOME = dir
  const bridge = new Bridge({ port: 18974 })
  await bridge.start()
  try {
    ok(bridge.info().tokenRequired === false, 'tokenRequired=false')
    const res = await fetch('http://127.0.0.1:18974/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'tabs' }),
    })
    const body = await res.json()
    ok(res.status === 200, '不带 token 也放行', String(res.status))
    ok(body.ok === false && body.errorCode === 'EXT_OFFLINE', '走的是掉线判断，不是鉴权', JSON.stringify(body).slice(0, 120))
  } finally {
    await bridge.stop()
    delete process.env.DSH_CHROME_HOME
  }
}

/* ---------------- 5. 热重载留下的僵尸桥要自动让位 ---------------- */
console.log('5) 新实例接管同端口（僵尸桥）')
{
  const first = new Bridge({ port: 18975 })
  await first.start()
  ok(first.info().running === true, '第一个桥起来了', String(first.info().running))

  // 模拟插件热重载：老实例没 stop，新实例直接 start
  const second = new Bridge({ port: 18975 })
  await second.start()
  try {
    ok(second.port === 18975, '新桥拿回原端口，没有顺延到 18976', String(second.port))
    ok(first.server === null, '老桥被停掉（server 已置空）', String(first.server))
    const res = await fetch('http://127.0.0.1:18975/status')
    ok(res.status === 200, '原端口还能正常响应', String(res.status))
    const body = await res.json()
    ok(body && body.ok !== false, '响应来自新桥', JSON.stringify(body).slice(0, 80))
  } finally { await second.stop() }
}

await wait(10)
process.exit(fails ? 1 : 0)
