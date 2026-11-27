# 更新记录

每个版本都说清楚「哪次真实任务卡住了」和「现在怎么解」。按版本倒序。

## 1.20.1 改了什么（1.20.0 的自摆乌龙）

`1.20.0` 的文档写了「`replay` 也接受 `authFrom`」，实现里却只有 `fetch` 有。当时「实测 200」是误判：重放恰好命中 CDP 抓到的原请求，它自带 `Authorization`，跟 `authFrom` 没关系；换成探针行（凭据被打码）立刻 401。

- `authFrom` 抽成 `resolveAuthFrom()`，`fetch` 与 `replay` 共用：令牌从页面 `localStorage` 取、拼成 `Bearer <token>`、合并进请求头（不覆盖其它头，大小写不敏感由扩展侧处理）；
- `replay` 回执加一行「已按 authFrom … 取令牌」，不回显令牌；取不到令牌时直接报错、不发请求；
- 补 3 组自测：令牌真的合并进 `headers.authorization`、回执不泄露令牌、令牌为空时不发请求。

> 升级注意：只动 `lib/`。重启 DSH 生效（扩展没改，不必重载；`page.js` 版本号跟随发布号，会提示 F5）。

## 1.20.0 改了什么（一次 MOM 审批流「所有人必须同意」排查带出来的）

2026-11-27 查「审批流配了所有人必须同意，一人同意就结束」：配置侧只花了几分钟，剩下时间全耗在 iframe 与取证上——用户说「三个界面都开着」而 `tabs` 只有两个；审批页在 `display:none` 的 iframe 里；点完「同意」页面跳转、旧 frameId 立刻失效；重放模板接口时 401 错误页还盖掉了刚抓的 JSON。

| 卡点 | 现在怎么解 |
|---|---|
| 提交审批后 iframe 导航走了，再对旧 frameId 操作报 `INJECT_FAILED`「这个页面不让注入扩展脚本」，排查方向被带到 CSP | executor 认 Chrome 的 `No frame with id ...` 原文，改报 `FRAME_STALE`，并说明「iframe 跳转后 frameId 会变，先 `frames`」 |
| `replay` 没带凭据 → 401，网关 HTML 被写进指定的 `.json`，回执还写「已落盘（全量）」 | 失败响应（≥400 或 HTML 错误页）另存为 `xxx.err.html`，目标文件不覆盖；401 回执直接给 `authFrom` 提示 |
| `saveTo` 批量抓 22 个同 URL、不同 body 的模板，文件名只有 `01_/02_…`，只能按顺序反推 | `fetch` 加 `nameFrom:"字段名"`（如 `wftmpCode`）→ `01_F20261001111114225.json`；取不到值时回落 URL 命名并在回执说明 |
| `read frame=173` 实际读的是子帧 175，回执看不出来，容易张冠李戴 | `read` 自动下沉时回执写明「自动下沉到 iframe「标题」+ src」，并提示你传的 frame 不是它 |
| `outline` 对 `display:none` 的 iframe 列 0 个元素，只写「跳过 N 个隐藏」，不给下一步 | 全部隐藏时回执直接给打法：`eval` 帧内 `.click()`，提交后回查 `networkLog` |
| 文档没写「多个界面 = 一个壳页多个 iframe」「隐藏 iframe 怎么点」 | `SKILL.md` §0/§3/§4/§8 补齐；新增 `references/mom-workflow.md`（模板/任务/审批详情接口、`step_sts`/`task_sts` 语义、多人审批是否生效的三步判据）；`replay` 的 `authFrom` 当时只写了文档，1.20.1 才补实现 |

> 升级注意：`executor.js` 与 `page.js`（版本号）有改动，`lib/` 也有 —— 重载扩展 + 目标页 F5 **且**重启 DSH。判据：`diag` 里 `cs.pageVersion` 和 `status` 的扩展版本都是 `1.20.0`。

## 1.19.0 改了什么（一次维修工单退库接口排查带出来的）

2026-11-26 顺着「维修工单退库提交报缺少必要参数」排查时，真正拖时间的是取证工具本身：

| 卡点 | 现在怎么解 |
|---|---|
| `networkDetail` 传 `filter + index` 取到的是整个缓冲倒数第 N 条，候选却按 filter 算，照着候选下标选会落到隔壁接口（连踩 3 次） | index 统一为「filter 命中集合里倒数第 N 条」，候选 index 可直接回传；无 filter 时行为不变 |
| 报错发生在 CDP 挂上之前，探针行没有 id，既抢不过 CDP 也指不中 | 探针行分配 `pN` id；`networkDetail({requestId:"p12"})`、`source:"probe"`、`replay` 都能精确取到 |
| 探针只记请求体，要看「接口返回了什么」只能重新点一次提交（还多建了一张单） | 加 opt-in：页面里 `window.__dshProbeRespLimit = 2000` 才记响应体前 N 字，默认仍不记 |
| `fetch` 带 `saveTo` 就强解 JSON，拉 `.js`/`.html` 必刷「解析失败」 | 页面侧按 content-type/首字符嗅探；只有显式 `json:true` 才把解析失败当错误 |
| 网关 15s 超时返回 404 HTML，回执不提示，误判成「接口不存在」 | `fetch`/`networkDetail` 对 4xx + text/html 追加网关超时提示 |
| `networkLog` 时间戳只到秒，同秒多次提交分不清；pending 显示 `…` | 时间戳带毫秒；pending 明示 |
| `sourceSearch` 只报「28/28 个脚本」，0 命中时不知道扫了谁；懒加载的模块搜不到 | 回执列出扫过的文件；新增 `scripts:[...]` 显式指定，支持相对路径 |

