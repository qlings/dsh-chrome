/**
 * fetchplan 的自测：批量文件命名 + 只看结构的摘录。
 *
 * 背景（2026-11-24 抓 17 个流程定义）：没有批量就是 3 次 eval + 手写 slice；
 * 没有 shape 就得把 2.8 万字响应体读进上下文才知道里面有什么字段。
 */
import { fileNameFromUrl, shapeOf, stemFromBody } from '../lib/fetchplan.js'

let fails = 0
const ok = (cond, name, extra) => {
  if (cond) console.log('  ok   ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

console.log('1) 文件名从 URL 推出来，带序号前缀，去掉 query/hash')
{
  ok(fileNameFromUrl('http://h/flow/flow/611024e75b600444', 0) === '01_flow_611024e75b600444',
    '取路径最后两段 + 序号', fileNameFromUrl('http://h/flow/flow/611024e75b600444', 0))
  ok(fileNameFromUrl('http://h/api/v1/esb/flows/list?page=1#x', 11) === '12_esb_flows_list' ||
     fileNameFromUrl('http://h/api/v1/esb/flows/list?page=1#x', 11) === '12_flows_list',
    '去掉 query/hash', fileNameFromUrl('http://h/api/v1/esb/flows/list?page=1#x', 11))
  ok(/^03_/.test(fileNameFromUrl('http://h/a/b', 2)), '序号从 1 开始补两位', fileNameFromUrl('http://h/a/b', 2))
  ok(fileNameFromUrl('http://h/', 0) === '01_h', '根路径退回 hostname', fileNameFromUrl('http://h/', 0))
  ok(fileNameFromUrl('', 0) === '01_item', '空 URL 不炸', fileNameFromUrl('', 0))
  ok(fileNameFromUrl('http://h/a/b', 0, 'flow') === '01_flow_a_b', '能加前缀', fileNameFromUrl('http://h/a/b', 0, 'flow'))
  const weird = fileNameFromUrl('http://h/a b/c%20d', 0)
  ok(!/[\s%?]/.test(weird), '非法字符被清掉', weird)
  ok(fileNameFromUrl('http://h/' + 'x'.repeat(200), 0).length <= 85, '超长名被截断')
}

console.log('2) 结构摘录只给字段和类型，不给值')
{
  const data = { code: 0, msg: 'Success', data: { total: 1029, datas: [{ id: 'X', mat_code: 'M1', price: 1.5 }] } }
  const s = shapeOf(data)
  ok(s.includes('code: number(int)'), '整数标 int', s)
  ok(s.includes('msg: string'), '字符串')
  ok(s.includes('datas: array(1) of'), '数组给长度', s)
  ok(s.includes('mat_code: string'), '数组元素字段也列出来')
  ok(!s.includes('M1') && !s.includes('1029'), '不带任何值', s)
}

console.log('3) 深度与字段数可调，且有截断提示')
{
  const deep = { a: { b: { c: { d: 1 } } } }
  const s2 = shapeOf(deep, { depth: 2 })
  ok(s2.split('\n').length < 8, 'depth 限制了层数', s2)
  const many = {}
  for (let i = 0; i < 60; i++) many['k' + i] = i
  const s3 = shapeOf(many, { maxKeys: 5 })
  ok(s3.includes('另有 55 个字段'), '多余字段给数量', s3.split('\n').slice(-2).join(' / '))
  const rows = []
  for (let i = 0; i < 300; i++) rows.push({ i, name: 'n' })
  ok(shapeOf(rows).startsWith('array(300) of'), '大数组不展开', shapeOf(rows).split('\n')[0])
  ok(shapeOf(null) === 'null', 'null'); ok(shapeOf('x') === 'string', '标量')
  ok(Array.isArray([]) && shapeOf([]) === 'array(0)', '空数组')
  ok(shapeOf({}) === '{}', '空对象', shapeOf({}))
}

console.log('4) nameFrom：从请求体取字段当文件名主干（1.20.0）')
{
  const body = { wftmpCode: 'F20261001111114225', flowVersion: 24 }
  ok(stemFromBody(body, 'wftmpCode') === 'F20261001111114225', '对象取顶层字段', stemFromBody(body, 'wftmpCode'))
  ok(stemFromBody(JSON.stringify(body), 'wftmpCode') === 'F20261001111114225', 'JSON 字符串也能取', stemFromBody(JSON.stringify(body), 'wftmpCode'))
  ok(stemFromBody({ wftmpCode: 'x1' }, 'body.wftmpCode') === 'x1', '支持 body. 前缀（指请求体自身）', stemFromBody({ wftmpCode: 'x1' }, 'body.wftmpCode'))
  ok(stemFromBody({ data: { id: 'A-1' } }, 'data.id') === 'A-1', '嵌套路径', stemFromBody({ data: { id: 'A-1' } }, 'data.id'))
  ok(stemFromBody({ list: [{ code: 'c9' }] }, 'list.0.code') === 'c9', '数组下标', stemFromBody({ list: [{ code: 'c9' }] }, 'list.0.code'))
  ok(stemFromBody({}, 'missing') === '', '取不到返回空串（回落 URL 命名）')
  ok(stemFromBody({ v: 'a/b:c*?"<>|d' }, 'v') === 'a_b_c_d', '清掉 Windows 非法字符', stemFromBody({ v: 'a/b:c*?"<>|d' }, 'v'))
  ok(stemFromBody({ v: '异常审批' }, 'v') === '异常审批', '中文照留')
  ok(stemFromBody({ v: { nested: 1 } }, 'v') === '', '对象值不当文件名')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
