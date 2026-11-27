## 装什么

| 文件 | 给谁 | 怎么用 |
|---|---|---|
| `dsh-chrome-extension-1.20.1.zip` | Chrome | 解压到固定目录 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dsh-chrome-extension/` |
| `dsh-chrome-1.20.1.tgz` | DSH | 解压到 `~/.dsh/profiles/desktop/node_modules/dsh-chrome`，再在 `cordis.patch.yml` 里插入 bundle |
| `SHA256SUMS.txt` | 校验 | `Get-FileHash .\dsh-chrome-extension-1.20.1.zip -Algorithm SHA256` 对一下 |

完整步骤（含权限、升级、排查）：[INSTALL.md](https://github.com/qlings/dsh-chrome/blob/main/INSTALL.md)。

## 这一版是什么

`1.20.1` 补上 `replay` 的 `authFrom` 实现（1.20.0 的文档先写了、代码没做：探针行的 `Authorization` 是脱敏的，不补必 401）。`1.20.0` 修的是「iframe 场景下的取证与误报」：iframe 跳转后旧 frameId 失效，不再误报成「页面不让注入」，改报 `FRAME_STALE` 并提示重新 `frames`；`replay` 的失败响应（401/HTML 错误页）不再覆盖你指定的 `.json`，另存 `.err.html` 并在 401 时给 `authFrom` 提示；`fetch` 批量新增 `nameFrom`，可把请求体字段（如 `wftmpCode`）做进文件名；`read` 自动下沉到子 iframe 时回执写明读的是谁；`outline` 遇到整页元素全隐藏（`display:none` 的 iframe）直接给 `eval` 打法。文档补了「多个界面 = 一个壳页多个 iframe」、不可逆操作的 `netBlock` dry-run 配方，并新增 `references/mom-workflow.md`（MOM 审批流取证：模板/任务/审批详情接口与状态码语义）。

## 升级注意

- **1.20.0 扩展和 `lib/` 都有改动**：`chrome://extensions` 点刷新箭头 → 目标页 **F5** → 重启 DSH，三步都要做。1.20.1 只改了 `lib/`，重启 DSH 即可（页面会提示 F5，跟随发布号）。
- 只升级扩展：`chrome://extensions` 点刷新箭头，再到目标页 **F5**（只重载扩展不刷页面，旧标签里还是旧脚本）。
- 只升级插件（`lib/` 有改动）：重启 DSH。
- 两边版本尽量一致，版本差太多时会提示方向。

## 已知限制

- 扩展只在**和 DSH 同一台机器**上有用，只连 `127.0.0.1`，不联外网。
- Chrome 只支持「加载已解压的扩展程序」，不支持双击 `crx`（原因见 INSTALL.md 附录）。
- 首次使用必须在扩展详情里把「网站访问权限」改成「在所有网站上」，否则不注入脚本。

MIT License © 2026 QLing
