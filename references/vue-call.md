# Vue 组件：读状态、调方法、开弹窗

适用：Element Plus / Ant Design 等 Vue 2/3 页面，尤其是「按钮 disabled、弹窗没有 DOM 入口」的场景。

## 1. 先定位组件

```json
{"action":"vue","selector":".el-table","pick":"AllDataSource"}
{"action":"vue","ref":"e12"}
{"action":"vue","tree":true,"maxDepth":3}
```

- 不给 ref/selector 时从 `#app` 往上找最近的组件。
- 回执给组件名、props、data 键、methods；`pick` 直接取值。
- 找不到：先 `outline` 确认这块 DOM 真的渲染了（`v-if` 关着时组件不存在）。

## 2. 手动拿实例（eval 兜底）

```js
const el = document.querySelector('#app')
const root = el._vnode.component            // 注意：app._instance 常为 null
const inst = document.querySelector('.el-table').__vueParentComponent
inst.exposed                                // setup 里 expose 的方法
inst.setupState                             // setup 返回的 ref/函数（proxyRefs，已解包）
```

遍历组件树必须带 `seen` + `maxDepth`，否则 `children`/`dynamicChildren` 重复导致指数递归，页面直接卡死：

```js
const walk = (v, out = [], seen = new Set(), d = 0) => {
  if (!v || d > 30 || seen.has(v)) return out
  seen.add(v)
  if (v.component) { out.push(v.component); walk(v.component.subTree, out, seen, d + 1) }
  if (Array.isArray(v.children)) for (const c of v.children) walk(c, out, seen, d + 1)
  return out
}
```

## 3. 弹窗打不开：用 call，不要硬点

典型：表格工具条的「编辑」按钮 disabled（未选中行）；或弹窗只能由组件方法打开。

```json
{"action":"vue","selector":"#app","tree":true,"maxDepth":4}
{"action":"vue","ref":"e20","call":"openDialog","args":["add",{"code":"X"}]}
```

- `name` 先按组件名在组件树里定位（如 `HFormDialog`、`SubTable`），再对它 `call`；不给 `name` 就用 ref/selector 最近的组件。\n- `call` 查找顺序：`inst.exposed` → `inst.setupState` → `inst.ctx/proxy` → Vue2 `$options.methods`。\n- Vue3 生产构建常常只有容器上的 `__vue_app__`（子节点没有 `__vueParentComponent`）：1.16.0 起自动退回 `app._instance`，`vue` 仍可用。
- 方法名从 `methods` 列表里抄，不要猜；`openDialog`/`open`/`add`/`handleAdd` 是常见名字。
- 需要先选中行时，优先用 `check` 真勾选（触发 `selection-change`），再点按钮；不要 `disabled=false` 后 `click()`——Vue 内部状态没变，弹窗照样不开。
- 返回 `callError` 就说明名字不对或方法内部报错；先不加 `call` 看 methods。

## 4. 受控输入

- 用 `type` 动作（原生 setter + input/change 事件 + 回读校验）。
- 框架仍不理：先 `wait` 元素稳定，再 `type`；必要时 `vue` 找到 `v-model` 对应的 ref 直接赋值，然后等一个微任务：

```js
inst.setupState.form.code = 'X'
await new Promise(r => setTimeout(r, 0))
```

## 5. 页面卡死自救

- 预防：不裸递归 vnode、不 `while(true)`、长循环分片 + `await new Promise(r=>setTimeout(r,0))`。
- 已经卡死：先等看门狗（超时 + 20 秒）收场；`abort hard:true` 只在页面还活着时有效；最后手段 `reload` 该标签。
- 别在卡死时连发命令：轮询是串行的，命令只会排队。
