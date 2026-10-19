// src/main/maintenance.js
// B8（P2-04）：主进程侧的失败轨迹与健康状态入口。
//
// 这里只做装配：主进程原有轨迹与健康状态来自 core 单例，renderer
// 白名单事件来自独立 store。core 模块不反向依赖 main。
// 主进程原有轨迹在内存；renderer 白名单事件由独立 IO store 持久化。
// 两者都有限额并可从同一维护入口清空，分类与脱敏仍沿用 core。
import { reportCatch, __trace, __health } from '../core/maintenance/reporter.js'

let rendererHealthStore = null
export function attachRendererHealthStore(store) { rendererHealthStore = store }
export function clearRendererHealthStore() { return rendererHealthStore?.clear() ?? true }

export { reportCatch }
// 分类常量一并再导出：接线点写一条 import 就够，免得同一个文件冒出两条 maintenance 依赖。
export { CATCH_CLASS } from '../core/maintenance/catch-audit.js'

/** 最近 n 条失败轨迹（脱敏后） */
export function maintenanceTrace(n) {
  const cap = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 200
  return [...__trace.list(cap), ...(rendererHealthStore?.trace(cap) || [])]
    .sort((a, b) => b.at - a.at).slice(0, cap)
}

/**
 * 健康状态：哪些失败点正在出事、出过几次、最近一次的类别。
 * 只读合并快照，供现有 maintenance IPC 与设置页查看。
 */
export function maintenanceHealth() {
  return {
    healthy: __health.healthy() && (rendererHealthStore?.healthy() ?? true),
    sites: [...__health.snapshot(), ...(rendererHealthStore?.snapshot() || [])]
  }
}

/**
 * 恢复：同一站点重新成功时调用（B8-PROMISE-01 要求"成功送达后有明确的恢复状态"）。
 * 没红过的站点不会造出记录——没有失败就没有"恢复"这件事。
 * @returns {null|object} 恢复后的站点快照
 */
export function maintenanceRecover(site, note = '') {
  return __health.recover(site, note)
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
