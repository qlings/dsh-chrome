# 踩过的坑（工程向）

每条都是协议层 / MV3 生命周期 / CDP 上真实挂过一次的地方，附「为什么会这样」。用户视角的问题在 [INSTALL.md](../INSTALL.md)。


1. **CORS 预检**：扩展发 `POST /result` 带 `application/json`，浏览器先发 `OPTIONS`。桥没处理预检时回 404，所有回传被拦——表现是「轮询正常、命令发出去了、结果永远回不来」。桥现在统一回 204 + CORS 头。
2. **MV3 service worker 只认 `chrome.*` 调用**：挂起的 `fetch` 不算活动，25 秒长轮询会被回收。改成 10 秒轮询 + 每轮一次 `chrome.runtime.getPlatformInfo()` 保活。
3. **扩展的「网站访问权限」默认是「点击时」**：`granted_permissions.scriptable_host` 为空，content script 不注入。必须在扩展详情里选「在所有网站上」。
4. **标签的 `type` 不再固定是 `'tab'`**：列表用排除法（只剔除 devtools/app）。
5. **长轮询会投给已断开的连接**：命令被移出队列、写响应失败就丢了。桥现在只投给活连接，6 秒没回音自动重发，扩展按命令 id 去重。
6. **写日志前要脱敏 `params.value`**：`type` 填进去的值很可能就是密码，字段名 `value` 不在脱敏名单里。flow 里嵌套的步骤同样要扒出来脱敏。
7. **`chrome.scripting.executeScript` 对未打包扩展"可用但不可靠"**：实测刷新前的页面全走它、毫秒级返回，但也遇到注入挂起不返回。所以它是兜底、要带超时，不是主力——主力是常驻 content script + 页面世界注入。
8. **`Number(undefined) == null` 是 false**：`Number(x) == null` 判空会把重试次数写成 `NaN`，循环一次都不进，直接报"失败但 0 次尝试"。用 `x == null ? 默认 : Number(x)`。
9. **端口不能被钉死**：popup 的「保存」会把当时的端口写进 `storage.dshChromePort`，之后 `probeBridge` 只试那一个。桥一挪位（热重载后桥从 18765 退到 18766 又退回来）扩展就永远 `TypeError: Failed to fetch`。现在 storage 里的端口只当"首选"，失败自动回退探测 18765–18769，找到后还会把 storage 纠正过来。
10. **SW 在"桥没应答"的重试路径里也必须保活**：MV3 的空闲计时器只认 `chrome.*` 调用，`fetch` 和 `setTimeout` 都不算。老代码 `probeBridge` 失败后只 `setTimeout(2500)`，SW 30 秒被回收；而 alarm 只在 `onInstalled/onStartup` 里建，reload 之后这俩事件不保证来——于是扩展从此彻底躺平。现在每条等待路径都戳一下 `chrome.runtime.getPlatformInfo()`，alarm 改成模块加载时就建，启动过程写进 `storage.dshBoot` 备查。
11. **导航事件必须在 `tabs.update` 之前挂监听**：`Page.frameNavigated` 是「提交时就发」，等 update 回来再接监听，快页的 commit 早发完了，只能干等满预算。所以 `open` 先开 `about:blank`、attach + 监听之后再导航。
12. **dcl/load 不能无条件算数**：旧文档迟到的 `load` 事件会让「新页面已加载」变成假话。现在 dcl/load 只在认领了 commit 之后才置位，提交前的先存着、提交时补记；预算耗尽如实报 `loadPending`。
13. **`Input.dispatchKeyEvent` 不能既带 text 又补 char**：keyDown 带 text 时 Chrome 已经插过字符，再补一个 char 事件就变成「xx」，Enter 还会提交两次。现在键位表里标了 `text` 的只发 keyDown + keyUp；Ctrl/Meta/Alt 组合抑制 text、改发 `rawKeyDown`——带 text 的 Ctrl+A 会变成「插入字母 a」而不是全选。
14. **CDP 会话活不过 SW 回收**：attach 状态在内存里，service worker 一被回收就没了，命令会报 `not attached`。`send()` 见到这个就 reset 再 attach 一次；`ensure()` 每次都幂等检查，别假设「刚才连过就一直连着」。
15. **没有超时的 CDP 命令会把整个扩展挂死**：整页截图卡住一次，SW 被回收、轮询停摆、11 条命令全堵在队列里。现在每条命令都有超时 + 看门狗——**协议层也要当不可靠网络对待**，`await` 是会被永远悬着的。
16. **`Number(x) || 默认值` 把「0 是有效值」吃掉**：`maxChars:0` 本来表示「要全文」，写成 `Number(opts.maxChars) || 12000` 后 0 变 falsy、静默回落 12000；更坑的是 `saveTo` 也在页面侧裁剪之后才落盘，于是**存下来的是半截文件，头部完整、结尾被切断，肉眼看不出来**。现在 `0` 单独判、`saveTo` 会向页面要全量。（2026-11-20 实测：dump 一份 19,628 字的配置，只拿到 12,000 字。）
17. **CDP `clip.scale` 吃的是设备像素**：`dpr=1.5` 的机器上 `scale:0.5` 产出的是原尺寸 2 倍的图，而 metadata 报的是 CSS 尺寸——回执说 960x462、文件其实 1920x924。现在扩展侧统一按「CSS 尺寸 × scale」重采样，宽高回报真实像素；`clip` 量不到时（content script 未就绪）用 `tab.width/height` 兜底，否则 CDP 会按整个 surface 出图、`scale` 无从换算。
18. **「打了哪个标签」必须显式回报**：`resolveTab2` 返回 `via`，但只有插件层把它印出来才有意义。回执现在带 `· via=active|sticky|urlContains`，并在「显式传了 `tabId` 却没按它选」时写成 `⚠️` 警告——这种时候写操作已经落到别的页面上了。
