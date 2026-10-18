// src/main/maintenance.js
// B8（P2-04）：主进程侧的失败轨迹单例。
//
// 为什么是单例：轨迹要能跨模块读（工作台/验收脚本要看"最近哪些 catch 真的出事了"），
// 又只该存在内存里、有上限、可一键清空。这里只装配，不含逻辑——
// 分类与脱敏都在 core（可纯单测）。
import { createEventTrace } from '../core/maintenance/event-trace.js'
import { createCatchReporter } from '../core/maintenance/catch-audit.js'

const trace = createEventTrace({ limit: 200 })

/** 统一的失败上报入口：reportCatch(站点, 分类, 错误) */
export const reportCatch = createCatchReporter({ trace })

/** 最近 n 条失败轨迹（脱敏后） */
export function maintenanceTrace(n) {
  return trace.list(n)
}

/** 一键清空（可删：内存里不留副本） */
export function clearMaintenanceTrace() {
  trace.clear()
}

/** 仅测试用：拿到内部轨迹对象，便于断言有界/脱敏 */
export function __traceForTest() {
  return trace
}
