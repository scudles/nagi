import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATES = new Set(['scheduled', 'attempting', 'attempted', 'delivered', 'completed', 'failed', 'missed', 'cancelled', 'legacy-unknown'])
const COMPLETION_EVIDENCE = new Set(['user-confirmation', 'file-write-result', 'verified-result'])

export class PromiseBook {
  constructor(userDataDir) {
    this.path = join(userDataDir, 'promises.json')
    this.entries = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    if (existsSync(this.path)) {
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      let recovered = false
      for (const item of Array.isArray(data?.entries) ? data.entries : []) {
        if (item && typeof item.id === 'string' && STATES.has(item.status)) {
          if (item.status === 'attempting') {
            item.status = 'attempted'
            item.evidence = [...(item.evidence || []), { kind: 'interrupted-on-restart', at: Date.now() }]
            recovered = true
          }
          this.entries.set(item.id, item)
        }
      }
      this.loaded = true
      if (recovered) this.persist()
    }
    this.loaded = true
    return this
  }

  persist() {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true })
    const temp = this.path + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2), 'utf8')
    renameSync(temp, this.path)
  }

  get(id) {
    this.load()
    const item = this.entries.get(String(id || ''))
    return item ? structuredClone(item) : null
  }

  list() {
    this.load()
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt).map((item) => structuredClone(item))
  }

  create({ id = 'p_' + randomUUID(), kind, title, source, dueAt = null, status = 'scheduled', at = Date.now() }) {
    this.load()
    if (this.entries.has(id)) return this.get(id)
    if (!STATES.has(status) || !title || !source?.type) throw new Error('承诺信息不完整')
    const item = { id, kind, title: String(title), source, dueAt, status,
      createdAt: at, updatedAt: at, evidence: [] }
    this.entries.set(id, item)
    try { this.persist() } catch (err) { this.entries.delete(id); throw err }
    return this.get(id)
  }

  transition(id, status, evidence = null, at = Date.now()) {
    this.load()
    const before = this.entries.get(String(id || ''))
    if (!before || !STATES.has(status)) throw new Error('找不到这条承诺或状态非法')
    if (['completed', 'cancelled'].includes(before.status)) {
      if (before.status === status) return this.get(before.id)
      throw new Error('已结束的承诺不能被重新标记')
    }
    if (status === 'completed' && !COMPLETION_EVIDENCE.has(evidence?.kind)) {
      throw new Error('完成必须有用户确认或可核实的结果证据')
    }
    if (status === 'delivered' && evidence?.kind !== 'notification-dispatched') {
      throw new Error('送达必须有通知发出证据')
    }
    const next = { ...before, status, updatedAt: at,
      evidence: evidence ? [...before.evidence, { ...evidence, at }] : before.evidence }
    this.entries.set(before.id, next)
    try { this.persist() } catch (err) { this.entries.set(before.id, before); throw err }
    return this.get(before.id)
  }

  updateDueAt(id, dueAt, at = Date.now()) {
    this.load()
    const before = this.entries.get(id)
    if (!before) throw new Error('找不到这条承诺')
    if (['completed', 'cancelled'].includes(before.status)) throw new Error('已结束的承诺不能重新排期')
    const next = { ...before, dueAt, status: 'scheduled', updatedAt: at }
    this.entries.set(id, next)
    try { this.persist() } catch (err) { this.entries.set(id, before); throw err }
    return this.get(id)
  }
}
