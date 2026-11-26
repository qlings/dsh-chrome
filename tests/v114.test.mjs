// dsh-chrome 1.14.0 自测：片段 / 超时抢救 / authFrom / 版本方向 / hashOnly / 长任务提示 / saveTo 扩展名
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { performAction } from '../lib/actions.js'
import { resolveSavePath } from '../lib/save.js'

const root = path.join(os.tmpdir(), 'dsh-chrome-v114-' + Date.now())
await mkdir(path.join(root, 'snippets'), { recursive: true })

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

const tab = { id: 1, title: 't', url: 'https://example.com/a' }

/* 1) saveTo 不再给已有扩展名补后缀 */
{
  console.log('1) saveTo 扩展名')
  let t = resolveSavePath(root, 'C:\\tmp\\flows-list.json', 'x', 'txt')
  ok(t.file.endsWith('flows-list.json'), 'json 原样', t.file)
  t = resolveSavePath(root, 'C:\\tmp\\noext', 'x', 'txt')
  ok(t.file.endsWith('noext.txt'), '无扩展名才补 .txt', t.file)
}

/* 2) snippet + vars */
{
  console.log('2) eval 片段')
  await writeFile(path.join(root, 'snippets', 'demo.js'), 'return "n=" + {{n}} + " s=" + "{{s}}";', 'utf8')
  let seen = null
  const bridge = {
    call: async (action, params) => { seen = params; return { ok: true, type: 'string', value: 'done', world: 'MAIN' } },
  }
  const r = await performAction(bridge, 'eval', { snippet: 'demo', vars: { n: 3, s: 'abc' } }, { root })
  ok(r.ok === true, '片段执行成功')
  ok(seen && seen.code.includes('+ 3 +'), '数字占位替换', seen && seen.code)
  ok(seen && seen.code.includes('"abc"'), '字符串占位替换')
  ok(r.message.includes('片段：demo'), '回执标了片段来源')
  const list = await performAction(bridge, 'eval', { snippet: '?' }, { root })
  ok(list.ok && list.message.includes('demo'), 'snippet:"?" 列出片段')
  const bad = await performAction(bridge, 'eval', { snippet: '../evil' }, { root })
  ok(bad.ok === false && bad.message.includes('片段名不合法'), '非法片段名被拒')
}

/* 3) 超时抢救 __dshChunks */
{
  console.log('3) 超时抢救')
  let calls = 0
  const bridge = {
    call: async (action) => {
      calls++
      if (calls === 1) {
        const e = new Error('扩展没在时限内回话')
        e.errorCode = 'COMMAND_TIMEOUT'
        throw e
      }
      return { ok: true, type: 'string', value: JSON.stringify([{ a: 1 }, { a: 2 }]) }
    },
  }
  const outDir = path.join(root, 'out')
  const saveTo = path.join(outDir, 'batch.json')
  const r = await performAction(bridge, 'eval', { code: 'x', saveTo }, { root })
  ok(r.ok === false, '如实返回失败')
  ok(r.message.includes('已抢救'), '回执写了抢救')
  const txt = await readFile(path.join(outDir, 'batch.partial.json'), 'utf8').catch(() => '')
  ok(txt.includes('"a": 1'), 'partial 落盘')
}

/* 4) fetch authFrom */
{
  console.log('4) fetch authFrom')
  const seen = []
  const bridge = {
    call: async (action, params) => {
      seen.push({ action, params })
      if (action === 'eval') return { ok: true, type: 'string', value: JSON.stringify({ t: 'TOK', ty: 'Bearer' }) }
      return { ok: true, url: 'https://x/api', status: 200, statusText: 'OK', length: 2, body: '{}', tab, ms: 1 }
    },
  }
  const r = await performAction(bridge, 'fetch', { url: '/api', method: 'POST', authFrom: { key: 'm5_token' } }, { root })
  const f = seen.find((s) => s.action === 'fetch')
  ok(r.ok === true, '请求成功')
  ok(f && f.params.headers.authorization === 'Bearer TOK', '自动加 authorization')
  ok(r.message.includes('已按 authFrom'), '回执说明来源')
}

/* 5) status 版本方向 */
{
  console.log('5) status 版本方向')
  const bridge = {
    info: () => ({ connected: true, running: true, url: 'http://127.0.0.1:1', ext: { version: '1.12.0' }, queued: 0, inflight: 0, waitingPolls: 0 }),
    call: async () => ({ ok: true, version: '1.12.0', pageVersion: '1.13.0' }),
  }
  let r = await performAction(bridge, 'status', {}, { root })
  ok(r.message.includes('扩展比页面脚本旧'), '扩展旧 → 重载扩展')
  bridge.call = async () => ({ ok: true, version: '1.13.0', pageVersion: '1.12.0' })
  r = await performAction(bridge, 'status', {}, { root })
  ok(r.message.includes('页面脚本是旧版'), '页面旧 → F5')
}

/* 6) navigate 只改 hash */
{
  console.log('6) navigate hashOnly')
  const bridge = {
    call: async () => ({ ok: true, landed: true, waitUntil: 'load', waitedMs: 1, hashOnly: true, hashOnlyNote: '只改了 #hash：页面没有重新加载', tab }),
  }
  const r = await performAction(bridge, 'navigate', { url: 'https://example.com/a#x' }, { root })
  ok(r.message.includes('只改了 #hash'), '回执提示 hash 未重载')
}

/* 7) 长 eval 上限提示 */
{
  console.log('7) 长 eval 提示')
  const bridge = { call: async () => ({ ok: true, type: 'string', value: 'done', world: 'MAIN' }) }
  const r = await performAction(bridge, 'eval', { code: 'x', timeoutMs: 180000 }, { root })
  ok(r.message.includes('90 秒'), '超过 60 秒时提示上限')
  const r2 = await performAction(bridge, 'eval', { code: 'x' }, { root })
  ok(!r2.message.includes('90 秒'), '短 eval 不加噪音')
}

await rm(root, { recursive: true, force: true })
console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
