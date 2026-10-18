// 统一经历账本：正常新增顺序追加，纠错/删除时重写当前态以移除旧正文。
// 不依赖 Electron；存储端口（追加/重写）与迁移源（只读）由主进程注入。
//
// B7（P2-05）：本文件不再引用 node:fs，也不读全局时钟或全局随机——
//   写盘走行式端口（recIo）、迁移走只读源（legacy）、「此刻」与 id 走 now()/rng()。
//   createHash 保留：它是确定性摘要（同一来源永远得同一 id），属纯计算，不是随机。
import { createHash } from 'node:crypto' /* B7:allow:directCrypto — 确定性摘要（同来源永远同 id），属纯计算不是随机 */
import { assertPorts } from '../store/document-io.js'
import { isRecordIo } from '../store/record-io.js'
import { isLegacyReader } from '../store/legacy-reader.js'

const CATEGORIES = new Set(['experience', 'claim', 'subjective', 'aggregate'])
const MIGRATION_VERSION = 1

/** 端口文档键；真实路径由 main 侧登记（ledger/entries.jsonl、ledger/migration.json） */
export const LEDGER_ENTRIES_KEY = 'entries'
export const LEDGER_MIGRATION_KEY = 'migration'

export function trustTier(entry) {
  if (entry?.category === 'subjective') return 'subjective'
  if (entry?.category === 'claim' && !['user-stated', 'user-corrected'].includes(entry.certainty)) return 'unverified'
  return 'recorded'
}

function sourceId(type, ref) {
  return 'e_' + createHash('sha256').update(`${type}:${ref}`).digest('hex').slice(0, 20)
}

/** 迁移源读 JSON：不存在 → fallback；存在但坏 → 如实抛出（B8：不许悄悄标记迁移完成） */
function readLegacyJson(reader, ref, fallback) {
  const raw = reader.read(ref)
  if (raw === null || raw === undefined) return fallback
  return JSON.parse(raw)
}

function valid(record) {
  return record && typeof record.id === 'string' &&
    CATEGORIES.has(record.category) && typeof record.text === 'string' &&
    record.source && typeof record.source.type === 'string' && typeof record.source.ref === 'string'
}

export class ExperienceLedger {
  constructor({ recIo, legacy, now, rng } = {}) {
    assertPorts('ExperienceLedger', { now, rng }, ['now', 'rng'])
    if (!isRecordIo(recIo)) throw new TypeError('ExperienceLedger 缺少注入依赖：recIo（行式存储端口）')
    if (!isLegacyReader(legacy)) throw new TypeError('ExperienceLedger 缺少注入依赖：legacy（迁移源只读端口）')
    this.recIo = recIo
    this.legacy = legacy
    this.now = now
    this.rng = rng
    this.entries = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    for (const row of this.recIo.readObjects(LEDGER_ENTRIES_KEY)) if (valid(row)) this.entries.set(row.id, row)
    this.loaded = true
    return this
  }

  list({ includeDeleted = false } = {}) {
    this.load()
    return [...this.entries.values()]
      .filter((entry) => includeDeleted || !entry.deletedAt)
      .sort((a, b) => (b.occurredAt || b.recordedAt) - (a.occurredAt || a.recordedAt))
      .map((entry) => ({ ...structuredClone(entry), tier: trustTier(entry) }))
  }

  get(id) {
    this.load()
    const entry = this.entries.get(String(id || ''))
    return entry ? { ...structuredClone(entry), tier: trustTier(entry) } : null
  }

  bySource(type, ref) {
    return this.get(sourceId(String(type), String(ref)))
  }

  deleteBySource(type, ref, at = this.now()) {
    this.load()
    const id = sourceId(type, String(ref))
    const entry = this.entries.get(id)
    if (!entry || entry.deletedAt) return false
    const updated = { ...entry, text: '', meta: {}, revision: entry.revision + 1, deletedAt: at }
    this.recIo.rewrite(LEDGER_ENTRIES_KEY, [...this.entries.values()].map((row) => (row.id === id ? updated : row)))
    this.entries.set(id, updated)
    return true
  }

