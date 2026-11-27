# 安装说明

面向使用者。装完你会得到：DSH 里多一个 `chrome` 工具，Chrome 里多一只「手」。

- 只想用、不想读代码 → 本文即可。
- 想改代码、打包发版 → 看 [BUILD.md](BUILD.md)。

## 0. 前提

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 为主（macOS / Linux 同理，路径换成对应写法） |
| DSH | 已装好并能正常启动（本机进程，不是远端） |
| 浏览器 | Chrome / Edge 等 Chromium 内核，支持 MV3 |
| 网络 | 全程本机回环，**不需要外网**，也不连任何第三方服务器 |

扩展和 DSH 必须在**同一台机器**上：扩展只轮询 `127.0.0.1:18765`。

## 1. 装 Chrome 扩展

> Chrome 只接受「加载已解压的扩展程序」，不支持双击 `.crx` 安装。这不是本项目的问题，见文末。

1. 从 [Releases](https://github.com/qlings/dsh-chrome/releases/latest) 下载 `dsh-chrome-extension-<版本>.zip`。
2. 解压到一个**固定目录**，例如 `D:\tools\dsh-chrome-extension`。
   **路径之后不能动**：Chrome 记的是绝对路径，挪了目录扩展就失效，要重新加载。
3. 地址栏打开 `chrome://extensions`。
4. 右上角打开 **开发者模式**。
5. 点 **加载已解压的扩展程序**，选中第 2 步那个文件夹（**有 `manifest.json` 的那一层**）。
6. 在扩展卡片上点 **详情** → **网站访问权限** → 选 **在所有网站上**。
   默认的「点击时」不会注入 content script，表现是「扩展连上了，但读页面永远超时」。
7. 点工具栏上的扩展图标，看到「已连上 DSH」即成功（此时 DSH 插件必须已装好，否则显示「未连上」是正常的）。

首次会弹权限确认：「读取和更改您在所有网站上的所有数据」「调试程序」——前者是注入页面脚本必需，后者是 CDP 通道（`press`/`logs`/`pdf`/`screenshot` 等）必需。拒绝的话扩展仍能跑，但一半动作会报错。

## 2. 装 DSH 插件

插件是 `lib/` 里的 Node 代码，由 DSH 进程加载。三条路，选一条。

### 方式 A · 用发布包（推荐给使用者）

```powershell
# 1) 找一个临时目录解开 tgz（npm 包的根目录叫 package/）
New-Item -ItemType Directory -Force "$env:TEMP\dsh-chrome-pkg" | Out-Null
tar -xzf .\dsh-chrome-1.20.0.tgz -C "$env:TEMP\dsh-chrome-pkg"

# 2) 拷进 desktop profile 的 node_modules，目录名必须是 dsh-chrome
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome" | Out-Null
Copy-Item "$env:TEMP\dsh-chrome-pkg\package\*" `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome" -Recurse -Force
```

### 方式 B · 指向源码（推荐给自己改代码）

```powershell
git clone https://github.com/qlings/dsh-chrome.git D:\src\dsh-chrome

New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chrome" `
  -Target "D:\src\dsh-chrome"
```

Junction 的好处：改 `lib/` 立刻反映到加载路径（仍要重启 DSH），不用每次复制。

### 方式 C · 用 DSH 插件管理命令

```powershell
dsh plugin --profile desktop add D:\src\dsh-chrome
```

不同 DSH 版本子命令略有差异，以 `dsh plugin --help` 为准。命令成功的话会自己写 bundle 清单，跳过下一步。

### 2.3 登记 bundle（方式 A / B 必做）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在末尾追加：

```yaml
- insert:
    - id: dsh-chrome
      name: dsh-chrome
```

`name` 是包名，DSH 按它 `import`——写错会报 `Cannot find package 'dsh-chrome'`。

然后**重启 DSH**（bundle 清单在启动时读）。重启后 `chrome` 工具应该出现在工具列表里。

## 3. 验证

```powershell
# 桥活着吗（版本号应等于插件版本）
Invoke-RestMethod http://127.0.0.1:18765/status
```

预期返回类似：

```json
{ "ok": true, "version": "1.20.0", "ext": { "id": "...", "version": "1.20.0" }, "pending": 0 }
```

`ext.version` 为空说明扩展还没连上——回去看第 1 步的第 6、7 项。

再让 DSH 跑一条只读命令，例如「用 chrome 工具打开 example.com，读一下页面标题」，或直接：

```json
{"action":"status"}
```

## 4. 升级

| 改了什么 | 要做什么 |
|---|---|
| 只改 `lib/` | **重启 DSH** |
| 改了 `extension/` | `chrome://extensions` 点扩展卡片的**刷新箭头**，再到目标页按 **F5** |
| 两者都改 | 上面两件都做，顺序无所谓 |

**只重载扩展不刷页面是不够的**：已经有标签页里的 content script 还是旧版，要 F5 才会换成新的。Chrome 还会缓存 service worker 脚本，偶尔需要在扩展页点一次「重新加载」。

版本不一致时工具会提示（扩展和服务端的回执格式差太多会直接报错），所以两边尽量同版本。

## 5. 卸载

1. `chrome://extensions` → 移除扩展。
2. 删掉 `~/.dsh/profiles/desktop/node_modules/dsh-chrome`（junction 请先删链接再删源码）。
3. 从 `cordis.patch.yml` 删掉对应 `insert` 段。
4. 可选：删 `~/.dsh/chrome/`（流水、截图、账号库）。

## 6. 连不上怎么查

按顺序排查，基本三步内定位：

| 现象 | 原因 | 处理 |
|---|---|---|
| `Invoke-RestMethod` 连不上 | 插件没加载 / DSH 没重启 | 看 DSH 启动日志里有没有 `Cannot find package 'dsh-chrome'`；确认 `cordis.patch.yml` 缩进（YAML 两个空格） |
| 桥在，扩展显示「未连上」 | 扩展没权限 / content script 没注入 | 扩展详情 → 网站访问权限 → 在所有网站上；再点扩展图标看它报的端口和错误 |
| 扩展说「18765-18769 都没应答」 | 桥端口被旧实例占着 | 关掉多余 DSH 实例；或关掉扩展再开，让它重新探测 |
| 扩展显示已连上，`read` 却超时 | 目标页是旧标签，没有新 content script | 目标页 F5 |
| 只有 `eval` / `press` 报错 | CDP 没权限，或调试横幅被关 | 允许「调试程序」权限；重新点一次页面 |
| 一切正常但写操作报 `ELEMENT_DISABLED` | 按钮真被禁用（含祖先 `aria-disabled`） | 先满足前置条件；确需硬点传 `force:true` |

还可以看运行日志：`~/.dsh/chrome/logs/YYYY-MM-DD.jsonl`，每条操作一行，含参数（密码类字段已脱敏）与结果。

## 附：为什么不能双击装 CRX

Chrome 会把经注册表 `HKCU\Software\Google\Chrome\Extensions\<id>` 装进来的 CRX 标成 `DISABLE_NOT_VERIFIED` 直接禁用；白名单在 `ExtensionInstallAllowlist` 策略里，普通账户通常写不进去。`--load-extension` 命令行参数也已被新版 Chrome 忽略。

所以唯一可靠的路径就是「开发者模式 → 加载已解压的扩展程序」。本项目的扩展也因此**不做打包签名**，发布物是 zip。
