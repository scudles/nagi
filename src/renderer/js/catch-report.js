// Renderer B8: immediate local state plus a bounded, sanitized retry queue to
// the main-process health registry. Only fixed sites cross the boundary.
import { reportCatch, CATCH_CLASS, __health, __trace } from '../../core/maintenance/reporter.js'
import { RENDERER_HEALTH_SITES, validRendererHealthEvent } from '../../shared/renderer-health-protocol.js'

export { CATCH_CLASS }

const reportedAt = new Map()
const pending = []
const recoverySent = new Set()
const REPEAT_MS = 60_000
const MAX_PENDING = 64
const QUEUE_KEY = 'nagi.rendererHealth.pending.v1'
let loaded = false
let flushing = null
const lastIssues = new Map()

function localIssue(site, now = Date.now()) {
  const last = lastIssues.get(site)
  if (last !== undefined && now - last < REPEAT_MS) return
  lastIssues.set(site, now)
  reportCatch(`renderer.${site}`, CATCH_CLASS.VISIBLE, new Error('健康状态同步失败'))
}

function recoverLocalIssue(site) {
  const key = `renderer.${site}`
  if (__health.snapshot().some((row) => row.site === key && row.lastClass)) {
    __health.recover(key, '已恢复')
    __trace.push({ at: Date.now(), site: key, cls: 'recovered', message: '已恢复' })
  }
}

function ownSource() {
  try {
    const mode = new URLSearchParams(window.location.search).get('mode')
    return ['pet', 'workbench', 'diary'].includes(mode) ? mode : null
  } catch { return null }
}

function queueKey() { return `${QUEUE_KEY}:${ownSource() || 'unknown'}` }

function storage() {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function loadPending() {
  if (loaded) return
  if (!storage()) { localIssue('healthQueueStore'); return }
  loaded = true
  try {
    const rows = JSON.parse(storage().getItem(queueKey()) || '[]')
    if (!Array.isArray(rows)) throw new Error('invalid queue')
    for (const row of rows.slice(-MAX_PENDING)) if (validRendererHealthEvent(row)) pending.push(row)
    if (rows.length > MAX_PENDING) localIssue('healthQueueOverflow')
  } catch { localIssue('healthQueueStore') }
}

function savePending() {
  try {
    const bucket = storage()
    if (!bucket) throw new Error('storage unavailable')
    bucket.setItem(queueKey(), JSON.stringify(pending))
    recoverLocalIssue('healthQueueStore')
  }
  catch { localIssue('healthQueueStore') }
}

function eventId() {
  try { return crypto.randomUUID().replaceAll('-', '') }
  catch { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}` }
}

function enqueue(site, cls, action) {
  loadPending()
  const event = { id: eventId(), site, cls, action }
  if (pending.length >= MAX_PENDING) {
    pending.shift()
    localIssue('healthQueueOverflow') // bounded loss is visible in local health
  }
  pending.push(event)
  savePending()
  void flushRendererHealth()
}

export function reportRendererCatch(site, cls, error, now = Date.now()) {
  const key = `renderer.${site}`
  const repeatKey = `${site}:${cls}`
  const last = reportedAt.get(repeatKey)
  if (last !== undefined && now - last < REPEAT_MS) return false
  reportedAt.set(repeatKey, now)
  if (reportedAt.size > 200) reportedAt.delete(reportedAt.keys().next().value)
  // Never pass exception text, file paths or IPC payloads into maintenance.
  const kind = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'Error'
  reportCatch(key, cls, new Error(kind))
  if (RENDERER_HEALTH_SITES[site] === cls) {
    recoverySent.delete(site)
    enqueue(site, cls, 'fail')
  }
  return true
}

export function recoverRendererCatch(site) {
  const cls = RENDERER_HEALTH_SITES[site]
  if (!cls) return false
  const key = `renderer.${site}`
  const active = __health.snapshot().some((row) => row.site === key && row.lastClass === cls)
  if (!active && recoverySent.has(site)) return false
  if (active) {
    __health.recover(key, '已恢复')
    __trace.push({ at: Date.now(), site: key, cls: 'recovered', message: '已恢复' })
  }
  reportedAt.delete(`${site}:${cls}`)
  recoverySent.add(site)
  enqueue(site, cls, 'recover')
  return true
}

export async function flushRendererHealth() {
  loadPending()
  if (flushing) return flushing
  if (!pending.length) return true
  flushing = (async () => {
    while (pending.length) {
      const send = typeof window === 'undefined' ? null : window.nagi?.maintenance?.reportRenderer
      if (typeof send !== 'function') { localIssue('healthTransport'); return false }
      try {
        const result = await send(pending[0])
        if (!result?.ok) { localIssue('healthTransport'); return false }
        pending.shift()
        savePending()
      } catch { localIssue('healthTransport'); return false }
    }
    recoverLocalIssue('healthTransport')
    return true
  })()
  try { return await flushing } finally { flushing = null }
}

export function rendererMaintenanceState() {
  return { healthy: __health.healthy(), sites: __health.snapshot(), trace: __trace.list(10) }
}

export function mergeMaintenanceState(main, local = rendererMaintenanceState(), source = ownSource()) {
  const sites = [...(main.sites || [])]
  const mainKeys = new Set(sites.map((row) => row.site))
  const pendingSites = new Set(pending.map((row) => row.site))
  for (const row of local.sites) {
    const raw = row.site.startsWith('renderer.') ? row.site.slice('renderer.'.length) : null
    const remote = source && raw && `renderer:${source}/${raw}`
    if (raw && RENDERER_HEALTH_SITES[raw] && remote) {
      if (pendingSites.has(raw) && mainKeys.has(remote)) {
        const index = sites.findIndex((s) => s.site === remote)
        sites[index] = { ...row, site: remote, count: Math.max(row.count, sites[index].count) }
      } else if (pendingSites.has(raw)) sites.push({ ...row, site: remote })
      // Once acknowledged, the main snapshot is authoritative. A clear in
      // another window must not resurrect an old local copy.
      continue
    }
    sites.push(row)
  }
  const localTrace = local.trace.filter((t) => {
    const raw = t.site.startsWith('renderer.') ? t.site.slice('renderer.'.length) : null
    return !raw || !RENDERER_HEALTH_SITES[raw] || !source || pendingSites.has(raw)
  })
  return {
    healthy: sites.every((row) => !row.lastClass || row.lastClass === CATCH_CLASS.DEGRADE),
    sites,
    trace: [...(main.trace || []), ...localTrace].sort((a, b) => b.at - a.at).slice(0, 10)
  }
}

export function clearRendererMaintenance() {
  reportedAt.clear()
  recoverySent.clear()
  pending.length = 0
  savePending()
  __trace.clear()
  __health.reset()
}

if (typeof window !== 'undefined') queueMicrotask(() => { void flushRendererHealth() })
