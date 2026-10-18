// src/core/maintenance/reporter.js
// B8（P2-04）：跨模块共用的失败上报单例。
//
// 为什么单独抽一层：`src/main/maintenance.js` 是主进程侧的装配，
// core 里的纯模块不能反向依赖 main。但「持久化失败」「承诺失败」恰恰
// 大量发生在 core（ledger store / reminders delivery / …），所以把
// "轨迹 + 健康状态 + 上报器"三件套放进 core，main 只是把它再导出一遍。
//
// 只存在内存：进程退出即消失，可被 clearMaintenanceTrace() 一键清空（可删性要求）。
import { createEventTrace } from './event-trace.js'
import { createCatchReporter, createHealthRegistry } from './catch-audit.js'

const trace = createEventTrace({ limit: 200 })
const health = createHealthRegistry({ maxSites: 50 })

export const reportCatch = createCatchReporter({ trace, health })

// 分类常量也在这里再导出：接线点写一条 import 就够。
export { CATCH_CLASS } from './catch-audit.js'

export const __trace = trace
export const __health = health