  forget(id, at = this.now()) {
    this.load()
    const entry = this.entries.get(String(id || ''))
    return entry ? this.deleteBySource(entry.source.type, entry.source.ref, at) : false
  }

  correct(id, text, at = this.now(), ragIds = []) {
    this.load()
    const original = this.entries.get(String(id || ''))
    const body = String(text || '').trim()
    if (!original || original.deletedAt || !body) return null
    const source = { type: 'correction', ref: String(this.rng()) }
    const corrected = {
      id: sourceId(source.type, source.ref), category: original.category, text: body,
      source, occurredAt: null, recordedAt: at, certainty: 'user-corrected',
      ragIds: [...new Set(ragIds.filter(Boolean))], meta: { corrects: original.id, actor: 'user' },
      revision: 1, correctedAt: at, deletedAt: null
    }
    const old = { ...original, text: '', meta: { correctedBy: corrected.id },
      revision: original.revision + 1, correctedAt: at, deletedAt: at }
    const rows = [...this.entries.values()].map((row) => (row.id === original.id ? old : row))
    rows.push(corrected)
    this.recIo.rewrite(LEDGER_ENTRIES_KEY, rows)
    this.entries.set(original.id, old)
    this.entries.set(corrected.id, corrected)
    return this.get(corrected.id)
  }

  exportBundle() {
    return {
      schemaVersion: 1, exportedAt: this.now(),
      trustTiers: { recorded: '有来源的实际记录或用户确认', unverified: '未经用户核实的模型整理', subjective: '凪的日记、情绪或创作' },
      entries: this.list({ includeDeleted: true })
    }
  }

  record({ category, text, source, occurredAt = null, recordedAt = this.now(), certainty = 'observed', ragIds = [], meta = {} }) {
    this.load()
    const body = String(text || '').trim()
    if (!CATEGORIES.has(category) || !body || !source?.type) return null
    const ref = String(source.ref || this.rng())
    const id = sourceId(source.type, ref)
    if (this.entries.has(id)) return this.get(id)
    const entry = {
      id, category, text: body,
      source: { type: String(source.type), ref },
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
      recordedAt: Number.isFinite(recordedAt) ? recordedAt : this.now(),
      certainty, ragIds: [...new Set(ragIds.filter(Boolean).map(String))],
      meta: meta && typeof meta === 'object' ? meta : {},
      revision: 1, correctedAt: null, deletedAt: null
    }
    this.recIo.append(LEDGER_ENTRIES_KEY, entry)
    this.entries.set(id, entry)
    return structuredClone(entry)
  }

