/**
 * content.js —— 常驻页面的执行端（只负责派活）。
 *
 * 真正的页面函数都在 page.js（manifest 里排在前面先加载），那边是唯一来源。
 * 以前这个文件里抄了一整份执行逻辑，和 executor.js 各改各的，结果就是
 * 「同一台机器、同一个页面，F5 前后行为不一样」——别再分叉了。
 *
 * 注意：content script 不是 module，不能用 import/export。
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'dsh-chrome-page') return false
  const page = globalThis.__dshPage
  const fn = page && page[msg.name]
  if (!fn) {
    sendResponse({
      ok: false,
      errorCode: 'NO_HANDLER',
      error: '这个页面的 content script 太旧或者没加载（缺 ' + msg.name + '）。在 Chrome 里重载扩展，再刷新页面。',
    })
    return false
  }
  try {
    const out = fn(msg.args || {})
    if (out && typeof out.then === 'function') {
      out.then(
        (value) => sendResponse(value),
        (error) => sendResponse({ ok: false, errorCode: 'PAGE_ERROR', error: String((error && error.message) || error) }),
      )
      return true
    }
    sendResponse(out)
  } catch (error) {
    sendResponse({ ok: false, errorCode: 'PAGE_ERROR', error: String((error && error.message) || error) })
  }
  return false
})
