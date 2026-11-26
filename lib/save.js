/**
 * save.js —— 落盘路径解析（插件侧）。
 *
 * 为什么要单独一份：以前 saveTo 一律被塞进 ~/.dsh/chrome/out/，而这个目录通常
 * 在会话工作区之外。DSH 的文件沙箱是 workspace-write 时，模型读不回自己刚落盘的
 * 文件，只能再用 pwsh 复制一遍（2026-11-21 排查流程设计器时踩到）。
 *
 * 规则（保持向后兼容：纯文件名还是老行为）：
 *   1. 纯名字 / 带扩展名的名字（如 "glados"、"eval.json"）→ 仍落到 out/；
 *   2. 绝对路径、带目录分隔符、以 ~ 或 . 开头 → 按路径写，父目录自动创建；
 *      相对路径按**进程工作目录**（就是会话工作目录）解析。
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromeHome } from './log.js'

const hasSep = (s) => /[\\/]/.test(String(s))

function expandHome(p) {
  const raw = String(p || '')
  if (!raw.startsWith('~')) return raw
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, raw.slice(1))
}

// 已经带扩展名就别再补了：`saveTo:"flows-list.json"` 落成 `flows-list.json.txt`
// 这种事每次都要回头确认真实文件名（2026-11-24 备份接口时踩了两次）。
const KNOWN_EXT = /\.(json|jsonl|txt|text|csv|tsv|html?|mhtml?|xml|yml|yaml|md|js|mjs|cjs|log|sql|pdf|png|jpe?g|webp|gif|svg|zip|tar|gz|7z)$/i

function withExt(file, ext) {
  const e = String(ext || '').trim()
  if (!e) return file
  if (KNOWN_EXT.test(file)) return file
  return file.toLowerCase().endsWith('.' + e.toLowerCase()) ? file : `${file}.${e}`
}

/**
 * 解析 saveTo。
 * @param {string} root 插件数据目录（chromeHome 的上层）
 * @param {string} saveTo 用户给的 saveTo
 * @param {string} defaultName 没给 saveTo 时用的名字
 * @param {string} [ext] 需要强制补的扩展名（怕用户忘写）
 * @returns {{file: string, dir: string, explicit: boolean}}
 */
export function resolveSavePath(root, saveTo, defaultName, ext) {
  const raw = String(saveTo == null ? '' : saveTo).trim()
  const fallback = String(defaultName || `export-${Date.now().toString(36)}`)

  if (!raw) {
    const name = withExt(fallback.replace(/[^\w.-]/g, '_'), ext)
    const dir = path.join(chromeHome(root), 'out')
    return { file: path.join(dir, name), dir, explicit: false }
  }

  const isPathLike = raw.startsWith('~') || raw.startsWith('.') || path.isAbsolute(raw) || hasSep(raw)
  if (!isPathLike) {
    const name = withExt(raw.replace(/[^\w.-]/g, '_'), ext)
    const dir = path.join(chromeHome(root), 'out')
    return { file: path.join(dir, name), dir, explicit: false }
  }

  let target = expandHome(raw)
  if (!path.isAbsolute(target)) target = path.resolve(process.cwd(), target)
  const dir = path.dirname(target)
  const file = withExt(path.basename(target), ext)
  return { file: path.join(dir, file), dir, explicit: true }
}

/** 建目录；父目录不存在时 mkdir -p。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}
