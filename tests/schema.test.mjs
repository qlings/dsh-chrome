/**
 * 工具面自检：enum 里的每个 action 都要有人接，参数表要能序列化成合法 JSON Schema。
 * 这一类「漏接」不会报错，只会表现为「调用时说不认识这个 action」——所以要静态盯住。
 */
import { readFile } from 'node:fs/promises'
import { PARAMETERS } from '../lib/index.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

const enumActions = PARAMETERS.properties.action.enum
const actionsSrc = await readFile(new URL('../lib/actions.js', import.meta.url), 'utf8')
const extraSrc = await readFile(new URL('../lib/extra.js', import.meta.url), 'utf8')

const handled = new Set()
for (const m of actionsSrc.matchAll(/case '([A-Za-z]+)':/g)) handled.add(m[1])
const extraSet = (extraSrc.match(/const EXTRA_ACTIONS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || ''
for (const m of extraSet.matchAll(/'([A-Za-z]+)'/g)) handled.add(m[1])

console.log('1) action 面')
ok(enumActions.length === new Set(enumActions).size, 'enum 没有重复', String(enumActions.length))
const missing = enumActions.filter((a) => !handled.has(a))
ok(missing.length === 0, 'enum 里的每个 action 都有人接', missing.join(','))
const extraOnly = [...handled].filter((a) => !enumActions.includes(a))
ok(extraOnly.length === 0, '实现里没有「工具面调不到」的孤儿 action', extraOnly.join(','))

console.log('2) 参数表')
const json = JSON.stringify(PARAMETERS)
ok(json.length > 100, '能序列化')
for (const key of ['waitUntil', 'key', 'fullPage', 'files', 'from', 'to', 'device', 'network', 'cpuThrottlingRate', 'method', 'params', 'ref', 'offset', 'showValues']) {
  ok(Boolean(PARAMETERS.properties[key]), `有参数 ${key}`)
}
ok(PARAMETERS.properties.action.type === 'string', 'action 是 string')
ok(PARAMETERS.properties.action.enum.includes('press') && PARAMETERS.properties.action.enum.includes('navigate'), '新动作在 enum 里')
ok(PARAMETERS.properties.dragSteps, '拖拽步数不叫 steps（别和 flow 的 steps 撞）')
ok(!PARAMETERS.properties.steps || PARAMETERS.properties.steps.type === 'array', 'flow 的 steps 还是数组')

console.log('3) 扩展命令面')
const executorSrc = await readFile(new URL('../extension/executor.js', import.meta.url), 'utf8')
const cdpSrc = await readFile(new URL('../extension/cdp.js', import.meta.url), 'utf8')
const capsMatch = cdpSrc.match(/export const CAPABILITIES = \[([\s\S]*?)\]/)
const caps = capsMatch ? [...capsMatch[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]) : []
ok(caps.length >= 12, 'CDP 能力清单', String(caps.length))
for (const cmd of caps) {
  if (cmd === 'screenshotFull') {
    ok(/if \(p\.fullPage\)/.test(executorSrc), 'screenshotFull 走 screenshot + fullPage 分支')
    continue
  }
  ok(new RegExp("case '" + cmd + "':").test(executorSrc), `扩展接了 ${cmd}`)
}
ok(/chrome\.debugger/.test(cdpSrc), 'cdp.js 用的是 chrome.debugger')
const manifest = await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')
ok(/"debugger"/.test(manifest), 'manifest 声明了 debugger 权限')
ok(/"cookies"/.test(manifest), 'manifest 声明了 cookies 权限')

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
console.log('4) flow 不白算 delta')
{
  const src = await readFile(new URL('../lib/actions.js', import.meta.url), 'utf8')
  ok(/resolved\.noDelta = true/.test(src), 'flow 的每一步都带 noDelta（不再白扫页面）')
  const ex = await readFile(new URL('../extension/executor.js', import.meta.url), 'utf8')
  ok(/opts\.noDelta/.test(ex), 'executor 认 noDelta 并跳过 delta')
}

console.log('5) 页面忙 / 多匹配 / 掉线 这几条不回归')
{
  ok(/PAGE_BUSY/.test(executorSrc), 'executor 有 PAGE_BUSY（注入没抢到 ≠ CSP 禁 eval）')
  ok(/pageBusyError/.test(executorSrc), 'PAGE_BUSY 由 pageBusyError 统一生成')
  ok(/retryable: true/.test(executorSrc), 'PAGE_BUSY 标了 retryable')
  ok(/PAGE_BUSY/.test(actionsSrc), 'ERROR_HINTS 里有 PAGE_BUSY')
  ok(/让 1~2 秒重试|等 1~2 秒重试/.test(actionsSrc), '提示人「等一两秒重试」而不是换 flow')

  const pageSrc = await readFile(new URL('../extension/page.js', import.meta.url), 'utf8')
  const selectorAt = [...pageSrc.matchAll(/if \(o\.selector\) \{/g)].map((m) => m.index)
  // 1.9.0 起改走 qsa()（跨同源 iframe 的查询），老写法保留兼容
  const locateLike = selectorAt.filter((i) => /(?:qsa\(o\.selector\)|Array\.from\(document\.querySelectorAll\(o\.selector\)\))/.test(pageSrc.slice(i, i + 160)))
  ok(locateLike.length >= 2, 'click / check 各自的 selector 分支', String(locateLike.length))
  ok(locateLike.every((i) => /MULTI_MATCH/.test(pageSrc.slice(i, i + 1200))), '两处 selector 多匹配都会报 MULTI_MATCH')
  ok(/个输入框，不敢乱填/.test(pageSrc), 'type 填之前也做了唯一性检查')

  const bridgeSrc = await readFile(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  ok(/#dropQueue/.test(bridgeSrc), '桥有清队列的 #dropQueue')
  ok(/return Promise\.reject\(this\.#offlineError/.test(bridgeSrc), 'call() 掉线时立刻 reject，不陪着等超时')
  ok(/#externalise/.test(bridgeSrc), '/cmd 支持 saveTo 大字段落盘')
  ok(/#tokenOk/.test(bridgeSrc), '/cmd 支持可选 token')
  ok(/#startSweeper/.test(bridgeSrc), '有巡检器定时清掉发不出去的命令')
}
process.exit(fails ? 1 : 0)