> 升级注意：`cdp.js`/`probe.js`/`executor.js`/`page.js` 与 `lib/` 都有改动 —— 重载扩展 + 目标页 F5 **且**重启 DSH 才全部生效。判据：`diag` 里 `cs.pageVersion` 和 `status` 的扩展版本都是 `1.19.0`。

## 1.18.0 改了什么（把文档收进插件）

之前工具在插件里、文档在 `~/.dsh/skills/chrome`，两份东西：换机器、升级插件、或者只是忘了同步，工具和配方就会对不上。现在：

- 插件自带 `SKILL.md` + `references/`，`apply()` 时用 `ctx.skills.registerProvider` 注册成 skill「chrome」，`resourceBase` 指向插件目录，`references/xxx.md` 直接可读；
- rank 取 350（filesystem 的 user 根是 400、bundled 是 600，越小越优先），所以插件这份是唯一权威，`~/.dsh/skills/chrome` 可以删掉；
- 调用提示：第一次调用成功、以及每次失败时，回执末尾加一行「先读 skill「chrome」」，其余时候不掺噪音；
- 文档改动现在只改插件里的文件，版本跟 `package.json` / `manifest.json` / `page.js` 一起走；
- 顺手修了热重载的僵尸桥：bundle 关→开时上一实例的桥没停，还占着 18765，扩展继续轮询它、新实例被挤到 18766，表现是「桥起来了但扩展未连接」。现在桥登记在 `globalThis` 的在册表里，新实例启动前先把旧的停掉。

> 升级注意：只动了 `lib/`，扩展代码没变；重启 DSH 生效（扩展不必重装）。

## 1.17.0 改了什么（一次 MOM 投料量追溯带出来的）

顺着「工单确认弹窗 2750.7493 是怎么来的」查数据链时，真正费时的都是「取证工具不好用」：

| 卡点 | 现在怎么解 |
|---|---|
| 一次批量抓 5 个 MOM 接口，每个接口 `moduleCode` 不同，只能拆成 3 次调用（还先吃了一次「未授权」） | `fetch` 加 `headersList`：与 `urls` 一一对应，逐条合并到基础 `headers` |
| `networkDetail` 的 `filter` 是子串匹配，`routeActivity/query` 命中了 `queryActivityInfo`，差点拿错接口 | 加 `match:"path"`（忽略 query 的路径相等）/ `"regex"`；命中多条时回候选清单 + `index` |
| `networkDetail` 响应体只回前 1500 字、不能落盘；`replay` 拿到 4281 字也被截到 2000，只能改用 `fetch` 手拼 body+headers 再请求一遍 | 两者都支持 `saveTo`（全文，上限 2MB）；`replay` 用探针记的截断请求体时显式告警 |
| 落盘 JSON 是单行几千字，`read` 每行只回 2000 字，得再写脚本才能看 | `.json` 落盘自动缩进 2 空格（`pretty:false` 可关；`.txt` 保持原样） |

> 升级注意：`page.js`/`cdp.js`/`executor.js` 与 `lib/` 都有改动 —— 重载扩展 + 目标页 F5 **且**重启 DSH 才全部生效。

## 1.16.0 改了什么（一次 MOM 模块文档任务带出来的）

做绩效/指标/成本三套文档时，真正卡住的是「以为成功了其实没有」和「参数写了不生效」：

| 卡点 | 现在怎么解 |
|---|---|
| `screenshot` 传 `saveTo` 被静默忽略，图片还是落 `shots/` | `screenshot` 接上 `saveTo`，与 pdf/mhtml 一致：给路径按路径写 |
| `fetch` 的 `body` 传 JSON 字符串，服务端回 415（缺 Content-Type） | 字符串体若像 JSON 自动补 `application/json`；对象体行为不变 |
| 点 `disabled` 的「编辑」按钮，回执照写「已点击」，页面毫无反应 | 命中 disabled/aria-disabled（含祖先）直接回 `ELEMENT_DISABLED` + 前置条件提示；要硬点传 `force:true` |
| `rowText` 命中多行时提示「加 index」，但 `index` 对 rowText 无效 | `rowText` 支持 `index`（click 与 check 两处），文案同步 |
| Element 弹窗没有可点入口，`vue` 只能看不能调 | `vue` 加 `call`/`args`/`name`，走 `exposed` → `setupState` → `ctx` → Vue2 methods；按组件名定位 |
| SKILL.md 59KB，每个任务都要整读 | 主文件压到 ~90 行（决策树 + 高频配方），细节拆到 `references/{mom-backend,vue-call,screenshot-save,tables-dialogs}.md`，旧全文留 `references/full-1.15.0.md` |

