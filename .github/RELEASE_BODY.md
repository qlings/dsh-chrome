## 装什么

| 文件 | 给谁 | 怎么用 |
|---|---|---|
| `dsh-chrome-extension-1.19.0.zip` | Chrome | 解压到固定目录 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dsh-chrome-extension/` |
| `dsh-chrome-1.19.0.tgz` | DSH | 解压到 `~/.dsh/profiles/desktop/node_modules/dsh-chrome`，再在 `cordis.patch.yml` 里插入 bundle |
| `SHA256SUMS.txt` | 校验 | `Get-FileHash .\dsh-chrome-extension-1.19.0.zip -Algorithm SHA256` 对一下 |

完整步骤（含权限、升级、排查）：[INSTALL.md](https://github.com/qlings/dsh-chrome/blob/main/INSTALL.md)。

## 这一版是什么

`1.19.0` 修的是「排查接口时取证工具本身不好用」：`networkDetail` 的 `index` 改成按 `filter` 命中集合取（候选下标可直接回传）；页面探针行有了 `pN` id，可按 id `networkDetail` / `replay`，并可用 `window.__dshProbeRespLimit` 可选记录响应体；`fetch` 拉 `.js` 不再刷 JSON 解析失败，4xx + `text/html` 会提示“可能是网关超时页”；`networkLog` 时间戳到毫秒，`sourceSearch` 列出实际扫描的文件并支持 `scripts` 指定。

## 升级注意

- **1.19.0 扩展和 `lib/` 都有改动**：`chrome://extensions` 点刷新箭头 → 目标页 **F5** → 重启 DSH，三步都要做。
- 只升级扩展：`chrome://extensions` 点刷新箭头，再到目标页 **F5**（只重载扩展不刷页面，旧标签里还是旧脚本）。
- 只升级插件（`lib/` 有改动）：重启 DSH。
- 两边版本尽量一致，版本差太多时会提示方向。

## 已知限制

- 扩展只在**和 DSH 同一台机器**上有用，只连 `127.0.0.1`，不联外网。
- Chrome 只支持「加载已解压的扩展程序」，不支持双击 `crx`（原因见 INSTALL.md 附录）。
- 首次使用必须在扩展详情里把「网站访问权限」改成「在所有网站上」，否则不注入脚本。

MIT License © 2026 QLing
