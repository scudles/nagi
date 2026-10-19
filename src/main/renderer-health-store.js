// IO-only supplement to main maintenance. Disk contains fixed identifiers and
// timestamps, never exception messages or renderer payloads.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RENDERER_HEALTH_SITES, RENDERER_HEALTH_SOURCES, validRendererHealthEvent } from '../shared/renderer-health-protocol.js'

const MAX_SITES = 50
const MAX_IDS = 200
const MAX_TRACE = 100
const REPEAT_MS = 60_000

function safeRow(row) {
  if (!row || !RENDERER_HEALTH_SOURCES.includes(row.source) ||
      !Object.hasOwn(RENDERER_HEALTH_SITES, row.rawSite)) return null
  const cls = RENDERER_HEALTH_SITES[row.rawSite]
  const count = Math.min(1_000_000, Math.max(0, Math.trunc(Number(row.count) || 0)))
  if (!count) return null
  const lastAt = Math.max(0, Number(row.lastAt) || 0)
  const recoveredAt = row.recoveredAt === null ? null : Math.max(0, Number(row.recoveredAt) || 0)
  return {
    site: `renderer:${row.source}/${row.rawSite}`,
    source: row.source, rawSite: row.rawSite, count, lastAt,
    lastClass: row.lastClass === cls ? cls : null,
    lastMessage: row.lastClass === cls ? '渲染层操作失败' : '已恢复',
    recoveredAt
  }
}

export function createRendererHealthStore({ file, now = Date.now, io = {}, onPersistFailure = () => {}, onPersistRecovery = () => {} } = {}) {
  if (!file) throw new TypeError('renderer health file required')
  const fs = { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, ...io }
  const sites = new Map()
  const ids = new Map()
  let trace = []
  let dirty = false

  function failed() {
    dirty = true
    onPersistFailure(new Error('renderer-health.json 写入或读取失败'))
  }
  function save() {
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sites: [...sites.values()], ids: [...ids], trace }), 'utf8')
      fs.renameSync(tmp, file)
      if (dirty) onPersistRecovery()
      dirty = false
      return true
    } catch {
      failed()
      return false
    }
  }
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.sites)) throw new Error('invalid health file')
      for (const value of parsed.sites.slice(-MAX_SITES)) {
        const row = safeRow(value)
        if (row) sites.set(row.site, row)
      }
      for (const pair of (Array.isArray(parsed.ids) ? parsed.ids : []).slice(-MAX_IDS)) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && /^[a-z]+:[A-Za-z0-9_-]{1,64}$/.test(pair[0])) {
          ids.set(pair[0], Math.max(0, Number(pair[1]) || 0))
        }
      }
      trace = (Array.isArray(parsed.trace) ? parsed.trace : []).slice(-MAX_TRACE)
        .filter((t) => t && typeof t.site === 'string' && sites.has(t.site) &&
          (t.cls === 'recovered' || t.cls === RENDERER_HEALTH_SITES[sites.get(t.site).rawSite]))
        .map((t) => ({
          at: Math.max(0, Number(t.at) || 0), site: t.site, cls: t.cls,
          message: t.cls === 'recovered' ? '已恢复' : '渲染层操作失败'
        }))
    }
  } catch { failed() }

  function report(source, event) {
    if (!RENDERER_HEALTH_SOURCES.includes(source) || !validRendererHealthEvent(event)) throw new TypeError('invalid renderer health event')
    const stamp = now() // renderer timestamps are deliberately ignored
    const id = `${source}:${event.id}`
    if (ids.has(id)) return { ok: !dirty || save(), duplicate: true }
    const key = `renderer:${source}/${event.site}`
    const prev = sites.get(key)
    if (event.action === 'recover' && !prev?.lastClass) return { ok: !dirty || save(), ignored: true }
    ids.set(id, stamp)
    while (ids.size > MAX_IDS) ids.delete(ids.keys().next().value)
    if (event.action === 'fail') {
      if (prev?.lastClass === event.cls && stamp - prev.lastAt < REPEAT_MS) {
        return { ok: save(), deduped: true }
      }
      const row = {
        site: key, source, rawSite: event.site,
        count: (prev?.count || 0) + 1, lastAt: stamp,
        lastClass: event.cls, lastMessage: '渲染层操作失败', recoveredAt: null
      }
      sites.delete(key)
      sites.set(key, row)
      while (sites.size > MAX_SITES) sites.delete(sites.keys().next().value)
      trace.push({ at: stamp, site: key, cls: event.cls, message: '渲染层操作失败' })
    } else if (prev?.lastClass) {
      prev.lastClass = null
      prev.recoveredAt = stamp
      prev.lastMessage = '已恢复'
      trace.push({ at: stamp, site: key, cls: 'recovered', message: '已恢复' })
    }
    trace = trace.slice(-MAX_TRACE)
    return { ok: save(), recovered: event.action === 'recover' }
  }

  return {
    report,
    snapshot: () => [...sites.values()].map((row) => ({ ...row })).sort((a, b) => b.lastAt - a.lastAt),
    trace: (n = 10) => trace.slice(-n).reverse().map((entry) => ({ ...entry })),
    healthy: () => [...sites.values()].every((row) => !row.lastClass),
    clear() { sites.clear(); ids.clear(); trace = []; return save() },
    retryPersist() { return dirty ? save() : true }
  }
}