> `vue` 另外修了两处：Vue3 生产构建常见只有 `__vue_app__`（没有 `__vueParentComponent`），已退回 `app._instance`；组件树改为沿 vnode.children 递归，能找到深处的 HFormDialog/SubTable。

> 升级注意：`page.js` 与 `lib/` 都有改动 —— 重载扩展 + 目标页 F5 **且**重启 DSH 才全部生效。

## 1.15.0 改了什么（一次 17 个接口的文档任务带出来的）

把一套 Node-RED 接口台账整理成交付文档时，真正拖时间的不是读写页面，而是「批量」和「找东西」：

| 卡点 | 现在怎么解 |
|---|---|
| 17 条流程定义要分 3 次 `eval`，还得手写 `slice(0,6)` 分批 | `fetch` 支持 `urls:[…]` + `saveToDir`：一条命令抓完，一个 URL 一个文件，失败的继续抓 |
| 每批回执都带 800 字代码 + 2.8 万字预览，落盘等于白落 | `saveTo`/`saveToDir` 存在时自动 `quiet`（代码与预览都不回显，`quiet:false` 可强制） |
| 为了知道接口有哪些字段，得把整份 JSON 读进上下文 | `fetch` 加 `shape:true`：只回「字段 + 类型」结构树，不带任何值 |
| 17 行的台账表 `read` 出来是「一格一行」，一屏半全是噪音 | `read` 加 `tables:"rows"`：表格按「一行一条记录」展开，表头单独一行 |
| `networkLog` 里心跳/轮询刷屏，看不出「一共调了哪些接口」 | 加 `unique:true`：按 `method+url` 去重只留最后一次，`×N` 是次数 |
| `click text:"接口管理"` 点成了「首页」——两个同名入口，旧逻辑顺着 DOM 挑了一个 | 只在命中集合内部下沉；多个候选回 `MULTI_MATCH` + 候选清单，用 `index` / `exact:true` 定死 |
| 二级菜单「接口管理」在 `outline` 里完全查不到，只能猜父菜单 | 回执提示「另有 N 个可交互元素在折叠菜单里」并给出该展开的父菜单名 |

## 1.14.0 改了什么（一次接口备份任务带出来的）

连续备份几十个页面时，暴露的都是「重复劳动」和「信息误导」：

| 卡点 | 现在怎么解 |
|---|---|
| 同一段 40 行导出脚本每批手打一遍，改一处漏一处 | `eval` 支持 `snippet`：脚本放 `~/.dsh/chrome/snippets/<name>.js`，`vars` 替换 `{{key}}`，`snippet:"?"` 列清单 |
| 46 条要点 ~105 秒，超过 90 秒看门狗就全丢，只能盲拆批次 | 单条命令超过 60 秒时回执提示实际上限；长任务把结果写 `window.__dshChunks`，超时后自动抢救成 `<saveTo>.partial.json` |
| 每个要鉴权的接口都得先 eval 读 token 再拼头，否则 openresty 401 | `fetch` 加 `authFrom`：从页面 localStorage 取令牌自动加 `authorization` 头，值不回显 |
| `status` 说「页面脚本是旧版，按 F5」，但其实是扩展比页面旧，F5 没用 | 版本比较改成分方向：页面旧 → F5；扩展旧 → 重载扩展 |
| `navigate` 到 `#flow/<id>` 回执「已到达」，但 Node-RED 根本没切画布 | 只改 hash 时标 `hashOnly` 并提示「页面没重载，视图是否切换看前端路由」 |
| `saveTo:"flows.json"` 落成 `flows.json.txt`，每次要回头确认真实文件名 | 已有已知扩展名就原样落，只有完全没扩展名时才补 |

## 1.13.0 改了什么（一次 Node-RED 流程引擎排查带出来的）

排查「包装产成品入库3-在用」的接口设计能不能找回旧版时，工具侧暴露了五个卡点：

| 卡点 | 现在怎么解 |
|---|---|
| 拿一份 159KB 的 `flows.json` 只能 `eval` + 手写 `fetch` + 手动切片，一次会话写了近 10 次 eval | 新增 `fetch`：页面上下文发请求（cookie 自动带），回执给状态码/全量长度/预览，`saveTo` 强制取全量并落盘；`json:true` 顺带解析 |
| `GET /api/v1/...` 连吃 5 个 openresty 401，没人提示「token 在 localStorage、接口只收 POST」 | `fetch`/`eval` 看到 401 追加鉴权提示：先 `networkDetail` 看页面自己的请求头，token 在 `*_token`，别急着换接口 |
| 同一条 `eval` 在 `frame:39` 上偶发 `RED is not defined`，回执只写「标签 + 世界」，看不出跑在哪个帧 | 回执标 `frame=39`；扩展把 `execFrameId` 带回来，帧不一致直接打 `⚠️ 请求 frame=39，实际在 frame=0 执行` |
| 每次 eval 都回显 300 字代码，30 次调用把上下文塞满重复代码 | `eval` 支持 `quiet:true`，只给结果 |
| `history` 查 iframe 里的业务页永远 0 条（Chrome 只记顶层导航） | 0 条时直接说明原因并给替代入口（`frames` / `tabs`） |

