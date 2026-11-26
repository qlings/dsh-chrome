# dsh-chrome

**让 DeepSeek Harness 接管你本机的 Chrome。** 读页面、点按钮、填表、提交、多标签对照、复用已登录账户、按行文本勾选、一次读完长文本、一个 flow 跑完批量操作——每次操作都有结构化回执，并写一份 JSONL 流水。

[![version](https://img.shields.io/badge/version-1.18.0-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![chrome](https://img.shields.io/badge/chrome-MV3-yellow.svg)](extension/manifest.json)

---

## 这是什么

两部分，缺一不可：

| 部分 | 跑在哪 | 干什么 |
|---|---|---|
| **DSH 插件**（`lib/`） | 本机 DSH 进程里 | 注册 `chrome` 工具，起一条本地长轮询桥 `127.0.0.1:18765` |
| **Chrome 扩展**（`extension/`） | Chrome 里 | 一条常驻 MV3 扩展，轮询桥、执行命令、回传结果；负责 content script、CDP、页面探针 |

```
┌──────────────┐   127.0.0.1:18765   ┌────────────────┐   chrome.* / CDP   ┌──────────┐
│ DSH 插件 lib │ ⇄ 长轮询 / 命令队列 ⇄ │ Chrome 扩展 MV3 │ ⇄ 注入 / 调试协议 ⇄ │ 你的页面  │
└──────────────┘                     └────────────────┘                    └──────────┘
   工具调用 / 回执                        执行 / 落盘 / 探针                 DOM / 网络
```

扩展只在**同一台机器**上有用（只连 `127.0.0.1`），不经过任何外部服务器，不额外保存密码。

## 能做什么

61 个动作，覆盖「看页面 → 改页面 → 抓接口 → 查证据」的整条链路：

| 类别 | 动作 |
|---|---|
| **看页面** | `read` `outline` `query` `rows` `frames` `snapshot` `extract` `screenshot` `pdf` `mhtml` `diff` `sourceSearch` |
| **改页面** | `click` `type` `submit` `select` `check` `isChecked` `value` `hover` `press` `scroll` `focus` `wait` `highlight` |
| **标签与导航** | `open` `navigate` `reload` `back` `forward` `close` `focus` `tabs` `history` `downloads` `tabEvents` |
| **抓接口** | `fetch` `networkLog` `networkDetail` `networkClear` `replay` `netBlock` `logs` |
| **进阶** | `eval` `evalMain` `vue` `cdp` `detach` `emulate` `metrics` `upload` `drag` `dialog` `storage` `cookies` `abort` |
| **批量** | `flow`（多步一次跑完，支持 `repeat` / `when` / `onError`） |
| **账号** | `login` `sites`（复用浏览器现成登录态） |
| **诊断** | `status` `diag` `log` |

几条设计上的硬约束，都是踩出来的：

- **同源 iframe 自动跨帧**——门户壳页只读得到菜单时，`read` 自动下沉到正文最长的可见 iframe；找不到元素时列出帧清单。
- **幂等勾选**——`check` 点原生 `input` 并回报「DOM 状态 vs 业务模型」是否一致，重复跑不会点反。
- **写操作先取证**——`netBlock` 可只登记不发请求，确认提交内容再放行；`type` 的值进日志前自动脱敏。
- **结果不截断**——`saveTo` 向页面要全量，`.json` 落盘自动缩进；回执超长按字段裁剪，仍是合法 JSON。

## 快速开始

```text
① 下载 dsh-chrome-extension-1.18.0.zip  →  解压到固定目录（路径之后不能动）
② chrome://extensions  →  开发者模式  →  加载已解压的扩展程序  →  选 dsh-chrome-extension/
③ 安装 DSH 插件（下载 dsh-chrome-1.18.0.tgz，或直接用源码）
④ 验证：Invoke-RestMethod http://127.0.0.1:18765/status ，再点扩展图标看「已连上 DSH」
```

完整步骤、权限说明、升级方法见 **[INSTALL.md](INSTALL.md)**。

## 下载

最新版本：<https://github.com/qlings/dsh-chrome/releases/latest>

| 文件 | 大小 | 用途 |
|---|---|---|
| `dsh-chrome-extension-1.18.0.zip` | ~101 KB | Chrome 扩展，解压后「加载已解压的扩展程序」 |
| `dsh-chrome-1.18.0.tgz` | ~202 KB | DSH 插件包，`dsh plugin add` 或解压到 profile 的 `node_modules/` |

每个 Release 都带 `SHA256SUMS.txt`，Windows 上核对：

```powershell
Get-FileHash .\dsh-chrome-extension-1.18.0.zip -Algorithm SHA256
```

不想下载二进制？直接克隆源码即可，扩展和插件都是**纯文本、无构建步骤**：

```powershell
git clone https://github.com/qlings/dsh-chrome.git
```

## 安装 DSH 插件

**方式 A：用发布包**（推荐）

```powershell
# 解压 tgz 并放到 profile 的 node_modules/（目录名必须是 dsh-chrome）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome"
tar -xzf dsh-chrome-1.18.0.tgz -C "$env:TEMP\dsh-chrome-pkg"
Copy-Item "$env:TEMP\dsh-chrome-pkg\package\*" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome" -Recurse -Force
```

**方式 B：直接指向源码**（开发用，改完即生效）

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome" `
  -Target "<你克隆下来的 dsh-chrome 目录>"
```

然后在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-chrome
      name: dsh-chrome
```

重启 DSH（或等热重载），`chrome` 工具就会出现。

## 文档

| 文件 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安装、权限、升级、卸载、连不上怎么查 |
| [BUILD.md](BUILD.md) | 构建与打包（zip / tgz / release），目录约定，自测命令 |
| [SKILL.md](SKILL.md) | 给模型看的用法说明（决策树 + 高频配方）；运行时注册成 skill「chrome」 |
| [references/](references/) | 细节文档：MOM/ESB 后台配方、Vue 组件调用、截图落盘、表格与弹窗 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本被哪次真实任务卡住、怎么解的 |
| [docs/lessons.md](docs/lessons.md) | 18 条踩过的坑（协议层、MV3 生命周期、CDP 陷阱） |

## 自测

```powershell
node --test tests/*.test.mjs
```

假 DOM / 假桥 / 假 chrome，不连真浏览器。16 个测试文件全绿才算改完，`scripts/build.ps1` 会替你跑。真机冒烟：在真实业务页上跑 `diag` → `frames` → `read` → `outline` → `rows` → `flow`。

## 运行时产物

| 路径 | 内容 |
|---|---|
| `~/.dsh/chrome/logs/YYYY-MM-DD.jsonl` | 每次操作一条流水，敏感值已脱敏 |
| `~/.dsh/chrome/shots/` | 截图 |
| `~/.dsh/chrome/out/` | `value` / `saveTo` 落盘的长文本 |
| `~/.dsh/chrome/sites.json` | 站点账号库（仅当前用户可读） |

桥默认 `18765`，被占用时自动后移到 `18766–18769`，扩展自己找对端口。改法：插件配置 `port` 或环境变量 `DSH_CHROME_PORT`。

## 常见问题

**扩展显示「未连上 DSH」** — 先 `Invoke-RestMethod http://127.0.0.1:18765/status` 确认桥在跑；再看扩展详情里的「网站访问权限」是否为「在所有网站上」，默认的「点击时」不会注入 content script。

**点按钮没反应，回执说 `ELEMENT_DISABLED`** — 按钮真被禁用了（含祖先 `aria-disabled`）。这是保护：先满足前置条件，确需硬点传 `force:true`。

**Chrome 顶部出现「DSH Chrome 桥 started debugging this browser」** — CDP 那一族动作（`press` / `logs` / `pdf` / `screenshot` 等）的正常表现。`detach` 或关掉标签即消失。

**升级了却还是旧行为** — 扩展改过就必须「重载扩展 + 目标页 F5」；`lib/` 改过必须重启 DSH。Chrome 会缓存 service worker 脚本，只重载标签没用。

更多排查见 [INSTALL.md](INSTALL.md#连不上怎么查)。

## 目录结构

```
dsh-chrome/
├── extension/        Chrome MV3 扩展（manifest / page.js / executor.js / cdp.js / probe.js / popup）
├── lib/              DSH 插件（index / bridge / actions / extra / log / save / sites）
├── references/       skill 细节文档
├── tests/            node --test 自测（不随包发布）
├── scripts/build.ps1 打包脚本（版本校验 → 测试 → zip + tgz + 校验和）
├── SKILL.md          skill 主文件（插件 apply() 时注册）
├── cordis.patch.yml  bundle 声明
├── BUILD.md / INSTALL.md / CHANGELOG.md
├── docs/lessons.md   18 条工程级踩坑
└── .github/          Release 工作流
```

## 许可证

[MIT](LICENSE) © 2026 QLing
