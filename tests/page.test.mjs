// page.js 自测：假 DOM，验 outline 的 ref 分配、read 的 offset 分页、click 按 ref 定位。
import '../extension/page.js'

const P = globalThis.__dshPage
let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')) }
}

/* ---------------- 假 DOM ---------------- */
const made = []
function mkEl(tag, props = {}) {
  const attrs = new Map(Object.entries(props.attrs || {}))
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    type: props.type || '',
    value: props.value == null ? '' : props.value,
    placeholder: props.placeholder || '',
    name: props.name || '',
    id: props.id || '',
    disabled: props.disabled === true,
    checked: props.checked === true,
    innerText: props.text || '',
    textContent: props.text || '',
    className: props.className || '',
    labels: [],
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : (props.attrs && k in props.attrs ? props.attrs[k] : null)),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    getBoundingClientRect: () => props.rect || { width: 120, height: 24 },
    getClientRects: () => [1],
    scrollIntoView: () => {},
    focus: () => {},
    dispatchEvent: () => true,
    click: () => { el.clickedCount = (el.clickedCount || 0) + 1 },
  }
  made.push(el)
  return el
}

const byRef = () => made.filter((el) => el.getAttribute('data-dsh-ref'))
function querySelectorAll(sel) {
  if (sel === '[data-dsh-ref]') return byRef()
  if (sel === '[data-dsh-highlight]') return made.filter((el) => el.getAttribute('data-dsh-highlight'))
  if (/^\[data-dsh-ref="(.+)"\]$/.test(sel)) {
    const want = sel.match(/^\[data-dsh-ref="(.+)"\]$/)[1]
    return byRef().filter((el) => el.getAttribute('data-dsh-ref') === want)
  }
  // outline 那个大选择器：把所有造出来的元素都给它（body 除外）
  if (sel.includes('[role="button"]')) return made.filter((el) => el.tagName !== 'BODY')
  if (sel === 'a[href]') return made.filter((el) => el.tagName === 'A')
  if (sel === 'input,textarea,select' || sel === 'input:not([type="hidden"]),textarea,select') return made.filter((el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
  return []
}
function querySelector(sel) {
  const rows = querySelectorAll(sel)
  return rows.length ? rows[0] : null
}

const body = mkEl('body', { text: '页面正文😀'.repeat(50) })
body.querySelectorAll = () => []

globalThis.CSS = { escape: (s) => String(s) }
globalThis.MouseEvent = class { constructor(type) { this.type = type } }
globalThis.KeyboardEvent = class { constructor(type) { this.type = type } }
globalThis.InputEvent = class { constructor(type) { this.type = type } }
globalThis.Event = class { constructor(type) { this.type = type } }
function mkStorage() {
  const map = new Map()
  return {
    get length() { return map.size },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}
globalThis.window = {
  getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  getSelection: () => '',
  localStorage: mkStorage(),
  sessionStorage: mkStorage(),
  scrollX: 0,
  scrollY: 0,
  innerWidth: 800,
  innerHeight: 600,
}
globalThis.location = { href: 'https://example.com/page', host: 'example.com', pathname: '/page', origin: 'https://example.com' }
globalThis.document = { title: '测试页', readyState: 'complete', body, documentElement: body, querySelector, querySelectorAll }

/* ---------------- 1. outline ---------------- */
console.log('1) inPageOutline')
const btn = mkEl('button', { text: '登录' })
const link = mkEl('a', { text: '帮助', attrs: { href: '/help' } })
const box = mkEl('input', { type: 'checkbox', checked: true })
const hidden = mkEl('input', { type: 'hidden' })
const ghost = mkEl('button', { text: '看不见的', rect: { width: 0, height: 0 } })
const out = P.inPageOutline({ limit: 120 })
ok(out.ok === true, '返回 ok')
ok(out.rows.length === 3, '只收可见的 3 个元素（隐藏 input / 0 尺寸的剔除）', String(out.rows.length))
ok(out.skippedInvisible === 2, '跳过的计数如实报', String(out.skippedInvisible))
ok(out.rows[0].ref === 'e1' && out.rows[1].ref === 'e2' && out.rows[2].ref === 'e3', 'ref 依次为 e1/e2/e3')
ok(btn.getAttribute('data-dsh-ref') === 'e1', 'ref 真的写到了 DOM 上')
ok(out.rows[0].role === 'button' && out.rows[1].role === 'link' && out.rows[2].role === 'checkbox', 'role 推断', JSON.stringify(out.rows.map((r) => r.role)))
ok(out.rows[2].checked === true, '勾选态带出来')
ok(out.rows[1].href === '/help', '链接带 href（短路径）', String(out.rows[1].href))

// 再跑一次：旧 ref 必须先清掉，不能指向别人
const again = P.inPageOutline({ limit: 1 })
ok(again.rows.length === 1 && again.rows[0].ref === 'e1', '第二次 outline 只给 limit 个')
ok(byRef().length === 1, '上一轮的 ref 被清干净了（只剩本轮 1 个）', String(byRef().length))
P.inPageOutline({ limit: 120 })

/* ---------------- 2. click 按 ref 定位 ---------------- */
console.log('2) inPageClick(ref)')
const clicked = P.inPageClick({ ref: 'e1' })
ok(clicked.ok === true, '点到了')
ok(clicked.how === 'ref', 'how=ref')
ok(clicked.clicked.text === '登录', '点的是「登录」', clicked.clicked && clicked.clicked.text)
const stale = P.inPageClick({ ref: 'e99' })
ok(stale.ok === false && stale.errorCode === 'REF_STALE', '旧 ref 报 REF_STALE', JSON.stringify(stale))
ok(/outline/.test(stale.error), '错误里指向 outline', stale.error)

/* ---------------- 3. read offset ---------------- */
console.log('3) inPageRead(offset)')
const text = '甲'.repeat(3000) + '😀' + '乙'.repeat(3000)
const page = mkEl('body', { text })
page.querySelectorAll = () => []
globalThis.document.body = page
const r1 = P.inPageRead({ maxChars: 2000 })
ok(r1.textLength === text.length, '总字数', String(r1.textLength))
ok(r1.offset === 0 && r1.text.length === 2000 && r1.truncated === true, '第一窗口 2000 字且标了还有')
ok(r1.nextOffset === 2000, 'nextOffset=2000', String(r1.nextOffset))
ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r1.text), '第一窗口没有孤立代理')

// 故意把 offset 落在 emoji 高代理上（text 里 emoji 在第 3000~3001）
const r2 = P.inPageRead({ maxChars: 2000, offset: 3001, })
ok(r2.offset === 3000, 'offset 落进代理对中间时退回对齐点', String(r2.offset))
ok(!/^[\uDC00-\uDFFF]/.test(r2.text), '从代理对中间开始时不会吐孤立低代理', JSON.stringify(r2.text.slice(0, 2)))
ok(r2.text.slice(0, 2) === '😀', '这一页从完整的 emoji 开始', JSON.stringify(r2.text.slice(0, 2)))
ok(r2.nextOffset === 5000, 'nextOffset 连续', String(r2.nextOffset))

const r3 = P.inPageRead({ maxChars: 500, offset: 999999 })
ok(r3.text === '' && r3.truncated === false, 'offset 越界给空页，不报错', JSON.stringify(r3.text))

/* ---------------- 4. type 按 ref ---------------- */
console.log('4) inPageType(ref)')
const field = mkEl('input', { type: 'text', name: 'q', value: '' })
globalThis.HTMLTextAreaElement = class {}
globalThis.HTMLInputElement = class {}
P.inPageOutline({ limit: 200 })
const fieldRef = field.getAttribute('data-dsh-ref')
const typed = P.inPageType({ ref: fieldRef, value: 'hello' })
ok(typed.ok === true, '填进去了', JSON.stringify(typed))
ok(field.value === 'hello', 'DOM 值真的改了', field.value)
const miss = P.inPageType({ ref: 'e999', value: 'x' })
ok(miss.ok === false && miss.errorCode === 'REF_STALE', '找不到 ref 报 REF_STALE', JSON.stringify(miss))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
/* ---------------- 5. storage ---------------- */
console.log('5) inPageStorage')
{
  const set = P.inPageStorage({ kind: 'local', op: 'set', key: 'token', value: 'abc123' })
  ok(set.ok === true && set.valueLength === 6, '写进去')
  const got = P.inPageStorage({ kind: 'local', op: 'get', key: 'token' })
  ok(got.found === true && got.value === 'abc123', '读回来')
  P.inPageStorage({ kind: 'local', op: 'set', key: 'user', value: 'nono' })
  const list = P.inPageStorage({ kind: 'local', op: 'list' })
  ok(list.count === 2 && list.rows.length === 2, 'list 两个 key', String(list.count))
  ok(list.rows[0].key === 'token' && list.rows[0].valueLength === 6, 'list 带长度')
  const removed = P.inPageStorage({ kind: 'local', op: 'remove', key: 'token' })
  ok(removed.ok === true, 'remove 成功')
  ok(P.inPageStorage({ kind: 'local', op: 'get', key: 'token' }).found === false, '删掉了')
  ok(P.inPageStorage({ kind: 'session', op: 'set', key: 's1', value: 'x' }).ok === true, 'sessionStorage 也能用')
  ok(P.inPageStorage({ kind: 'local', op: 'clear' }).cleared === 1, 'clear 回报清了几条')
  ok(P.inPageStorage({ kind: 'local', op: 'nope' }).ok === false, '非法 op 报 BAD_ARGS')
}

/* ---------------- 6. highlight ---------------- */
console.log('6) inPageHighlight')
{
  const el = mkEl('button', { text: '保存' })
  el.style = {}
  globalThis.document.querySelector = (sel) => (sel === '#save' ? el : null)
  const hi = P.inPageHighlight({ selector: '#save' })
  ok(hi.ok === true && hi.tag === 'button', '高亮成功', JSON.stringify(hi))
  ok(String(el.style.outline).includes('3px solid'), '画了 3px 外框', String(el.style.outline))
  ok(el.getAttribute('data-dsh-highlight') === '1', '打了标记')
  const cleared = P.inPageHighlight({ clear: true })
  ok(cleared.ok === true, '清掉了')
  ok(el.getAttribute('data-dsh-highlight') === null, '标记移除')
  ok(P.inPageHighlight({ selector: '#nope' }).errorCode === 'NOT_FOUND', '找不到报 NOT_FOUND')
}
/* ---------------- 7. wait textGone ---------------- */
console.log('7) inPageWait · textGone')
{
  const page = mkEl('body', { text: '保存成功' })
  page.querySelectorAll = () => []
  globalThis.document.body = page
  const gone = await P.inPageWait({ textGone: '不存在的提示', timeoutMs: 500 })
  ok(gone.ok === true && gone.matched === 'text-gone', '本来就没有 → 立刻算消失', JSON.stringify(gone))
  globalThis.document.body = mkEl('body', { text: '别的文字' })
  const bad = await P.inPageWait({ timeoutMs: 300 })
  ok(bad.ok === false && bad.errorCode === 'BAD_ARGS', 'textGone 参与参数校验（不再误报 BAD_ARGS）')
}
/* ---------------- 8. outline 折叠 / 作用域 / 增量 Diff ---------------- */
console.log('8) outline 折叠与 delta')
{
  // 5 个同名按钮（同父）→ 只列 3 个 + 一条折叠提示
  const parent = mkEl('div', {})
  const btns = []
  for (let i = 0; i < 5; i++) { const b = mkEl('button', { text: '编辑' }); b.parentNode = parent; btns.push(b) }
  globalThis.document.querySelector = () => null
  globalThis.document.querySelectorAll = (sel) => (sel.includes('[role="button"]') || sel === 'button' ? btns : [])
  const collapsed = P.inPageOutline({ limit: 50 })
  ok(collapsed.ok === true, 'outline 成功')
  const shown = collapsed.rows.filter((r) => r.ref)
  const folds = collapsed.rows.filter((r) => r.collapsed)
  ok(shown.length === 3, '同类只列前 3 个', String(shown.length))
  ok(folds.length === 1 && /另有同类元素/.test(folds[0].name), '多出来的折成一条', JSON.stringify(folds))
  ok(collapsed.rows.length === 4, '总行数 = 3 + 1 折叠行', String(collapsed.rows.length))

  // 作用域：selector 命中容器 → 只看容器内
  const inner = mkEl('button', { text: '保存' })
  inner.parentNode = parent
  const scope = { querySelectorAll: () => [inner] }
  globalThis.document.querySelector = (sel) => (sel === '#panel' ? scope : null)
  const scoped = P.inPageOutline({ selector: '#panel' })
  ok(scoped.rows.length === 1 && scoped.rows[0].name === '保存', 'selector 只看容器内', String(scoped.rows.length))

  // 容器不存在 → NOT_FOUND，不抛异常
  const miss = P.inPageOutline({ selector: '#nope' })
  ok(miss.ok === false && miss.errorCode === 'NOT_FOUND', '容器不存在报 NOT_FOUND')

  // 增量：基线之后新增一个按钮 → delta.added 里有它
  globalThis.document.querySelector = () => null
  globalThis.document.querySelectorAll = (sel) => (sel.includes('[role="button"]') || sel === 'button' ? btns : [])
  P.inPageOutline({ limit: 50 })
  const fresh = mkEl('button', { text: '确认' })
  fresh.parentNode = parent
  btns.push(fresh)
  const delta = P.inPageDelta({})
  ok(delta.ok === true && delta.changed === true, 'delta 报出变化')
  ok(delta.added.some((r) => r.name === '确认'), '新增元素在 added 里', JSON.stringify(delta.added))
  ok(delta.addedCount === 1 && delta.removedCount === 0, '计数对', JSON.stringify({ a: delta.addedCount, r: delta.removedCount }))
}
/* ---------------- 9. 稳定 ref 编号 ---------------- */
console.log('9) 稳定 ref')
{
  const wrap = mkEl('div', {})
  const a = mkEl('button', { text: '甲' }); a.parentNode = wrap
  const b = mkEl('button', { text: '乙' }); b.parentNode = wrap
  const setList = (list) => { globalThis.document.querySelectorAll = (sel) => (sel.includes('[role="button"]') || sel === 'button' ? list : []) }
  globalThis.document.querySelector = () => null

  setList([a, b])
  const first = P.inPageOutline({})
  const refA1 = first.rows.find((r) => r.name === '甲').ref
  const refB1 = first.rows.find((r) => r.name === '乙').ref
  ok(/^e\d+$/.test(refA1), '拿到编号', refA1)

  const second = P.inPageOutline({})
  ok(second.rows.find((r) => r.name === '甲').ref === refA1, '再 outline 甲还是同号', second.rows.find((r) => r.name === '甲').ref)
  ok(second.rows.find((r) => r.name === '乙').ref === refB1, '再 outline 乙还是同号')

  const c = mkEl('button', { text: '丙' }); c.parentNode = wrap
  setList([a, b, c])
  const third = P.inPageOutline({})
  const refC = third.rows.find((r) => r.name === '丙').ref
  ok(refC !== refA1 && refC !== refB1, '新元素拿新号', refC)
  ok(third.rows.find((r) => r.name === '甲').ref === refA1, '老元素编号不受新元素影响')
}
/* ---------------- 10. selector 多匹配别替人挑 ---------------- */
console.log('10) selector 多匹配')
{
  const a = mkEl('button', { text: '签到', className: 'ckb' })
  const b = mkEl('button', { text: '抽奖', className: 'ckb' })
  const prevQSA = globalThis.document.querySelectorAll
  const prevQS = globalThis.document.querySelector
  globalThis.document.querySelector = (sel) => (sel === 'button.ckb' ? a : prevQS(sel))
  globalThis.document.querySelectorAll = (sel) => (sel === 'button.ckb' ? [a, b] : prevQSA(sel))

  const multi = P.inPageClick({ selector: 'button.ckb' })
  ok(multi.ok === false && multi.errorCode === 'MULTI_MATCH', '命中两个 → MULTI_MATCH', JSON.stringify(multi).slice(0, 160))
  ok(multi.matched === 2 && multi.candidates.length === 2, '报出命中数和候选', JSON.stringify(multi.candidates))
  ok(!a.clickedCount && !b.clickedCount, '一个都没点', String(a.clickedCount) + '/' + String(b.clickedCount))

  const withIndex = P.inPageClick({ selector: 'button.ckb', index: 1 })
  ok(withIndex.ok === true, '显式 index 就能点', JSON.stringify(withIndex).slice(0, 120))
  ok(b.clickedCount === 1 && !a.clickedCount, '点的是第 2 个')

  const one = P.inPageClick({ selector: 'button.ckb', index: 0 })
  ok(one.ok === true && one.matched === 2, '命中数照实回（matched）', String(one.matched))

  globalThis.document.querySelectorAll = (sel) => (sel === 'button.ckb' ? [a] : prevQSA(sel))
  const single = P.inPageClick({ selector: 'button.ckb' })
  ok(single.ok === true && single.matched === 1, '只命中一个时照常点', String(single.matched))

  globalThis.document.querySelector = prevQS
  globalThis.document.querySelectorAll = prevQSA
}
/* ---------------- 11. text 多匹配别替人挑（1.15.0） ---------------- */
console.log('11) click(text) 多匹配 → 候选列表')
{
  const mkBox = (kids) => {
    const box = mkEl('div', { text: kids.map((k) => k.innerText).join(' ') })
    box.children = kids
    box.contains = (o) => o === box || kids.some((k) => k === o || (k.contains && k.contains(o)))
    for (const k of kids) { k.parentElement = box; k.parentNode = box }
    return box
  }
  const b1 = mkEl('button', { text: '接口管理' })
  const b2 = mkEl('button', { text: '接口管理' })
  const b3 = mkEl('button', { text: '接口管理（新）' })
  const box1 = mkBox([b1]); const box2 = mkBox([b2]); const box3 = mkBox([b3])
  const prevQSA = globalThis.document.querySelectorAll
  globalThis.document.querySelectorAll = (sel) => {
    if (sel.includes('[role="button"]')) return [box1, box2, box3, b1, b2, b3]
    return prevQSA(sel)
  }
  // 两处同名（菜单 + 面包屑那种）：都精确命中，容器被「只在命中集合里下沉」排掉
  const multi = P.inPageClick({ text: '接口管理' })
  ok(multi.ok === false && multi.errorCode === 'MULTI_MATCH', '命中多个 → MULTI_MATCH', JSON.stringify(multi).slice(0, 140))
  ok(multi.candidates.length === 2, '只报叶子候选，不把容器算进去', JSON.stringify(multi.candidates))
  ok(!b1.clickedCount && !b2.clickedCount, '一个都没点')
  // index 选第二个
  const byIndex = P.inPageClick({ text: '接口管理', index: 1 })
  ok(byIndex.ok === true && b2.clickedCount === 1 && !b1.clickedCount, 'index=1 点的是第二个', JSON.stringify(byIndex.clicked || {}).slice(0, 80))
  // exact：完全相等才算，所以「接口管理（新）」只命中 b3
  b1.clickedCount = 0; b2.clickedCount = 0
  const byExact = P.inPageClick({ text: '接口管理（新）', exact: true })
  ok(byExact.ok === true && b3.clickedCount === 1 && !b1.clickedCount && !b2.clickedCount,
    'exact 精确命中唯一那个', JSON.stringify(byExact.clicked || {}).slice(0, 80))
  globalThis.document.querySelectorAll = prevQSA
}

/* ---------------- 12. outline 折叠菜单提示 ---------------- */
console.log('12) outline 折叠菜单')
{
  const prevQSA = globalThis.document.querySelectorAll
  const menu = mkEl('li', { text: '数据总线', attrs: { role: 'menuitem', 'aria-expanded': 'false' } })
  const child = mkEl('button', { text: '接口管理', rect: { width: 0, height: 0 } })
  child.parentElement = menu
  menu.contains = (o) => o === menu || o === child
  globalThis.document.querySelectorAll = (sel) => {
    if (sel.includes('[role="button"]')) return [menu, child]
    return prevQSA(sel)
  }
  const out2 = P.inPageOutline({ limit: 50 })
  ok(out2.hiddenInCollapsed === 1, '折叠菜单里的隐藏元素被计数', String(out2.hiddenInCollapsed))
  ok(Array.isArray(out2.collapsedTriggers) && out2.collapsedTriggers.some((x) => x.name === '数据总线'),
    '记下该展开哪个菜单', JSON.stringify(out2.collapsedTriggers))
  ok(!out2.rows.some((r) => r.name === '接口管理'), '折叠里的元素不进列表')
  globalThis.document.querySelectorAll = prevQSA
}

/* ---------------- 13. read tables:"rows" ---------------- */
console.log('13) read tables:"rows"')
{
  const td = (t) => ({ tagName: 'TD', innerText: t, textContent: t })
  const th = (t) => ({ tagName: 'TH', innerText: t, textContent: t })
  const mkTable = () => ({
    rows: [
      { cells: [th('序号'), th('编码'), th('名称')] },
      { cells: [td('1'), td('person'), td('同步人员')] },
      { cells: [td('2'), td('material'), td('物料同步')] },
    ],
    parentNode: null,
  })
  const table = mkTable()
  const cloneTable = mkTable()
  const prevBody = globalThis.document.body
  const prevQSA = globalThis.document.querySelectorAll
  const root = mkEl('body', { text: '序号\n编码\n名称\n1\nperson\n同步人员' })
  root.querySelectorAll = (sel) => (sel === 'table' ? [table] : [])
  const holder = { text: '', replaceChild: (div) => { root.__text = div.textContent } }
  cloneTable.parentNode = holder
  root.cloneNode = () => {
    const clone = { querySelectorAll: (sel) => (sel === 'table' ? [cloneTable] : []), ownerDocument: { createElement: () => mkHost() } }
    Object.defineProperty(clone, 'innerText', { get: () => root.__text || '' })
    return clone
  }
  // 离屏容器：真实实现是挂到 body 上读 innerText（innerText 在游离节点上等于 textContent）
  function mkHost() {
    const host = {
      style: {},
      appendChild(c) { host.__clone = c; host.innerText = c.innerText || c.textContent || '' },
      removeChild() { host.__removed = true },
      get parentNode() { return root },
    }
    return host
  }
  root.appendChild = (host) => { root.__host = host }
  root.__removed = false
  root.ownerDocument = { createElement: mkHost, body: root, documentElement: root }
  globalThis.document.body = root
  globalThis.document.querySelectorAll = prevQSA
  const rd = P.inPageRead({ tables: 'rows', maxChars: 5000 })
  ok(rd.ok === true, 'read ok')
  ok(Array.isArray(rd.tables) && rd.tables.length === 1, '带回表格元信息', JSON.stringify(rd.tables || []))
  ok(rd.tables[0].rows === 2 && rd.tables[0].cols === 3, '行列数', JSON.stringify(rd.tables[0]))
  ok(rd.tables[0].headers.join('/') === '序号/编码/名称', '表头')
  ok(rd.text.includes('1 | person | 同步人员'), '正文按行展开', JSON.stringify(rd.text))
  globalThis.document.body = prevBody
}
process.exit(fails ? 1 : 0)
