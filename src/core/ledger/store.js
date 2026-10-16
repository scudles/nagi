// 统一经历账本：正常新增顺序追加，纠错/删除时重写当前态以移除旧正文。
// 不依赖 Electron；目录由主进程注入，便于迁移和故障恢复测试。
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CATEGORIES = new Set(['experience', 'claim', 'subjective', 'aggregate'])
const MIGRATION_VERSION = 1

function sourceId(type, ref) {
  return 'e_' + createHash('sha256').update(`${type}:${ref}`).digest('hex').slice(0, 20)
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function readLegacyJson(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonLines(path) {
  if (!existsSync(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 崩溃留下的半行不作为事实 */ }
  }
  return rows
}

function valid(record) {
  return record && typeof record.id === 'string' &&
    CATEGORIES.has(record.category) && typeof record.text === 'string' &&
    record.source && typeof record.source.type === 'string' && typeof record.source.ref === 'string'
}

function atomicWrite(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, value, 'utf8')
  renameSync(temp, path)
}

export class ExperienceLedger {
  constructor(userDataDir) {
    this.userDataDir = userDataDir
    this.dir = join(userDataDir, 'ledger')
    this.entriesFile = join(this.dir, 'entries.jsonl')
    this.markerFile = join(this.dir, 'migration.json')
    this.entries = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    mkdirSync(this.dir, { recursive: true })
    for (const row of readJsonLines(this.entriesFile)) if (valid(row)) this.entries.set(row.id, row)
    this.loaded = true
    return this
  }

  list({ includeDeleted = false } = {}) {
    this.load()
    return [...this.entries.values()]
      .filter((entry) => includeDeleted || !entry.deletedAt)
      .sort((a, b) => (b.occurredAt || b.recordedAt) - (a.occurredAt || a.recordedAt))
      .map((entry) => structuredClone(entry))
  }

  get(id) {
    this.load()
    const entry = this.entries.get(String(id || ''))
    return entry ? structuredClone(entry) : null
  }

  deleteBySource(type, ref, at = Date.now()) {
    this.load()
    const id = sourceId(type, String(ref))
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt) return false
    const updated = { ...entry, text: '', meta: {}, revision: entry.revision + 1, deletedAt: at }
    const rows = [...this.entries.values()].map((row) => JSON.stringify(row.id === id ? updated : row)).join('\n') + '\n'
    atomicWrite(this.entriesFile, rows)
    this.entries.set(id, updated)
    return true
  }

  record({ category, text, source, occurredAt = null, recordedAt = Date.now(), certainty = 'observed', ragIds = [], meta = {} }) {
    this.load()
    const body = String(text || '').trim()
    if (!CATEGORIES.has(category) || !body || !source?.type) return null
    const ref = String(source.ref || randomUUID())
    const id = sourceId(source.type, ref)
    if (this.entries.has(id)) return this.get(id)
    const entry = {
      id, category, text: body,
      source: { type: String(source.type), ref },
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
      recordedAt: Number.isFinite(recordedAt) ? recordedAt : Date.now(),
      certainty, ragIds: [...new Set(ragIds.filter(Boolean).map(String))],
      meta: meta && typeof meta === 'object' ? meta : {},
      revision: 1, correctedAt: null, deletedAt: null
    }
    appendFileSync(this.entriesFile, JSON.stringify(entry) + '\n', 'utf8')
    this.entries.set(id, entry)
    return structuredClone(entry)
  }

  /** 一次性迁移旧文件；保留原件，不根据无时间戳的历史猜测发生时间。 */
  migrateLegacy() {
    this.load()
    const marker = readJson(this.markerFile, { version: 0 })
    if (marker.version >= MIGRATION_VERSION) return { migrated: false, count: 0 }
    let count = 0
    const add = (fields) => {
      if (!fields.text || this.entries.has(sourceId(fields.source.type, fields.source.ref))) return
      if (this.record(fields)) count++
    }
    const dir = this.userDataDir

    const journalDir = join(dir, 'journal')
    if (existsSync(journalDir)) {
      for (const name of readdirSync(journalDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
        const data = readLegacyJson(join(journalDir, name), { entries: [] })
        for (const [i, event] of (Array.isArray(data.entries) ? data.entries : []).entries()) {
          const text = event.kind === 'chat'
            ? [event.user && `他：${event.user}`, event.reply && `我：${event.reply}`].filter(Boolean).join('\n')
            : event.text || (event.kind === 'poke' ? '用户戳了凪' : '')
          add({ category: 'experience', text, source: { type: 'journal', ref: `${name}#${i}` },
            occurredAt: event.t, certainty: 'legacy-record', meta: { eventKind: event.kind } })
        }
      }
    }

    const diaryDir = join(dir, 'monologue')
    if (existsSync(diaryDir)) {
      for (const name of readdirSync(diaryDir).filter((name) => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(name))) {
        const day = name.slice(6, 16)
        for (const [i, line] of readFileSync(join(diaryDir, name), 'utf8').split('\n').entries()) {
          const match = line.match(/^- (\d{2}:\d{2}) ［[^］]*］\s*(.*)$/)
          if (!match?.[2]) continue
          const at = new Date(`${day}T${match[1]}:00`).getTime()
          add({ category: 'subjective', text: match[2], source: { type: 'diary', ref: `${name}#${i}` },
            occurredAt: Number.isFinite(at) ? at : null, certainty: 'subjective', meta: { legacy: true } })
        }
      }
    }

    const memory = readLegacyJson(join(dir, 'memory.json'), { entries: [] })
    const memoryEntries = Array.isArray(memory) ? memory : memory?.entries
    for (const [i, item] of (Array.isArray(memoryEntries) ? memoryEntries : []).entries()) {
      add({ category: 'claim', text: item.text, source: { type: 'memory', ref: String(item.id || i) },
        occurredAt: Number.isFinite(item.at) ? item.at : null, certainty: 'unverified', meta: { legacy: true } })
    }

    const history = readLegacyJson(join(dir, 'history.json'), { messages: [] })
    const historyMessages = Array.isArray(history) ? history : history?.messages
    for (const [i, item] of (Array.isArray(historyMessages) ? historyMessages : []).entries()) {
      if (!['user', 'assistant'].includes(item.role)) continue
      add({ category: 'experience', text: `${item.role === 'user' ? '他' : '我'}：${item.content || ''}`,
        source: { type: 'history', ref: `history.json#${i}` }, occurredAt: null,
        certainty: 'legacy-undated', meta: { legacy: true } })
    }

    const ragDir = join(dir, 'rag')
    const ragRows = [
      ...readJsonLines(join(ragDir, 'chunks.jsonl')),
      ...readJsonLines(join(ragDir, 'pending.jsonl'))
    ]
    const dead = new Set(ragRows.filter((row) => row.tombstone && row.id).map((row) => row.id))
    for (const chunk of ragRows) {
      if (!chunk?.id || !chunk.text || dead.has(chunk.id)) continue
      const category = chunk.kind === 'fact' ? 'claim' : ['diary', 'summary'].includes(chunk.kind) ? 'subjective' : 'experience'
      add({ category, text: chunk.text, source: { type: 'rag', ref: chunk.id },
        occurredAt: chunk.at, certainty: category === 'claim' ? 'unverified' : category === 'subjective' ? 'subjective' : 'legacy-record',
        ragIds: [chunk.id], meta: { ragKind: chunk.kind, legacy: true } })
    }

    const relation = readLegacyJson(join(dir, 'relation.json'), null)
    if (relation && typeof relation.interactionCount === 'number') {
      add({ category: 'aggregate', text: `旧版关系统计：互动 ${relation.interactionCount} 次。`,
        source: { type: 'relation', ref: 'relation.json#migration-v1' }, occurredAt: null,
        certainty: 'aggregate', meta: { firstMetAt: relation.firstMetAt || null, legacy: true } })
    }

    const timelineDir = join(dir, 'timeline')
    if (existsSync(timelineDir)) {
      for (const name of readdirSync(timelineDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
        const data = readLegacyJson(join(timelineDir, name), { points: [] })
        for (const [i, point] of (Array.isArray(data?.points) ? data.points : []).entries()) {
          if (!point?.mood) continue
          add({ category: 'subjective', text: `凪当时的情绪采样：${point.mood}`,
            source: { type: 'timeline', ref: `${name}#${i}` }, occurredAt: point.t,
            certainty: 'system-estimate', meta: { intensity: point.i, legacy: true } })
        }
      }
    }

    atomicWrite(this.markerFile, JSON.stringify({ version: MIGRATION_VERSION, completedAt: Date.now() }))
    return { migrated: true, count }
  }
}
