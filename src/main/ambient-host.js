// src/main/ambient-host.js
// 宿主侧：把待机行为相关的系统绑定（目前是全局热键）跟设置对齐。
// 启动时和设置变更后都会走这里，所以用户关掉热键是**立刻**生效，不用重启。
import { registerShortcuts } from './shortcuts.js'
import { sendOutfitCommand } from './outfit-state.js'

let lastReport = { ok: [], failed: [], skipped: false }

/**
 * 按设置同步宿主侧绑定。
 * @param {object} settings 完整设置（取 settings.ambient）
 */
export function syncAmbientHost(settings) {
  const ambient = settings?.ambient || {}
  lastReport = registerShortcuts({
    enabled: ambient.hotkeys !== false,
    handlers: {
      next: () => sendOutfitCommand('next'),
      prev: () => sendOutfitCommand('prev'),
      act: () => sendOutfitCommand('act')
    }
  })
  if (lastReport.skipped) {
    console.log('[shortcuts] 已按设置关闭')
  } else {
    const failed = lastReport.failed.map((f) => f.acc)
    console.log(`[shortcuts] 已注册 ${lastReport.ok.length} 个${failed.length ? '，被占用：' + failed.join(',') : ''}`)
  }
  return lastReport
}

export function shortcutReport() {
  return lastReport
}
