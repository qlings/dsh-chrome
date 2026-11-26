/**
 * tabnote.js —— 「这条回执到底打在哪个标签上」。
 *
 * 为什么单独一个文件：actions.js（普通动作）和 extra.js（CDP 那批）都要用，
 * 而 extra.js 已经被 actions.js import，反过来 import 会成环。
 *
 * 背景（2026-11-20）：一次排查里连续三次 eval 打到了别的标签，回执标题行
 * 是唯一的线索，得人盯着才看得出来。扩展其实一直把 tabVia 带回来了，
 * 只是没人显示。这里把它显出来，并在「显式传了 tabId、实际却没按 tabId 选」
 * 时直接告警——这种情况下写操作会落到错误页面。
 */

/**
 * @param {object} data 扩展回的命令数据（带 tabVia / tabIdRequested）
 * @returns {string} 拼在标题行后面的说明；正常情况（显式 tabId 且生效）返回空串
 */
export function viaTag(data) {
  const via = data && data.tabVia
  if (!via) return ''
  // 显式指定、且确实按它选的：正常路径，不打扰。
  if (via === 'tabId') return ''
  const asked = data.tabIdRequested
  if (asked != null && asked !== '') {
    return ` · ⚠️ 请求的 tabId=${asked} 没被采纳，实际是按 via=${via} 选的标签`
  }
  // 没传 tabId：说明这条命令是跟着活动标签/sticky/urlContains 走的，值得看一眼。
  return ` · via=${via}`
}
