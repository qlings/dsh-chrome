# MOM / ESB 企业后台配方

适用：MOM V5（portal + 各业务 iframe）、ESB 接口管理、低代码页面（`/lowcode/display/pc/*.html`）。
本文件来自 2026-11-25 实测（program: mom-v5-linux-5.0.3，门户 `<mom-host>:<port>`）。

## 1. 登录态

- 令牌在 `localStorage`：`m5_token`（JWT）、`m5_tokenType`（`Bearer`）、`m5_expreTime`。
- `fetch` 用 `authFrom` 自动加头，不要把 token 贴进对话：

```json
{"action":"fetch","url":"/api/v1/perf/perf_root/query","method":"POST",
 "authFrom":{"key":"m5_token","typeKey":"m5_tokenType"},"body":{"page":1,"limit":50},"json":true}
```

- 过期后接口回 401：先刷新页面重新登录，或让用户重登；不要反复重放。
- `replay` **同样支持 `authFrom`**（2026-11-27 实测）：探针行重放时 `Authorization` 已被脱敏，不补必 401；补上就 200，不用先 eval 取 token 再手拼头。

## 2. 必带业务头（照抄抓包，别按模板猜）

不同部署的头不一样，**以 `networkDetail` 抓到的这一条为准**。某套 MOM 5 实测只需要这几个：

| 头 | 值 | 说明 |
|---|---|---|
| `authorization` | `Bearer <token>` | `fetch` 用 `authFrom:{"key":"m5_token","typeKey":"m5_tokenType"}` 自动拼 |
| `moduleCode` | 如 `BSM_ProcessLine` | **随接口/模块变**：方案接口 `BSM_ProcessProject`、路线 `BSM_ProcessLine`、订单 `BSM_productOrder`；抄错/不传会回 `code:1 未授权` |
| `language` / `platform` | `zh-cn` / `pc` | 基本都要 |
| `Content-Type` | `application/json;charset=UTF-8` | POST 必带 |

有的部署（如 perf/dms 门户）还会校验 `X-Action-Code`、`X-App-Code`、`X-Function-Code`；另一套 MOM 不需要。

`fetch` 的 `headers` 只写非默认项，`authFrom` 负责 authorization。

## 3. 只收 POST

- 很多接口 GET 会被 openresty 直接 401（不是接口不存在）。
- 字典接口也是这样：GET 401，POST + 空体 `{}` 正常：

```json
{"action":"fetch","url":"/api/v1/bd/v_bd_dict/querybytype_code?typecodes=%5B%27PERF_KpiType%27%5D",
 "method":"POST","headers":{"X-App-Code":"perf","moduleCode":"perf_KPIConfig"},"body":{},"json":true}
```

## 4. 查询体形状（重点）

平台分页查询不是 `{conditions:[...]}`，而是：

```json
{
  "pageIndex": 1,
  "pageSize": 50,
  "orderSort": "[]",
  "conditions": "[{\"name\":\"pcode\",\"value\":\"1\",\"compare\":0,\"character\":0}]"
}
```

- `conditions` 是 **JSON 字符串**，不是数组；传数组会报 `JsonToken EndArray ...`。
- `compare`：0=Equal；`character`：0=And；嵌套用 `child:[...]`。
- 直接传 `{"page":1,"limit":50}` 也能查（服务端宽松），但带条件时必须用上面的形状。

## 5. 常用接口

| 用途 | 接口 | 备注 |
|---|---|---|
| 菜单树 | POST `/api/v1/sm/menutree/menu_role_tree`，body `{}` | 返回 `{total,datas:[{code,pcode,title,link,...}]}`，扁平结构，用 pcode 拼树 |
| 用户部门树 | POST `/api/v1/sm/department/querydata` | 左树数据源 |
| 字典 | POST `/api/v1/bd/v_bd_dict/querybytype_code?typecodes=['X']` | typecodes 要 URL 编码 |
| 低代码数据 | POST `/api/v1/lowcode/lowcode_model/querydata`，body `{model_code}` | 页面里的 model_code 是写死的，从 html 里搜 |
| 流程 | POST `/api/v1/wf/start_task` | 调整单等审批流 |
| 通用表查询 | POST `/api/v1/<模块>/<表名>/Query`，body 同分页形状 | 只读取证用；`wf_task`、`wf_cosignconfig` 实测可用，未注册的表回 `code:1 未找到对应服务`（≠ 表是空的）。表名不可枚举，别靠猜 |
| 审批流取证 | 见 `mom-workflow.md` | 模板/任务/审批详情/状态码语义 |

低代码页面的地址形如 `/lowcode/display/pc/<page>.html?ModuleCode=<code>`；页面真正读的是 html 里写死的 `model_code`（例如
`shengchanzhiling.html` → `mes_prod_adjust_applyXX`），**不是 URL 里的 ModuleCode**。