## 1.11.1 改了什么（一次 LIMS 数据权限排查带出来的）

排查「检验报告查询页：手动报检有子表、自动报检没有；管理员两类都有」时，卡点全在"看得见什么"上：

| 卡点 | 现在怎么解 |
|---|---|
| 结论由**请求头**决定（`moduleCode`/`X-Function-Code` 在，后端才挂数据权限），但探针只记请求体、CDP 只记挂上之后的请求 | `probe.js` 记录请求头（`authorization`/`cookie` 一律不落地，Bearer/JWT 打成 `***`）；`networkLog` 行尾打 `⚑ moduleCode=...`；`networkDetail` 回落探针时也列头 |
| 想验证「同样的请求我发一遍是什么结果」只能手写 fetch 补头 | 新增 `replay`：按抓到的那条原样重发，`headers`/`dropHeaders`/`body`/`method` 可覆盖，`dryRun` 只看不发；走页面 fetch（cookie 自动带，`netBlock` 规则照样生效） |
| 照 SKILL.md 的 Vue 配方裸递归 vnode 树，指数爆炸把主线程占死，`abort` 也送不进去，只能 F5 | `abort` 增加 `hard:true`：走 CDP `Runtime.terminateExecution` 直接终止；协作式取消送不进去时自动回落硬停；SKILL.md 配方加 `seen`/限深 |
| 大结果 eval 之后扩展 SW 被回收，回执却说「Chrome 多半被关了/崩了」 | 离线文案区分两种情况并给出唤醒办法（点扩展图标/刷新标签页） |
| 同一条请求在 `networkLog` 里出现两行（CDP 行没 frameId，导致去重 key 不同） | `mergeNetworkRows`：两边都有 frameId 才比帧，否则按 2 秒时间窗去重 |


## 1.11.0 改了什么（一次生产环境排查带出来的）

排查「流程设计器里改了业务角色，保存后重新进入又变回去」时，插件有四处直接不够用：

| 卡点 | 现在怎么解 |
|---|---|
| 页面 CSP 禁 `unsafe-eval`，`eval` 两个世界都被挡，只能绕到父页面跨窗口读 iframe | `eval` 命中 `EVAL_CSP_BLOCKED` 自动改用 DevTools 的 `Runtime.evaluate`（不受页面 CSP 约束），回执标 `via:"cdp"`；子 frame 也能按 frameId 找到执行上下文 |
| `networkLog` 只读主帧探针，iframe 里的接口一条看不到 | `readProbeAll()` 逐帧读 `__dshProbe` 并按 frameId 聚合；`networkLog` 支持 `frame` 过滤，`networkClear` 连各帧一起清 |
| 探针只记 URL/状态，要看提交内容只能自己 patch XHR | `probe.js` 记录 POST/PUT 请求体（默认截断 1.2KB，`window.__dshProbeBodyLimit` 可关）；`networkDetail` 在 CDP 没有记录时回落到探针并给出 `postData` |
| 为了看保存请求，得手写补丁 abort —— 补丁没生效就是真写库 | 新增 `netBlock` 动作：`op:set` 装 URL 规则，`block` 模式只登记不发送（XHR 派发 error/loadend，fetch reject），`dryRun` 拦所有非 GET，`op:hits` 取记录，`op:off` 解除 |
| 排查完要 grep 页面 JS，`saveTo` 落在 `~/.dsh/chrome/out/`，沙箱是 workspace-write 时读不回来 | `saveTo` 支持绝对路径 / `./相对路径` / `~/`，父目录自动建；纯文件名仍是老行为 |
| 组件内部状态要手写两遍 vnode 遍历，第一遍还找错了入口（`app._instance` 是 null） | SKILL.md 增加「Vue 3 页面探查配方」（`#app._vnode.component` 入口、组件树遍历、`setupState`/`exposed`） |
| Element Plus 的 popper teleport 到 body，同 class 的浮层有好几个，`click` 报 MULTI_MATCH | 定位器加兜底：命中多个且**恰好一个可见**时自动选它（`autoVisible:true`），两个以上可见仍然报错并标注「(不可见)」 |



## 1.9.0 改了什么（壳页 + iframe 时代）

这一轮的主要驱动是「门户壳页 + 业务 iframe」类系统：顶层只有菜单，正文和表格全在 iframe 里，旧版 `read` 只回 116 字菜单、`check` 报 `NOT_FOUND`，排查全靠手写 `eval`。

### 同源 iframe 跨帧