  /** 一次性迁移旧文件；保留原件，不根据无时间戳的历史猜测发生时间。 */
  migrateLegacy() {
    this.load()
    const marker = this.recIo.readObjects(LEDGER_MIGRATION_KEY)[0] || { version: 0 }
    if (Number(marker.version) >= MIGRATION_VERSION) return { migrated: false, count: 0 }
    let count = 0
    const add = (fields) => {
      if (!fields.text || this.entries.has(sourceId(fields.source.type, fields.source.ref))) return
      if (this.record(fields)) count++
    }
    const read = this.legacy

    if (read.exists('journal')) {
      for (const name of read.list('journal').filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
        const data = readLegacyJson(read, `journal/${name}`, { entries: [] })
        for (const [i, event] of (Array.isArray(data.entries) ? data.entries : []).entries()) {
          const text = event.kind === 'chat'
            ? [event.user && `他：${event.user}`, event.reply && `我：${event.reply}`].filter(Boolean).join('\n')
            : event.text || (event.kind === 'poke' ? '用户戳了凪' : '')
          add({ category: 'experience', text, source: { type: 'journal', ref: `${name}#${i}` },
            occurredAt: event.t, certainty: 'legacy-record', meta: { eventKind: event.kind } })
        }
      }
    }

    if (read.exists('monologue')) {
      for (const name of read.list('monologue').filter((name) => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(name))) {
        const day = name.slice(6, 16)
        for (const [i, line] of String(read.read(`monologue/${name}`) ?? '').split('\n').entries()) {
          const match = line.match(/^- (\d{2}:\d{2}) ［[^］]*］\s*(.*)$/)
          if (!match?.[2]) continue
          const at = new Date(`${day}T${match[1]}:00`).getTime()
          add({ category: 'subjective', text: match[2], source: { type: 'diary', ref: `${name}#${i}` },
            occurredAt: Number.isFinite(at) ? at : null, certainty: 'subjective', meta: { legacy: true } })
        }
      }
    }

    const memory = readLegacyJson(read, 'memory.json', { entries: [] })
    const memoryEntries = Array.isArray(memory) ? memory : memory?.entries
    for (const [i, item] of (Array.isArray(memoryEntries) ? memoryEntries : []).entries()) {
      add({ category: 'claim', text: item.text, source: { type: 'memory', ref: String(item.id || i) },
        occurredAt: Number.isFinite(item.at) ? item.at : null, certainty: 'unverified', meta: { legacy: true } })
    }

    const history = readLegacyJson(read, 'history.json', { messages: [] })
    const historyMessages = Array.isArray(history) ? history : history?.messages
    for (const [i, item] of (Array.isArray(historyMessages) ? historyMessages : []).entries()) {
      if (!['user', 'assistant'].includes(item.role)) continue
      add({ category: 'experience', text: `${item.role === 'user' ? '他' : '我'}：${item.content || ''}`,
        source: { type: 'history', ref: `history.json#${i}` }, occurredAt: null,
        certainty: 'legacy-undated', meta: { legacy: true } })
    }

    const ragRows = [
      ...read.readObjects('rag/chunks.jsonl'),
      ...read.readObjects('rag/pending.jsonl')
    ]
    const dead = new Set(ragRows.filter((row) => row.tombstone && row.id).map((row) => row.id))
    for (const chunk of ragRows) {
      if (!chunk?.id || !chunk.text || dead.has(chunk.id)) continue
      const category = chunk.kind === 'fact' ? 'claim' : ['diary', 'summary'].includes(chunk.kind) ? 'subjective' : 'experience'
      add({ category, text: chunk.text, source: { type: 'rag', ref: chunk.id },
        occurredAt: chunk.at, certainty: category === 'claim' ? 'unverified' : category === 'subjective' ? 'subjective' : 'legacy-record',
        ragIds: [chunk.id], meta: { ragKind: chunk.kind, legacy: true } })
    }

    const relation = readLegacyJson(read, 'relation.json', null)
    if (relation && typeof relation.interactionCount === 'number') {
      add({ category: 'aggregate', text: `旧版关系统计：互动 ${relation.interactionCount} 次。`,
        source: { type: 'relation', ref: 'relation.json#migration-v1' }, occurredAt: null,
        certainty: 'aggregate', meta: { firstMetAt: relation.firstMetAt || null, legacy: true } })
    }

    if (read.exists('timeline')) {
      for (const name of read.list('timeline').filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
        const data = readLegacyJson(read, `timeline/${name}`, { points: [] })
        for (const [i, point] of (Array.isArray(data?.points) ? data.points : []).entries()) {
          if (!point?.mood) continue
          add({ category: 'subjective', text: `凪当时的情绪采样：${point.mood}`,
            source: { type: 'timeline', ref: `${name}#${i}` }, occurredAt: point.t,
            certainty: 'system-estimate', meta: { intensity: point.i, legacy: true } })
        }
      }
    }

    this.recIo.rewrite(LEDGER_MIGRATION_KEY, [{ version: MIGRATION_VERSION, completedAt: this.now() }])
    return { migrated: true, count }
  }
}
