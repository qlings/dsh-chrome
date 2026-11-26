# 构建与打包

面向改代码 / 发版的人。使用者看 [INSTALL.md](INSTALL.md)。

## 1. 没有构建步骤

这是刻意的设计：

- **零依赖**：`lib/` 和 `extension/` 只用 Node 内置模块和浏览器原生 API，没有 `node_modules`。
- **零打包**：`lib/` 是原生 ESM，由 DSH 直接 `import`；`extension/` 是原生 MV3，Chrome 直接加载。
- **零转译**：没有 TypeScript、没有 bundler、没有 minify。发布物里的代码和你读到的源码逐字一致。

所以「构建」只剩一件事：**把同一份源码按两种布局装进两个压缩包**。

| 产物 | 布局 | 谁用 |
|---|---|---|
| `dsh-chrome-extension-<v>.zip` | 顶层目录 `dsh-chrome-extension/` | 用户在 `chrome://extensions` 里「加载已解压的扩展程序」 |
| `dsh-chrome-<v>.tgz` | npm 布局，顶层 `package/` | 解压到 DSH profile 的 `node_modules/dsh-chrome` |

## 2. 一键打包

```powershell
# 完整打包（含自测）
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1

# 跳过自测（测试在 CI 里单独跑过时）
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1 -SkipTests

# 换输出目录
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1 -OutDir D:\tmp\dist
```

脚本做五件事，任何一步不对就红字退出（不会产出半成品）：

1. **版本号三处一致**：`package.json` / `extension/manifest.json` / `lib/index.js` 的 `VERSION`。
2. **体检**：两个 JSON 可解析、且**不带 UTF-8 BOM**（BOM 会让 DSH 读不了 bundle 清单，表现为 `chrome` 工具整个不注册）。
3. **自测**：`node --test tests/*.test.mjs`，16 个文件必须全绿（没有 node 时降级为警告）。
4. **打包**：生成上面两个文件。
5. **校验和**：写 `dist/SHA256SUMS.txt`。

产物（`dist/` 已被 `.gitignore` 排除，不进仓库）：

```text
dist/
├── dsh-chrome-extension-1.19.0.zip   ~101 KB
├── dsh-chrome-1.19.0.tgz             ~201 KB
└── SHA256SUMS.txt
```

> **PowerShell 版本**：脚本兼容 Windows PowerShell 5.1 和 PowerShell 7，所以文件是 **UTF-8 带 BOM** 保存的（5.1 不带 BOM 会把中文读成乱码并报语法错）。改这个脚本时别把 BOM 去掉。其他文件（JSON / JS / Markdown）一律 UTF-8 无 BOM。

## 3. 手动打包（不想用脚本）

扩展 zip——关键是顶层目录名，解压后必须是 `dsh-chrome-extension/manifest.json`：

```powershell
$stage = "$env:TEMP\dsh-ext"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\dsh-chrome-extension" | Out-Null
Copy-Item .\extension\* "$stage\dsh-chrome-extension" -Recurse
Compress-Archive -Path "$stage\dsh-chrome-extension" -DestinationPath .\dsh-chrome-extension-1.19.0.zip
```

插件 tgz——npm 包里根目录必须叫 `package/`：

```powershell
$stage = "$env:TEMP\dsh-pkg\package"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item .\lib,.\extension,.\references,.\SKILL.md,.\README.md,.\LICENSE,.\cordis.patch.yml,.\package.json $stage -Recurse
tar -czf .\dsh-chrome-1.19.0.tgz -C (Split-Path $stage) package
```

## 4. 测试

```powershell
node --test tests/*.test.mjs
```

16 个文件，全部是**无浏览器的单元测试**：假 DOM、假桥、假 `chrome.*`。覆盖动作分发、错误码、桥的队列与鉴权、CDP 事件时序、netBlock 钩子、页面函数（read/outline/click/check/tables）、skill 注册、JSONL 脱敏。

| 文件 | 盯的东西 |
|---|---|
| `actions.test.mjs` | 读分页、截断安全、ref 失效、超时语义、cookies |
| `bridge.test.mjs` | 掉线即时报 `EXT_OFFLINE`、队列清理、`/cmd` 鉴权、僵尸桥接管 |
| `cdp.test.mjs` | 导航事件、键盘、弹窗、网络、pdf/mhtml、截图回退、CSP 下 eval 回退 |
| `extra.test.mjs` | hover/storage/highlight/networkDetail/replay 的回执与脱敏 |
| `fetch.test.mjs` / `fetchplan.test.mjs` | 批量抓取、落盘、`shape` 结构摘录 |
| `netblock.test.mjs` | 只登记不发、dryRun、XHR 与 fetch 两条路径 |
| `netlog.test.mjs` | 过滤再截断、折叠、`unique` |
| `newactions.test.mjs` | frames/rows/downloads/tabEvents/sourceSearch/vue |
| `page.test.mjs` | 页面函数本体：ref 稳定、多匹配、表格按行展开 |
| `probe.test.mjs` / `probe-detail.test.mjs` | 探针记录与凭据打码 |
| `schema.test.mjs` | 工具参数表与扩展命令面一一对应（漏接直接失败） |
| `skill.test.mjs` | SKILL.md 解析、provider 注册、rank、提示语 |
| `tabevents.test.mjs` | 标签创建/关闭留证 |
| `v114.test.mjs` | 片段、超时抢救、authFrom、版本方向 |

真机冒烟（不进 CI，需要真 Chrome）：`diag` → `frames` → `read` → `outline` → `rows` → `check` → `flow`。

## 5. 发版流程

1. 改版本号，**三处一起改**：`package.json`、`extension/manifest.json`、`lib/index.js`（`VERSION`）。
2. 在 `CHANGELOG.md` 顶部加一节，写清「哪次真实任务卡住了 / 现在怎么解」；同时把 `.github/RELEASE_BODY.md`（CI 建 Release 用的正文，版本号会出现在下载表格里）改成新版本。
3. 跑 `scripts/build.ps1`，确认自测全绿、`dist/` 里两个包都在。
4. 提交并打 tag：

   ```powershell
   git add -A
   git commit -m "release: v1.19.0"
   git tag v1.19.0
   git push origin main --tags
   ```

5. 推送 tag 后，`.github/workflows/release.yml` 会自动：校验版本号 → 跑测试 → 打包 → 建 Release → 上传 `zip` / `tgz` / `SHA256SUMS.txt`。

   也可以手动建 Release 并上传 `dist/` 里的三个文件，记得在说明里写升级注意事项。

## 6. 目录里哪些东西会发布

| 路径 | 进 git | 进扩展 zip | 进插件 tgz |
|---|---|---|---|
| `extension/` | ✅ | ✅（顶层 `dsh-chrome-extension/`） | ✅ |
| `lib/` | ✅ | — | ✅ |
| `SKILL.md` / `references/` | ✅ | — | ✅ |
| `cordis.patch.yml` / `package.json` / `README.md` / `LICENSE` | ✅ | — | ✅ |
| `tests/` / `scripts/` / `docs/` / `.github/` | ✅ | — | — |
| `dist/` / `node_modules/` / 日志 / 备份 | ❌（`.gitignore`） | — | — |

扩展 zip 里只有 `extension/` 的 12 个文件，不含测试和文档——Chrome 只需要能跑的那几个。
