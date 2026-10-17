// src/main/outfit-state.js
// 装束的宿主侧共享状态：托盘菜单要读它、IPC 要写它、热键要往下发指令。
// 单独放一个模块是为了避免 tray.js ↔ ipc/outfit.js 互相 import 成环。
import { EVT } from '../shared/protocol.js'
import { broadcast } from './windows.js'

let catalog = { looks: [], current: '', name: '', slots: null, describe: '' }

/** 当前已知的装束清单（渲染层上报什么就是什么，宿主不自己造） */
export function outfitCatalog() {
  return catalog
}

export function setOutfitCatalog(next) {
  catalog = next
  return catalog
}

/** 主进程 → 渲染层下发装束指令（热键、托盘菜单都走这里） */
export function sendOutfitCommand(action, lookId = null) {
  broadcast(EVT.OUTFIT, { action, lookId, at: Date.now() })
}
