// 临时自测：用假 bridge 验证新动作的消息格式化（不连扩展）。
import { performAction } from '../lib/actions.js'

const calls = []
const bridge = {
  async call(action, params = {}) {
    calls.push({ action, params })
    if (action === 'frames') {
      return {
        ok: true, tab: { id: 1, title: '门户', url: 'http://x/' },
        count: 2,
        frames: [
          { frameId: 0, parentFrameId: -1, url: 'http://x/', title: '门户', textLength: 56, size: '1920x924', visible: true },
          { frameId: 97, parentFrameId: 0, url: 'http://x/b.html', title: '电子批记录', textLength: 3177, size: '1920x874', visible: true },
        ],
        hint: 'frameId 就是动作里的 frame 参数',
      }
    }
    if (action === 'rows') {
      return {
        ok: true, tab: { id: 1, title: '门户', url: 'http://x/' }, count: 2, in: 'tbody tr',
        rows: [
          { ref: 'r0', text: '1 生产中 BA04261103203', checked: true, hasCheckbox: true, frame: 'BSM' },
          { ref: 'r1', text: '2 新增 BA04261103103', checked: null, hasCheckbox: false, frame: '' },
        ],
      }
    }
    if (action === 'downloads') {
      return { ok: true, tab: { id: 1 }, total: 1, rows: [{ state: 'completed', received: 2048, file: 'log.zip' }] }
    }
    if (action === 'eval') {
      return { ok: true, tab: { id: 1, title: '门户', url: 'http://x/' }, type: 'string', value: 'X'.repeat(50), truncated: true, valueLength: 50000, world: 'MAIN', runId: 'run-1' }
    }
    return { ok: false, errorCode: 'UNEXPECTED', error: action }
  },
}

const out = []
for (const action of ['frames', 'rows', 'downloads']) {
  const r = await performAction(bridge, action, { tabId: 1 })
  out.push(`--- ${action} ok=${r.ok}\n${r.message}`)
}
const e = await performAction(bridge, 'eval', { code: '1+1', maxChars: 10, saveTo: 'eval-test.txt' }, { root: process.env.TEMP })
out.push(`--- eval ok=${e.ok} file=${e.detail.file}\n${e.message}`)

console.log(out.join('\n\n'))
