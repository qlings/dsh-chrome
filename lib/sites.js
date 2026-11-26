/**
 * sites.js —— 「已有账户密码」存在哪。
 *
 * 不碰 Chrome 的密码库（v20 app-bound 加密，解密要靠系统服务，不稳）。
 * 改成：登录过的站点由扩展复用浏览器里的 Cookie（这才是真正的「已有账户」），
 * 需要重新输密码时，账号密码从 ~/.dsh/chrome/sites.json 取。
 * 文件只给当前用户读写，工具输出和操作日志里密码一律脱敏。
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { chromeHome } from './log.js'

export function sitesFile(root) {
  return path.join(chromeHome(root), 'sites.json')
}

export async function readSites(root) {
  try {
    const text = await readFile(sitesFile(root), 'utf8')
    const data = JSON.parse(text)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export async function writeSites(root, data) {
  await mkdir(chromeHome(root), { recursive: true })
  const file = sitesFile(root)
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
  await chmod(file, 0o600).catch(() => {})
  return file
}

/** 按域名或自定义 key 找站点：先精确，再后缀匹配。 */
export function findSite(sites, key) {
  const needle = String(key || '').trim().toLowerCase()
  if (!needle) return null
  if (sites[needle]) return { key: needle, site: sites[needle] }
  for (const [name, site] of Object.entries(sites)) {
    const host = String(site?.host || name || '').toLowerCase()
    if (host && (host.includes(needle) || needle.includes(host))) return { key: name, site }
  }
  return null
}

export function maskSite(site) {
  if (!site || typeof site !== 'object') return site
  return {
    ...site,
    password: site.password ? `***（已存，${String(site.password).length} 字符）` : undefined,
  }
}
