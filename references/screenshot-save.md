# 截图与落盘

## 1. 默认目录

- 截图不带 `saveTo`：`~/.dsh/chrome/shots/`
- `pdf` / `mhtml` / `value` / `eval` / `fetch` / `sourceSearch`：`~/.dsh/chrome/out/`（或 `saveTo` 指定路径）
- 1.16.0 起 `screenshot` 也支持 `saveTo`，规则与其它动作一致：纯文件名进 `out/`，带目录/盘符/`~` 按路径写。

```json
{"action":"screenshot","clip":{"x":0,"y":0,"width":1920,"height":900}}
{"action":"screenshot","selector":"#panel","saveTo":"./shots/panel.png"}
{"action":"screenshot","fullPage":true,"format":"jpeg","quality":80,"saveTo":"C:/work/full.jpg"}
```

## 2. 尺寸与像素

- `clip` 的单位是 **CSS 像素**；文件实际像素 = clip × DPR（Windows 150% 缩放时 DPR=1.5，2K 屏常为 2）。
- 回执文件名里的 `宽x高` 是**文件真实像素**；`scale` 按最终像素算（`scale:0.5` 输出一半）。
- 只截元素：`selector`，会先滚进视口再按文档坐标裁；元素找不到会回退整屏并在回执标注。

## 3. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 截出「四宫格/重复画面」 | 页面还在合成/多 iframe 重绘，CDP 拿到旧帧 | 重拍一次；先 `wait time:0.3` 或等元素稳定；尽量用 `clip` 限定视口 |
| 截图比预期大 | DPR 缩放 | 用 `scale` 或按 DPR 换算 clip |
| 整页截图超时 | 页面过长/图多 | 回执会退回视口截图；改用 `clip` 分段截 |
| 弹窗没截到 | 点击后弹窗还没渲染 | 点完 `wait selector:".el-dialog"` 再截 |
| 图片全黑 | 页面在后台/被遮挡且 CDP 不可用 | 先 `diag` 看 CDP；切到前台再截 |

## 4. 建议流程（写文档/留证）

1. `navigate` + `wait selector` 等关键元素。
2. `screenshot` + `clip`（固定 1920×900 视口内容区）+ `saveTo` 到工作区。
3. 若用于 Word/PDF，统一 `scale:1`，后期再压缩，不要截二次缩放图。

## 5. 其它导出

- `pdf`：整页 PDF，适合留证；打印背景用 `printBackground:true`。
- `mhtml`：单文件离线存档，可当文本 grep。
- 大响应正文：`fetch` + `saveTo`，不要灌进上下文。
