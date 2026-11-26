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

- 门户壳页只有菜单，业务在 iframe。`frames` 查 frameId；`read` 会自动下沉，`fetch` 的相对地址按当前帧解析。
- 抓接口先 `networkLog`（含各帧），再 `networkDetail` 看请求头，最后 `replay` 原样重发做对照。
- `networkDetail` 的 `filter` 是子串匹配：`routeActivity/query` 会命中 `queryActivityInfo`，用 `match:"path"` 或 `index` 选；响应体要全文就加 `saveTo`。
- 一次抓多个接口：`fetch` + `urls` + `saveToDir`，每个接口给一组表头用 `headersList`（与 `urls` 对齐）。
- 需要写操作时先 `netBlock` 只登记，确认提交内容再放行。
