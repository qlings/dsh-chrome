## 装什么

| 文件 | 给谁 | 怎么用 |
|---|---|---|
| `dsh-chrome-extension-1.18.0.zip` | Chrome | 解压到固定目录 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dsh-chrome-extension/` |
| `dsh-chrome-1.18.0.tgz` | DSH | 解压到 `~/.dsh/profiles/desktop/node_modules/dsh-chrome`，再在 `cordis.patch.yml` 里插入 bundle |
| `SHA256SUMS.txt` | 校验 | `Get-FileHash .\dsh-chrome-extension-1.18.0.zip -Algorithm SHA256` 对一下 |

完整步骤（含权限、升级、排查）：[INSTALL.md](https://github.com/qlings/dsh-chrome/blob/main/INSTALL.md)。

## 这一版是什么

`1.18.0` 把用法文档收进插件本体：`SKILL.md` + `references/` 通过 `ctx.skills` 注册成 skill「chrome」，不再依赖 `~/.dsh/skills`，换机器不会出现「工具和配方对不上」。

## 升级注意

- 只升级扩展：`chrome://extensions` 点刷新箭头，再到目标页 **F5**（只重载扩展不刷页面，旧标签里还是旧脚本）。
- 只升级插件（`lib/` 有改动）：重启 DSH。
- 两边版本尽量一致，版本差太多时会提示方向。

## 已知限制

- 扩展只在**和 DSH 同一台机器**上有用，只连 `127.0.0.1`，不联外网。
- Chrome 只支持「加载已解压的扩展程序」，不支持双击 `crx`（原因见 INSTALL.md 附录）。
- 首次使用必须在扩展详情里把「网站访问权限」改成「在所有网站上」，否则不注入脚本。

MIT License © 2026 QLing
