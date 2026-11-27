# 表格、行内按钮与弹窗

## 1. 三种读法，按场景选

| 场景 | 用法 | 说明 |
|---|---|---|
| 要点某一行/勾选 | `rows` | `{"action":"rows","in":"tbody tr","limit":20}`，一行一条 + ref + 勾选态 |
| 要表格正文 | `read` + `tables:"rows"` | 一行一条记录，表头单独一行；`tableRows`/`tableLimit` 控规模 |
| 要看整页内容 | `read` | 默认会把单元格拆成一行一格，表格页优先上面两种 |

## 2. 按行文本定位

```json
{"action":"check","rowText":"GY01-GWTEST01020260121171100","in":".el-table__body-wrapper .el-table__row",
 "target":"input[type=checkbox]","rowMatch":"includes"}
```

- `rowMatch`：`auto` / `equals` / `startswith` / `includes`；怕误命中写 `equals`。
- 命中多行：1.16.0 起可加 `index`（从 0 开始）直接指定第几行；错误回执也会提示。
- 行内按钮：`in` 行容器 + `rowText` + `target:"button:has-text('编辑')"` 不一定支持 `:has-text`，用 `target` 指到按钮的 class 或先 `rows` 拿 ref。

## 3. 选中态：click 还是 check

- 勾选框、开关：**用 `check`**（幂等，重复跑不会点反）。
- 表格行选中（`selection-change`）：必须点到 `input[type=checkbox]` 本体，`check` 默认就会找它；只点单元格不会触发 Element 的选中事件。
- 先盘点：`isChecked` 一次拿到 total/checkedCount/每行状态。

## 4. 禁用按钮

1.16.0 起，点到 `disabled` / `aria-disabled="true"`（含祖先）会直接返回：

```
errorCode: ELEMENT_DISABLED
「编辑」当前是禁用状态（disabled / aria-disabled），点击不会触发任何行为。
先满足它的前置条件（例如先在表格里选中一行、勾选一条），或用 action=vue + call 直接调组件方法；
确认要硬点再加 force:true。
```

- 正确顺序：先 `check` 选中行 → 等按钮变为可用（`wait selector` 或重读 `outline`）→ 再 `click`。
- 不要 `el.disabled=false; el.click()`：Vue 的内部 disabled 计算没变，事件处理器仍会拒绝执行。
- 确实要绕过（只读演示）：`force:true`，但要知道页面状态不会因此改变。

## 5. 弹窗（ElDialog / Drawer / Teleport）

- 点击后先 `wait selector:".el-dialog"` 或 `wait text:"新增"`，再截图/填表。
- 浮层 teleport 到 `body`，同名 class 可能有多份：选择器加 `:not([style*="display: none"])`，或先筛可见元素。
- 关弹窗：点「取消」或右上角关闭；用 `press Escape` 有时更稳。
- 弹窗内容截不全：`screenshot` 用 `selector:".el-dialog"`，不要整屏。

### 5.1 display:none 的 iframe 里点按钮 + 走完弹窗（MOM 审批页实测 2026-11-27）

门户里的业务页经常挂在不可见的 iframe 上（用户切到别的标签后它还在），`outline` 会列 0 个元素、`click` 也点不到。打法：

```js
// ① 在目标帧里点按钮（frame 用 action=frames 拿）
[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '同意').click();
// ② 读弹窗：.el-dialog 里按文字找确定；弹窗 visible 为 false 不影响点击
const dlg = document.querySelector('.el-dialog');
[...dlg.querySelectorAll('button')].find(b => b.innerText.trim() === '确定').click();
```

- **点完必须回查接口**：`networkLog{"filter":"task_approve"}` → `networkDetail{"filter":"task_approve","match":"path"}`，确认状态码与请求体；`el.click()` 不会报错，接口没发出去的话页面看起来一样。
- 提交类操作会让页面 `location.href` 跳转，**该帧的 frameId 立即作废**（再操作报 `FRAME_STALE`）；提交后重新 `frames`，或直接查接口确认结果。
- 需要填的输入框：先 `eval` 里读 `dlg.querySelectorAll('input,textarea')` 看当前值，再决定要不要改（很多弹窗默认已填「同意」）。

## 6. 表格排查清单

1. 表格在不在 iframe 里？（`frames`，或看 `read` 回执的 `frame:{auto:true}`）
2. 行容器选择器对不对？（Element 是 `.el-table__body-wrapper .el-table__row`；Ant 是 `.ant-table-tbody > tr`）
3. 文字是否被截断/换行？（`rowMatch:"includes"` + 唯一片段）
4. 是否有同名行？（加 `index` 或 `equals`）
5. 点完没反应？（看是否 disabled；看是否被浮层遮挡；加 `expect:{changed:true}`）

## 7. 同一区块多个同名按钮（Element Plus 折叠面板）

工单/详情页常把「消耗、退库、旧件退库」各做成一个 `el-collapse-item`，每块都有「新增/保存/删除/提交/刷新」。`click text:"提交"` 会命中多个，`outline` 里也看不出属于哪块。

按区块标题 scoping 最稳（2026-11-26 维修工单退库实测）：

```js
const sec = [...document.querySelectorAll('.el-collapse-item')]
  .find((x) => x.innerText.includes('备品备件退库'));
[...sec.querySelectorAll('button')].find((b) => b.innerText.trim() === '提交').click();
```

- 先确认勾选：`sec.querySelector('.el-table__body input[type=checkbox]').checked`；没勾就先 `check`，否则提交按钮即使可点也会被前端拦下。
- 同名按钮尽量别用坐标点击：折叠面板一滚动，坐标就失效。
- `outline` 对 Node-RED 画布这类几万个可交互元素的页面基本不可用；直接在 `eval` 里 scoping 更快（Node-RED 的调试见 `mom-backend.md` §8）。
- Vue 组件实例取不到（`__vueParentComponent` 为空）时，不要硬递归 vnode：先 `vue` + `selector`，仍不行就退回 DOM scoping。
