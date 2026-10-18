// src/main/ipc/maintenance.js
// B8（CONTRACTS §12.2）：把"哪些失败点正在出事"暴露给界面。
//
// 只读 + 清除两条，没有写入通道：健康状态只能由主进程的上报器写。
// 界面拿到的是**已脱敏**的站点/类别/次数，不含正文与路径。
import { trustedHandle } from './trusted.js'
import { MAINTENANCE_IPC } from '../../shared/protocol.js'
import { clearMaintenanceTrace, maintenanceHealth, maintenanceTrace } from '../maintenance.js'

export function registerMaintenanceIpc() {
  trustedHandle(MAINTENANCE_IPC.HEALTH, () => ({
    ...maintenanceHealth(),
    // 只给最近 10 条，界面不需要整条轨迹
    trace: maintenanceTrace(10)
  }))
  trustedHandle(MAINTENANCE_IPC.CLEAR, () => {
    clearMaintenanceTrace()
    return { ok: true }
  })
}
