// Renderer B8 failures use the same class, redaction and health rules as main.
// The existing maintenance panel reads this process-local supplement alongside
// the read-only main snapshot; no new UI or IPC write channel is introduced.
import { reportCatch, CATCH_CLASS, __health, __trace } from '../../core/maintenance/reporter.js'

export { CATCH_CLASS }

const reportedAt = new Map()
const REPEAT_MS = 60_000

export function reportRendererCatch(site, cls, error, now = Date.now()) {
  const key = `renderer.${site}`
  const last = reportedAt.get(key)
  if (last !== undefined && now - last < REPEAT_MS) return false
  reportedAt.set(key, now)
  if (reportedAt.size > 200) reportedAt.delete(reportedAt.keys().next().value)
  // Do not pass arbitrary model text, file paths or IPC payloads into the
  // maintenance view. The stable site and Error type suffice for diagnosis.
  const kind = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'Error'
  reportCatch(key, cls, new Error(kind))
  return true
}

export function rendererMaintenanceState() {
  return { healthy: __health.healthy(), sites: __health.snapshot(), trace: __trace.list(10) }
}

export function mergeMaintenanceState(main, local = rendererMaintenanceState()) {
  return {
    healthy: main.healthy !== false && local.healthy,
    sites: [...(main.sites || []), ...local.sites],
    trace: [...(main.trace || []), ...local.trace].sort((a, b) => b.at - a.at).slice(0, 10)
  }
}

export function clearRendererMaintenance() {
  reportedAt.clear()
  __trace.clear()
  __health.reset()
}
