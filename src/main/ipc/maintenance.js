// src/main/ipc/maintenance.js
// B8（CONTRACTS §12.2）：把"哪些失败点正在出事"暴露给界面。
//
// 此处仍只有读取与清除；renderer 写入走独立的白名单 renderer-health IPC。
// 界面拿到的是**已脱敏**的站点/类别/次数，不含正文与路径。
import { trustedHandle } from './trusted.js'
import { MAINTENANCE_IPC } from '../../shared/protocol.js'
import { clearMaintenanceTrace, clearRendererHealthStore, maintenanceHealth, maintenanceTrace } from '../maintenance.js'

export function registerMaintenanceIpc() {
  trustedHandle(MAINTENANCE_IPC.HEALTH, () => ({
    ...maintenanceHealth(),
    // 只给最近 10 条，界面不需要整条轨迹
    trace: maintenanceTrace(10)
  }))
  trustedHandle(MAINTENANCE_IPC.CLEAR, () => {
    clearMaintenanceTrace()
    if (!clearRendererHealthStore()) throw new Error('维护状态清除失败')
    return { ok: true }
  })
}
