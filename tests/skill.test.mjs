/**
 * 1.18.0 的自测：skill 随插件走 + 调用时的提示。
 *
 * 之前文档放在 ~/.dsh/skills/chrome，插件和文档是两份东西：换机器、升级插件、
 * 或者只是忘了同步，工具和配方就对不上。现在插件自带 SKILL.md + references/，
 * 通过 ctx.skills 注册成 skill「chrome」，并在第一次调用/出错时提醒去读。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-skill-'))
const lib = await import('../lib/index.js')
const { apply, splitSkill, skillHint } = lib

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + extra : '')) }
}

/* ------------------------------ 1. frontmatter 解析 ------------------------------ */
console.log('1) SKILL.md 头部解析')
{
  const raw = '---\nname: chrome\ndescription: "用 dsh-chrome 接管本机 Chrome"\n---\n\n# 正文\n\n内容'
  const { meta, body } = splitSkill(raw)
  ok(meta.name === 'chrome', 'name 解析出来', meta.name)
  ok(meta.description === '用 dsh-chrome 接管本机 Chrome', '引号被去掉', meta.description)
  ok(body.startsWith('# 正文'), '正文不含 frontmatter', body.slice(0, 12))

  const plain = splitSkill('# 没有头部')
  ok(Object.keys(plain.meta).length === 0 && plain.body === '# 没有头部', '没有头部也不炸')
}

/* ------------------------------ 2. 插件自带的 SKILL.md ------------------------------ */
console.log('2) 插件包里的 SKILL.md 能被当成 skill 读')
{
  const file = path.join(process.cwd(), 'SKILL.md')
  const { meta, body } = splitSkill(await readFile(file, 'utf8'))
  ok(meta.name === 'chrome', 'name=chrome', meta.name)
  ok(typeof meta.description === 'string' && meta.description.length > 20, 'description 够长')
  ok(/接管本机 Chrome/.test(body), '正文是速查本身')
  ok(/references\//.test(body), '正文里指向 references/（相对插件目录）')
}

/* ------------------------------ 3. 注册进 ctx.skills ------------------------------ */
console.log('3) apply 时注册 skill provider')
{
  const providers = []
  const disposers = []
  let tool = null
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    tools: { register: (def) => { tool = def; return () => {} } },
    skills: { registerProvider: (create) => { providers.push(create()) } },
    // 真实 cordis 会在服务就绪后回调；这里直接同步回调，回调参数就是 ctx。
    inject: (_deps, cb) => cb(ctx),
    effect: (fn) => { disposers.push(fn) },
    on: () => {},
  }
  await apply(ctx, { root, port: 18997 })

  ok(providers.length === 1, '注册了一个 provider', providers.length)
  const provider = providers[0]
  ok(provider && provider.name === 'dsh-chrome', 'provider 名字', provider && provider.name)

  const listed = await provider.list()
  ok(listed.complete === true, 'list 完整')
  const candidate = listed.candidates[0]
  ok(candidate && candidate.name === 'chrome', 'candidate 是 chrome', candidate && candidate.name)
  ok(candidate.provider === 'dsh-chrome', 'candidate.provider 对齐 provider 名')
  ok(candidate.rank < 400, 'rank 低于 filesystem 的 user 根（400），插件这份优先', candidate.rank)
  ok(String(candidate.resourceBase && candidate.resourceBase.path).replace(/\\/g, '/').endsWith('dsh-chrome'), 'resourceBase 指向插件目录', candidate.resourceBase && candidate.resourceBase.path)

  const loaded = await provider.get(candidate)
  ok(/接管本机 Chrome/.test(loaded.content), 'load 回来的是正文')
  ok(loaded.rank === undefined && loaded.locator === undefined, 'load 不回传 rank/locator')

  ok(tool && tool.name === 'chrome', '工具照常注册', tool && tool.name)

  // 收尾：把桥关掉，否则监听的端口会让测试进程不退出
  for (const fn of disposers) {
    try {
      const inner = fn()
      if (typeof inner === 'function') inner()
    } catch { /* 关不掉也无所谓，下面 process.exit 兜底 */ }
  }
}

/* ------------------------------ 4. 提示语 ------------------------------ */
console.log('4) 提示语：首次 / 失败 / 平时')
{
  const first = skillHint(true, true)
  ok(/skill「chrome」/.test(first), '第一次调用提示读 skill', first)
  ok(skillHint(true, false) === '', '之后成功不再啰嗦')
  ok(/skill「chrome」/.test(skillHint(false, false)), '失败时提示查错误码表')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