- `read` / `query` / `click` / `type` / `check` / `outline` / `isChecked` / `select` / `value` / `extract` / `snapshot` / `wait` / `focus` / `rect` / `scroll` 全部接入 `S.docs()`：同源 iframe 的 `document` 一起查，跨域帧跳过（读不到，不报错）。
- `read` 不带 `selector` 时，如果顶层正文少得可疑（< 300 字），自动下沉到「可见且正文最长」的同源 iframe，回执带 `frame:{auto:true,src}`。隐藏的 iframe（`display:none`）不会被选中。
- 找不到元素时，错误信息会列出同源 iframe 清单；要精确指定就先 `action=frames` 看 `frameId`，再加 `frame:<id>`。
- 新增 `frames` 动作：每个帧的 `frameId` / 父帧 / 地址 / 标题 / 正文长度 / 可视尺寸 / 是否可见。`frameId` 就是 `frame` 参数。
- 新增 `rows` 动作：大表格一行一条，带 `ref` + 行文本 + 勾选态 + 所属 iframe，比 `outline` 的「另有同类元素」清楚；`ref`（如 `r3`）可直接给 `click`/`check`。

### 页面探针（CDP 挂上之前的证据）

- 新增 `extension/probe.js`，`document_start` 以 MAIN world 注入，hook `fetch` / XHR / `console` / 未捕获异常 / unhandledrejection，每个帧留最近 200 条（只记元数据：方法/URL/状态/耗时/`mime`/`length`，不记响应体）。
- `networkLog` / `logs` 在 CDP 缓冲为空或不全时，通过 MAIN world 读探针补齐；回执带 `source: "probe" | "mixed"`，行上带 `via:"probe"`。
- 合并去重按「CDP 最早记录时刻」划界：早于它的探针记录一律保留（同一接口的多次轮询不再被同 key 吞掉），只有与 CDP 同期才按 `method|url|status` 去重。
- `networkClear` 现在连探针缓冲一起清（回执带 `probeCleared`），否则下次 `networkLog` 又把刚清掉的记录捞回来。

### 安全与正确性

- **`tabId` 严格匹配**：显式传入不存在的 `tabId` 直接报 `TAB_NOT_FOUND`，不再静默回落到当前活动标签（以前写操作可能打到别的页面）。
- 新增 `sticky:true`：沿用上一次操作过的标签，多标签排查时不用每次带 `tabId`（注意：`lastTabId` 是 SW 内存态，SW 被回收后失效）。
- `check` 点击优先落到原生 `input`（Element Plus 隐藏 input 才会触发 `change`），回执加 `inputChecked`；DOM 状态与原生 `input.checked` 不一致时给 `modelWarning`（「只是样式变了、业务模型没收到」）。
- `eval` 返回值超过 `maxChars` 时改为**深度裁剪**（字符串截断、容器递归），返回仍是合法可解析的 JSON，不再切出半个键值对；极端嵌套才退化为字符串预览并标注不可解析。

### 版本与维护

- 版本号收敛：`executor.js` 的 `EXT_VERSION` 和 `cdp.js` 的 `VERSION` 改为从 `chrome.runtime.getManifest().version` 读取，不再手写；页面世界拿不到 manifest，`page.js` 的 `PAGE_VERSION` 仍是常量（升级时与 `manifest.json` 同步）。
- 删除 `extension-standalone/`（1.8.1 的旧分发副本，与 `extension/` 重复且不被任何配置引用）。

## 1.7.0 改了什么（第二轮省 token，按实测数据砍）

在必应首页实测：`read` 一条 **2914 字符**、`outline` 一条 **2839 字符**。拆开看，大头不是正文：

| 来源 | 实测 | 处理 |
|---|---|---|
| `read` 的按钮块（CSS 全路径，平均 158 字符/行） | 1293 字符 | 默认不再输出；`sections:"all"` 才给，且路径压到 3 层 / 60 字符 |
| `read` 的链接块（URL 编码中文） | 813 字符 | 同上；href 只留 `path?参数名` |
| `outline` 的 11 行超长 href | ~1100 字符 | `shortHref`：同站只留路径 + 前两个参数名，上限 50 字符 |
| `outline` 的 menuitem 与 link 同入口 | 5 行 | 同名时跳过 menuitem（link/button 更能点） |
| 每行 `[e1] button "登录"` | 43 行 × 4 字符 | 紧凑成 `e1 button 登录`；`✓/✗` 代替「(已选中)」 |
| 尾部那句「接下来直接用 ref…」 | 95 字符 | 删掉（SKILL.md 里已有） |
| 每次调用都写「（已记录：C:\…jsonl）」 | 85 字符 | 压成「（log 2026-11-17.jsonl）」，约 27 字符 |

预计：`outline` 2839 → ~1340（-53%），`read` 2914 → ~760（-74%），每次调用另有 ~58 字符固定开销。真实数字在下次真机量。
## 1.6.0 改了什么（省 token 四刀，真做完版）

1. **动作后自动回传增量 Diff**。`click` / `type` / `check` / `press` 成功后在回执里附一行「【页面变化】+2 button「确认」；-1 dialog「保存成功」」，基线是上一次 outline 的**全部可见交互元素**（不是列出来的那几行，否则折叠掉的会被当成新增）。模型点完就知道页面变了什么，省掉「再调一次 outline 看结果」的一整轮上下文。
2. **`outline` 支持 `selector` 作用域 + 同类折叠**。只看 `#panel` / `.el-dialog` 里的元素；同父同 role 同名超过 3 个折叠成一行「另有同类元素，用 rowText 定位」。大后台从 60 行压到十几行。
3. **无字图标按钮补盲**。名字依次从 `aria-label` → `aria-labelledby` → `svg > title` → `label` → placeholder/name/id 取，纯图标按钮不再叫「(无名称)」。
4. **工具 Schema 瘦身 41%**：`PARAMETERS` 从 13831 字符压到 8142（长解释挪进 `SKILL.md`，只留短语义），工具总描述从 495 字符压到 ~120。每轮对话少付这段过路费。

