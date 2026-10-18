// src/main/maintenance.js
// B8（P2-04）：主进程侧的失败轨迹与健康状态入口。
//
// 这里只做装配：轨迹与健康状态都汇聚到 core 的单例 —— core 里的模块
// （ledger store / reminders delivery / …）自己也要上报，不能反向依赖 main。
// 只存在内存，有上限，可一键清空。分类与脱敏都在 core（可纯单测）。
import { reportCatch, __trace, __health } from '../core/maintenance/reporter.js'

export { reportCatch }
// 分类常量一并再导出：接线点写一条 import 就够，免得同一个文件冒出两条 maintenance 依赖。
export { CATCH_CLASS } from '../core/maintenance/catch-audit.js'

/** 最近 n 条失败轨迹（脱敏后） */
export function maintenanceTrace(n) {
  return __trace.list(n)
}

/**
 * 健康状态：哪些失败点正在出事、出过几次、最近一次的类别。
 * 只读快照，供工作台/验收查看（本轮未接 IPC，见 HANDOFF）。
 */
export function maintenanceHealth() {
  return { healthy: __health.healthy(), sites: __health.snapshot() }
}

/** 一键清空（可删：内存里不留副本） */
export function clearMaintenanceTrace() {
  __trace.clear()
  __health.reset()
}

/** 仅测试用：拿到内部轨迹对象，便于断言有界/脱敏 */
export function __traceForTest() {
  return __trace
}
