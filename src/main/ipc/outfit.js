// src/main/ipc/outfit.js
// 装束的宿主侧：接渲染层上报的装束清单、把当前装束落盘。
//
// 职责边界（和 presence 一样，宿主不产生权威状态）：
//   · 装束清单来自模型目录的 nagi-outfit.json，只有渲染层能读（走 nagi-local://），
//     所以这里**只做缓存**（存在 outfit-state.js 里，托盘菜单读它）；
//   · "换装束"本身由渲染层执行（它才拿得到模型），宿主只通过 sendOutfitCommand 下发；
//   · 当前装束落盘到 settings.live2d.outfit，关掉凪再打开她还是那一身。
import { ipcMain } from 'electron'
import { reportCatch, CATCH_CLASS } from '../maintenance.js'
import { OUTFIT_IPC } from '../../shared/protocol.js'
import { setOutfitCatalog } from '../outfit-state.js'
import { saveSettings } from '../settings-store.js'
import { refreshTrayMenu } from '../tray.js'

export function registerOutfitIpc() {
  ipcMain.handle(OUTFIT_IPC.REPORT, (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const looks = Array.isArray(p.looks) ? p.looks.filter((l) => l && l.id) : []
    const current = typeof p.current === 'string' ? p.current : ''
    const next = {
      looks: looks.map((l) => ({ id: String(l.id), name: String(l.name || l.id), desc: String(l.desc || '') })),
      current,
      name: String(p.name || ''),
      slots: p.slots && typeof p.slots === 'object' ? p.slots : null,
      describe: String(p.describe || '')
    }
    const prev = setOutfitCatalog(next)

    // 落盘：优先记 look id；"只动了一处"没有对应预设时就记槽位表
    try {
      const value = current || (next.slots ? next.slots : '')
      if (value) saveSettings({ live2d: { outfit: value } })
    } catch (__err) { reportCatch('outfit.registerOutfitIpc', CATCH_CLASS.MUST_PERSIST, __err) }
    if (prev.current !== next.current || prev.looks.length !== next.looks.length) refreshTrayMenu()
    return { ok: true, current }
  })
}