1.5.0 只是半成品（`outline` 里一句坏 delta + 没压 schema），1.6.0 才算真的落地（当时 263 项自测）。
## 1.4.0 改了什么（对标 Playwright MCP / Chrome DevTools MCP）

翻了 [Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)、[Stagehand](https://github.com/browserbase/stagehand) 的工具面，挑四样本机真用得上的补进来：

1. **`networkDetail`**：看某条请求的请求头 / 请求体 / 响应头 / 响应体（`Network.getResponseBody`）。`networkLog` 只给「谁、什么状态」，排查内网接口必须看载荷。可传 `requestId` / `index`（倒数第几条）/ `filter`。
2. **`storage`**：读写页面 `localStorage` / `sessionStorage`（list/get/set/remove/clear）。内网系统把 token 放在 localStorage 里比 cookie 还常见；默认只给 key 和长度，`showValues:true` 才回真值。
3. **`hover`**：真实 `mouseMoved`（两次，第二次算稳定），专门对付只在 `:hover` 下出现的菜单/提示。
4. **`highlight`**：给元素画红框（`clear:true` 清掉），纯视觉、不改数据——人看屏幕时能一眼知道模型在说哪个元素。
5. 顺手补了 `wait` 的两档：`textGone`（等提示消失）和 `time`（纯等 N 秒，最多 30）。

没跟的：Playwright 的坐标级 vision 工具（人家这套不需要）、网络 mock/route（风险大、本地用得少）、trace/video 录制（这台机器 2 核，录了也没人看）。

## 1.3.3 / 1.3.4 改了什么

真机最后一轮补的两处：

1. **聚焦/拖拽失败要带原始错误码**（1.3.3）。`press` 传过期 `ref` 以前会退化成 `COMMAND_FAILED`，现在原样回 `REF_STALE`＋「重新 outline」的建议；`drag` 的端点解析同理。
2. **截图格式真的透传到 CDP**（1.3.4）。`format:"jpeg"` 之前被 `capture()` 吞掉，出来还是 PNG；现在 `format`/`quality` 一路传到 `Page.captureScreenshot`，落盘扩展名跟着实际格式走（`.jpg`）。

### 一定要知道的坑：Chrome 会缓存扩展的 SW 脚本

改完扩展代码、重启 Chrome，`manifest` 版本是新的、**跑的却是旧代码**（实测：`pageVersion` 卡在上一版、`Emulation.enable` 还在报错）。原因是 profile 里的 Service Worker / V8 代码缓存。

换扩展代码后，重启 Chrome 前清一次：

```powershell
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Service Worker" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Code Cache\js" -Recurse -Force
```

验证是否真的换了：`chrome` 工具 `status` 看「页面脚本版本」，或 `/cmd` 发 `ping` 看 `pageVersion`——它跟着 SW 里的 `page.js` 走，不是 manifest。

## 1.3.2 改了什么

真机第二轮又揪出四个：

1. **截图整条换成 CDP**。`chrome.tabs.captureVisibleTab` 在本机直接报 `Failed to capture tab: image readback failed`（窗口被别的窗口压住/GPU 回读失败），而且必须把窗口抢到最前。现在 `capture()` 先走 `Page.captureScreenshot`：元素 → 文档坐标 clip、`clip` 参数原样、`scale` 交给 CDP 的 `clip.scale`；截之前 `Page.bringToFront`（**实测：标签被遮住时 captureScreenshot 会永远不返回**）。`captureVisibleTab` 只剩 CDP 不可用时的兜底，回执标 `via`。
2. **MHTML 是文本不是 base64**。`Page.captureSnapshot` 回的是 MHTML 明文（quoted-printable），之前当 base64 解码写盘，结果是 49 字节乱码。现在按 UTF-8 写。
3. **`Emulation.enable` 根本不存在**（`-32601 Emulation.enable wasn't found`）。`enableDomains` 现在把「没有 enable 方法的域」当已就绪；`emulate` 只开 Page/Network。
4. **地址一样 ≠ 页面还在**。服务器挂掉后标签停在错误页，地址栏还是原 URL，`navigate` 会误判「已到达（同文档）」。现在先跑一次注入探针（`documentAlive`）：错误页注入被拒（`showing error page`）就真去重新导航。

另外：截图文件名跟着实际格式走（jpeg → `.jpg`），不再一律 `.png`。

## 1.3.1 改了什么

真机第一次跑就撞上了：整页截图那条 `Page.captureScreenshot` 没有超时，协议不回话 → `await` 永远悬着 → SW 没有 `chrome.*` 活动被空闲回收 → 桥那边 11 条命令全堵住，扩展从此不再轮询。

修法（四层，缺一层都还会复发）：

1. **每条 CDP 命令都带超时**（`send()` 里 `Promise.race`，默认 15s，可按动作覆盖）：协议不回话就抛 `CDP_TIMEOUT`，并写明「命令可能仍在执行，别直接重放写操作」。
2. **整页截图有回退**：20s 内没截到就退回视口截图（`fullPage:false` + 说明），宁可给一张也不挂死。
3. **background 有看门狗**：任何命令超过 90s 直接放弃等待、报 `COMMAND_WATCHDOG`，回去继续轮询；执行期间每 15s 戳一次 `chrome.runtime.getPlatformInfo()` 保活，别让 SW 在执行中被回收。
4. **attach 也有超时**（8s），`already attached` 的探针 6s——挂不上就报错，不无限等。

顺带：新会话 attach 时就把 Page/Runtime/Log/Network 一起打开（以前只在用到时开，导致「先点按钮再查网络」永远查不到）；桥的超时文案分「扩展在忙」和「扩展掉线」两种，不再一律说没连上。
## 1.3.0 改了什么

### CDP 通道（`extension/cdp.js` + `lib/extra.js`）

加一个 `debugger` 权限，换一条透传通道。一次 attach，之后十来个能力都从这条通道走：

| 动作 | 干什么 |
|---|---|
| `press` | 真实键盘：Enter/Tab/方向键/Home/End/F1-F6、单字符、`Ctrl+A` 这种组合键。终端（xterm/hterm）、编辑器、只认 `isTrusted` 的组件只能靠它 |
| `dialog` | 原生 alert/confirm/prompt 策略：`accept`（默认，弹窗一出现就按 OK）/ `dismiss` / `manual`；另给最近 10 条弹窗记录。以前一个原生弹窗就能把页面线程卡到工具超时 |
| `logs` / `networkLog` / `networkClear` | 抓 console（含未捕获异常、Log 域条目）和 HTTP 请求（方法/状态/类型/缓存/失败原因），各留 300 条环形缓冲 |
| `pdf` / `mhtml` | 导出 PDF、整页存单文件 MHTML（落 `~/.dsh/chrome/out/`，只回路径和大小） |
| `upload` | 把本机文件设到 `input[type=file]`（`DOM.setFileInputFiles`，不弹系统选择器）；先验存在，`DSH_CHROME_UPLOAD_DIR` 设了就只能传该目录内的 |
| `drag` | 真实鼠标拖拽：按下 → 插值移动 → 抬起；中途失败一定补发抬起，不会卡在按住状态 |
| `emulate` | 视口（mobile/desktop/custom/reset）、网络限速（slow3g/fast3g/offline）、CPU 降速 1–20 |
| `metrics` | DOM 节点 / 事件监听 / 布局与脚本耗时 / JS 堆（`Performance.getMetrics`） |
| `screenshot { fullPage:true }` | 整页截图（`captureBeyondViewport`），不再只有视口那一屏 |
| `cdp` | 任意 CDP 方法原样透传（`method: "Page.getNavigationHistory"`），没专门动作时的逃生口 |
| `detach` | 主动断开调试会话（消「正受控制」横幅，日志/网络缓冲也停） |

同时 `ping` 现在回一份 `capabilities`（命令清单 + 已 attach 的 tab），插件侧按它判断扩展够不够新；`diag` 多报一行 CDP 状态。

### 浏览历史（`history`）—— 1.10.0

排查「这个页面昨天是在哪个地址打开的」时，标签列表和当前页面都帮不上忙。以前只能去啃 Chrome 的 `History.sqlite`：那文件正被浏览器独占（WAL 锁），还得自带 SQLite 解析器；现在换成扩展的 `chrome.history` API：

```json
{"action":"history","keyword":"DR_","sinceDays":3,"limit":30}
```

回 `时间 / 访问次数 / 标题 / URL`，按时间倒序。不需要 tab 参数（它不属于任何标签）；关键词匹配标题和网址。

### 事件化导航（`navigate` / `open`）

`waitUntil` 四档：`load`（默认，预算 15s）、`domcontentloaded`（4s）、`commit`（4s）、`none`（不等待，立刻回 `pendingUrl`）。

- 判定靠事件：`Page.frameNavigated`（只认主框架）= 提交，`Page.domContentEventFired` / `Page.loadEventFired` = 对应时点；**dcl/load 必须发生在认领的 commit 之后**，旧文档迟到的 load 不算数。
- 事件监听在 `tabs.update` **之前**挂上（`open` 先开 `about:blank`、attach 完再导航，否则快页的 commit 在 attach 前就发完了）。
- 预算用完诚实报 `loadPending: true` + `pendingUrl`，不再把「没等到」写成「已加载」。
- 不提交的导航（下载、被拒载）有 600ms 宽限：地址落对了就按同文档到达算，落不对就报没落地。
- 错误页（`chrome-error://`）报 `siteUnreachable`。
- CDP 挂不上（DevTools 占着标签、权限没给）自动退回老轮询，回执里写明 `via:'poll'` 和原因——不假装是事件判定。

## 1.2.0 改了什么

1. **`outline` 动作 + `ref` 定位**（学 browser_snapshot 的 ref 契约）。一次调用把「这页有什么能点/能填」一行一个列出来：`[e1] button "登录"`，同时把 `data-dsh-ref` 写到真实 DOM 上；`click`/`type`/`check` 直接传 `ref:"e1"`。省掉「先 query 再猜选择器再点」的两三个来回，动态 id 的页面也不怕；页面一变就报 `REF_STALE` 让你重新 outline，而不是误点别的元素。隐藏/0 尺寸元素不占编号；每轮先清旧 ref，旧编号绝不会指错人。
2. **`read` 分页**（学 browser_read 的 offset 窗口）。默认一次 6000 字，页头写「正文 N 字 · 本次第 a–b 字」，没给完就带 `nextOffset`；模型照着 offset 接着读，长文档不用一次灌满上下文，也不会「页面给 20000、这边又切到 6000」白传一趟。
3. **截断对齐代理对**（学 sliceWellFormed）。`clip`/`read`/`value` 切点落在 emoji 高代理上退一格、落在低代理上退到对首——半个字符会让下游 JSON 整条解析失败，还会跟着会话历史每轮重放。
4. **超时的语义说清楚**（学 effectState）。`COMMAND_TIMEOUT`/`PAGE_SCRIPT_TIMEOUT`/`INJECT_TIMEOUT` + 写动作 → 回执明确写 `effectState=unknown`「可能已经落到页面上，先 read/isChecked 看状态，别连着重放」；桥的两种超时也分开打码：扩展连着没回话 vs 扩展根本没连上（后者重试安全）。
5. **`cookies` 动作**（执行器里本来就有，没挂到工具面上）。默认只回名字/域/过期时间/httpOnly，`showValues:true` 才回值——值是凭据，不该默认进聊天。

## 1.1.0 改了什么

按「能省多少错、省多少试、省多少 token」排：

1. **eval 默认走页面世界**。以前先问常驻 content script（ISOLATED world，MV3 禁 `unsafe-eval`），必然 CSP 报错，而且错误不会被判别成"该回退"，所以永远走不到 `executeScript` 兜底。现在：`world=MAIN` 直接注入页面世界；ISOLATED 遇到 CSP 错误码会自动退到 MAIN 并标注 `fellBackTo`；两边都不行返回 `EVAL_UNAVAILABLE` 并说清原因。
2. **`timeoutMs` 真的透传**。以前 `exec()` 里写死 6 秒，超时只是"调用方不等了"，页面脚本还在跑，后续调用和它抢状态。现在按调用方给的值走，超时报 `PAGE_SCRIPT_TIMEOUT` 并明确提示"可能仍在执行"；新增 `runId` + `abort` 让长任务能被标记取消（代码里检查 `window.__dshAborted(runId)`）。
3. **`check` 幂等**。以前等价于"点一下"（= 切换），重跑批量会把已勾上的点掉——实测一次撤销了 86 个勾选。现在：读状态 → 已符合就不动 → 点 → 回读校验 → 重试（默认 3 次），返回 `attempts/before/after/skipped`。新增 `isChecked` 一次盘点整表。
4. **按行文本定位**。新增 `rowText` + `in` + `target`，不用数 `nth-child`；多命中报 `MULTI_MATCH` 并列候选，不瞎点。
5. **长文本一次读完**。新增 `value` 动作（`maxChars:0` 全文、`saveTo` 落盘只回路径）；`read`/`extract` 支持 `maxChars`，`extract` 的 `items:"self"` 修好了"容器自己匹配不到"的问题。
6. **flow 支持 `repeat` 循环和 `quiet` 静默**。91 个元素以前要 7 次调用、输出 300 段复读。
7. **错误码化**：`NOT_FOUND`/`MULTI_MATCH`/`EVAL_CSP_BLOCKED`/`PAGE_SCRIPT_TIMEOUT`/`TYPE_NOT_APPLIED`/`CHECK_FAILED`/`NO_CONTENT_SCRIPT`… 失败直接回显真实原因 + 一句下一步建议，不用再去翻 JSONL。
8. **`type` 回读校验 + 提交方式可选**。`submitMode:auto` 对搜索框发 `keydown+keyup`（Element Plus 只认这个），普通表单走 `requestSubmit`。
9. **`wait` 更准**：`exact`（按独立词匹配，不再被 `LT_V13219A.AV` 骗）、`changed`、`count`、`value`、`until`。
10. **`diag`** 一条命令回答"这个标签能不能 eval / content script 注没注入"。
11. **页面函数合并成 `page.js` 一份**。以前 content.js 和 executor.js 各抄一份，改一处忘另一处就会出现"F5 前后行为不一样"。
12. 顺手修的：flow 里嵌套 `type` 步骤的密码以前没脱敏；`screenshot` 支持 `selector`/`clip`/`scale` 局部截图；`query` 会推荐 `text` 定位；结果里带 `tabVia` 说明标签是怎么选出来的。