## 6. 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| GET 401（openresty 页面） | 网关不让 GET | 改 POST + 业务头 |
| 400 `JsonToken EndArray ...` | conditions 传了数组 | 改成 JSON 字符串 |
| 400 `Unexpected character ... P` | body 是字符串被二次编码 | 传对象；1.16.0 起字符串 JSON 会自动补头 |
| 415 Unsupported Media Type | body 是字符串且没 Content-Type | 传对象，或显式加 `Content-Type: application/json` |
| 401 但带了 token | token 过期/缺 X-Function-Code | 刷新登录；补齐业务头 |
| 返回 `code:1` + 中文 msg | 业务校验失败 | 按 msg 修参数 |

## 7. 门户 iframe

- 门户壳页只有菜单，业务在 iframe。**用户说「几个界面都开着」时先 `frames`，别只看 `tabs`**——这些业务页常常是同一个壳页里的多个 iframe（`tabs` 可能只有一两个）。
- `frames` 查 frameId 与可见性；`read` 会自动下沉，但回执会写「自动下沉到 iframe …」，别把子帧正文当成你传的那一帧；`fetch` 的相对地址按当前帧解析。
- `display:none` 的帧（没被激活的业务页）：`outline` 列 0 个、`click` 点不到，改用 `eval` 在帧内 `.click()`，提交后回查接口（配方见 `tables-dialogs.md` §5.1）。
- **frameId 会随导航作废**：业务页 `location.href` 跳转后旧编号立即失效，报 `FRAME_STALE`（不是 CSP）。审批提交这类会跳转的操作，前后各跑一次 `frames`；门户里还可能连带关掉别的业务页（2026-11-27 实测 9 个帧 → 2 个、回到首页），动手前先记下要复用的 URL。
- 抓接口先 `networkLog`（含各帧），再 `networkDetail` 看请求头，最后 `replay` 原样重发做对照。噪声过滤：`ignore:"i18n|weather|UnhandledMsgCount|heartbeat|unReadCount"`。
- `networkDetail` 的 `filter` 是子串匹配：`routeActivity/query` 会命中 `queryActivityInfo`，用 `match:"path"` 或 `index` 选（index 在 filter 命中集合里数，0=最新）；响应体要全文就加 `saveTo`。
- 行尾 `#pN` 是页面探针行：可以直接 `requestId:"pN"`；探针默认不记响应体，要看返回先在页面里 `window.__dshProbeRespLimit = 2000` 再复现。多帧页面里探针 `#pN` 会重名，用 `filter`+`match:"path"` 定位更稳。
- 一次抓多个接口：`fetch` + `urls` + `saveToDir`，每个接口给一组表头用 `headersList`（与 `urls` 对齐）；同 URL 不同 body 的批量用 `nameFrom:"字段名"`（落盘成 `01_<字段值>.json`）。
- 需要写操作时先 `netBlock` 只登记，确认提交内容再放行：

```json
{"action":"netBlock","patterns":["task_approve"],"op":"set"}
{"action":"netBlock","op":"hits"}
{"action":"netBlock","op":"off"}
```

- **不可逆动作**（审批同意/驳回、下单、删除）先走上面三步拿到真实请求体，再真提交；提交后用详情接口（如 `get_approve_detail`）核对结果，别只看页面提示。

## 8. 业务流引擎（Node-RED）只读排查

接口管理背后是 Node-RED 4.x（`httpAdminRoot=/flow`、`httpNodeRoot=/esb/api`），流程存在数据库 `flows.flow_data` 里。

- **读单条流程**：`GET /flow/flow/<flow_id>`，返回 `{id,label,disabled,info,nodes:[...]}`（每个节点带 `func`/`url`/`rules`/`wires`）。
- **绝对不要** `POST /flow/flows`：那是“保存/部署”，会覆盖线上流程。
- 判断有没有未保存改动：`RED.nodes.dirty()` 为 false，且部署按钮 class 里含 `disabled`，表示“已部署且无未保存改动”。
- **读 debug 面板**（流程调试的现场证据，比猜快得多）：

```js
[...document.querySelectorAll('.red-ui-debug-msg')]
  .map((n) => (n.innerText || '').replace(/\s+/g, ' '))
  .slice(-20)
```

- 部署窗口期 http-in 会短暂 404；刚部署完遇到 404 先等一两秒再试。
- `/esb/api/*` 走网关，约 15s 超时会返回 404 HTML「Sorry, Page Not Found」——不是路由不存在。
- 流程里 `http request` 报 `RequestError: socket hang up`：多半是上游（NC/WMS）60s 没回，先查上游日志，别在 Node-RED 里反复重试（可能重复建单）。
