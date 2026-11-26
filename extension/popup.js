const $ = (id) => document.getElementById(id)

const PROBE_PORTS = [18765, 18766, 18767, 18768, 18769]

async function probe() {
  const { dshChromePort } = await chrome.storage.local.get('dshChromePort')
  const pinned = dshChromePort ? Number(dshChromePort) : 0
  // 存过的端口只当首选，不能钉死（以前"重连"把 18766 记下来，桥回到 18765 就再也找不到）
  const ports = pinned ? [pinned, ...PROBE_PORTS.filter((p) => p !== pinned)] : PROBE_PORTS
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { cache: 'no-store' })
      const info = await res.json()
      if (info && info.running && info.bridge === 'dsh-chrome') {
        if (pinned && pinned !== port) chrome.storage.local.set({ dshChromePort: port }).catch(() => {})
        return { port, info }
      }
    } catch { /* 下一个 */ }
  }
  return null
}

async function refresh() {
  const hit = await probe()
  const { dshChromePort } = await chrome.storage.local.get('dshChromePort')
  $('port').value = hit?.port || Number(dshChromePort) || 18765

  if (hit && hit.info.connected) {
    $('dot').className = 'dot on'
    $('state').textContent = `已连上 DSH（端口 ${hit.port} · 桥 v${hit.info.version}）`
    $('hint').textContent = `排队 ${hit.info.queued} · 在途 ${hit.info.inflight}`
  } else if (hit) {
    $('dot').className = 'dot off'
    $('state').textContent = `桥在 ${hit.port}，但扩展还没接上`
    $('hint').textContent = '点「重连」；还不行就在 chrome://extensions 里重新加载扩展。'
  } else {
    $('dot').className = 'dot off'
    $('state').textContent = '没找到 DSH 桥'
    $('hint').textContent = '先在 DSH 里启用 dsh-chrome 插件（桥会在 18765-18769 里找空位），再点「重连」。'
  }

  const { dshChromeLog = [] } = await chrome.storage.local.get('dshChromeLog')
  $('log').innerHTML = dshChromeLog.length
    ? dshChromeLog.slice(0, 20).map((e) => {
      const time = new Date(e.ts).toLocaleTimeString()
      const tab = e.tab ? ` · ${e.tab.title || e.tab.url}` : ''
      const mark = e.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'
      const err = e.error ? `<div class="bad">${escapeHtml(e.error)}</div>` : ''
      return `<div class="item">${mark} <b>${escapeHtml(e.action)}</b> <span class="t">${time} · ${e.ms}ms${escapeHtml(tab)}</span>${err}</div>`
    }).join('')
    : '<div class="item sub">还没有操作记录</div>'
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

$('save').addEventListener('click', async () => {
  const port = Math.max(1024, Math.min(65535, Number($('port').value) || 18765))
  await chrome.storage.local.set({ dshChromePort: port })
  await chrome.runtime.sendMessage({ type: 'poke' }).catch(() => {})
  refresh()
})

$('poke').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'poke' }).catch(() => {})
  setTimeout(refresh, 600)
})

// 重载扩展 = chrome://extensions 里那个刷新箭头：改完代码后点它，再回页面 F5。
$('reload').addEventListener('click', () => {
  chrome.runtime.reload()
})

refresh()
setInterval(refresh, 3000)
