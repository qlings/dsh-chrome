/**
 * log.js —— 每次操作都落一条。爸爸要的是「输出并记录详细内容」，
 * 所以这里不做抽样：成功、失败、超时，全写。密码类字段脱敏，但保留长度和
 * 「填了/没填」这件事，方便复盘又不把明文留在盘上。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SECRET_KEYS = /^(password|passwd|pwd|secret|token|cookie|authorization|apikey|api_key|session|credential)$/i

export function chromeHome(root) {
  return root || process.env.DSH_CHROME_HOME || path.join(os.homedir(), '.dsh', 'chrome')
}

export function logDir(root) {
  return path.join(chromeHome(root), 'logs')
}

export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + `…（共 ${value.length} 字）` : value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1))
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.test(key) && typeof val === 'string' && val) {
      out[key] = `***（已脱敏，${val.length} 字符）`
    } else {
      out[key] = redact(val, depth + 1)
    }
  }
  return out
}

function stamp(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 追加一条操作记录，返回落盘路径。 */
export async function record(root, entry) {
  const dir = logDir(root)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${stamp()}.jsonl`)
  const line = JSON.stringify({ ts: new Date().toISOString(), ...redact(entry) }) + '\n'
  await appendFile(file, line, 'utf8')
  return file
}

/** 读最近 n 条（从今天的文件开始往回翻）。 */
export async function recent(root, n = 10) {
  const dir = logDir(root)
  if (!existsSync(dir)) return []
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  const rows = []
  for (const file of files) {
    const text = await readFile(path.join(dir, file), 'utf8').catch(() => '')
    const lines = text.split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      if (rows.length >= n) return rows.reverse()
    }
  }
  return rows.reverse()
}

/** 人看的摘要行。 */
export function summarize(entry) {
  const tab = entry.tab ? `#${entry.tab.id} ${trim(tab_title(entry.tab), 40)}` : ''
  return `${entry.ok ? '✓' : '✗'} ${entry.action}${tab ? ' @ ' + tab : ''} · ${entry.ms ?? '?'}ms`
}

function tab_title(tab) {
  return tab.title || tab.url || ''
}

function trim(text, n) {
  const s = String(text || '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
