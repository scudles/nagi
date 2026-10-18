import { reportCatch, CATCH_CLASS } from '../maintenance/reporter.js'
/** 归来表达的延迟门和唯一运行实例。门禁在分配控制器之前执行。 */
export function createReunionCoordinator({ timeoutMs = 15000 } = {}) {
  let active = null
  return {
    get active() { return active !== null },
    abort() { active?.abort() },
    async run({ shouldDefer, work }) {
      if (active) return false
      try {
        if (shouldDefer()) return false
      } catch (__err) { reportCatch('reunion-coordinator.abort', CATCH_CLASS.VISIBLE, __err) }
      const controller = new AbortController()
      active = controller
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      timeout.unref?.()
      try {
        return await work(controller.signal)
      } finally {
        clearTimeout(timeout)
        if (active === controller) active = null
      }
    }
  }
}
