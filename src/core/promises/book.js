import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATES = new Set(['scheduled', 'attempting', 'attempted', 'delivered', 'completed', 'failed', 'missed', 'cancelled', 'legacy-unknown'])
const COMPLETION_EVIDENCE = new Set(['user-confirmation', 'file-write-result', 'verified-result'])
/** 终态：这些状态的记录只留最小履约记录，不再承载正文 */
const FINISHED = new Set(['completed', 'delivered', 'failed', 'cancelled', 'missed'])

/**
 * 证据降级：只保留 kind 与 at（§11.4「保留 … 证据类别」）。
 * detail / path / bytes / tool 这些能复原正文或工具参数的字段一律丢弃。
 */
export function minimalEvidence(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.kind === 'string')
    .map((e) => ({ kind: e.kind, at: Number.isFinite(e.at) ? e.at : null }))
}

/**
 * 来源关联状态（§11.4「旧记录没有来源 ID 时不能猜测关联，验收标『关联未知』」）。
 * - linked  ：有可核验 sourceIds，遗忘时可按 ID 精确判定
 * - unknown ：旧数据，没有来源 ID，**不得**靠正文相似度猜测
 * - detached：sourceIds 指向的经历已被遗忘，且用户选择保留这条提醒
 */
function linkStatusOf(item) {
  if (item?.detachedAt) return 'detached'
  if (Array.isArray(item?.sourceIds) && item.sourceIds.length) return 'linked'
  return 'unknown'
}

/**
 * 进入人格回忆 / 关系锚点 / 模型上下文前的过滤 + 重验（§11.4）。
 *
 * 两条都排除：
 *  - 自身已被降级（无正文）或被脱钩（来源已遗忘但用户保留提醒）；
 *  - `sourceIds` 里**精确命中**已遗忘账本条目——"引用前重验该来源仍可用"。
 *    只有 linkStatus==='unknown' 的旧记录才会保留，它们本身不含可核验来源，
 *    届时由提醒管理界面提示用户自行检查（不得按正文相似度猜，因此这里也不猜）。
 *
 * @param {Array} items PromiseBook.list()
 * @param {{forgottenIds?:Iterable<string>}} [opts] 已遗忘的账本 ID
 */
export function selectForContext(items, { forgottenIds } = {}) {
  const forgotten = new Set(forgottenIds || [])
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item?.id || !item.title) return false
    if (item.detachedAt || item.redactedAt) return false
    return !(item.sourceIds || []).some((id) => forgotten.has(id))
  })
}

/** 投池前的统一归一化：补 sourceIds / linkStatus，保证下游只读不猜 */
function normalize(raw) {
  const item = { ...raw }
  const ids = Array.isArray(item.sourceIds)
    ? [...new Set(item.sourceIds.filter((s) => typeof s === 'string' && s))]
    : []
  item.sourceIds = ids
  item.linkStatus = linkStatusOf(item)
  return item
}

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
          this.entries.set(item.id, normalize(item))
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

  create({ id = 'p_' + randomUUID(), kind, title, source, sourceIds = [], dueAt = null, status = 'scheduled', at = Date.now() }) {
    this.load()
    if (this.entries.has(id)) return this.get(id)
    if (!STATES.has(status) || !title || !source?.type) throw new Error('承诺信息不完整')
    // §11.4：新建承诺必须记可核验来源 ID，将来遗忘时按 ID 判定，不靠正文猜。
    const links = [...new Set((Array.isArray(sourceIds) ? sourceIds : [])
      .map((s) => String(s || '')).filter(Boolean))]
    const item = normalize({ id, kind, title: String(title), source, sourceIds: links, dueAt, status,
      createdAt: at, updatedAt: at, evidence: [] })
    this.entries.set(id, item)
    try { this.persist() } catch (err) { this.entries.delete(id); throw err }
    return this.get(id)
  }

  /**
   * 最小履约记录（§11.4）：仅保留 ID / 类型 / 状态 / 时间 / 证据类别，
   * 正文与能复原正文的证据字段全部清除。不改变去重用的身份，也不汇报状态以外的语义。
   */
  redact(id, at = Date.now()) {
    this.load()
    const before = this.entries.get(String(id || ''))
    if (!before) throw new Error('找不到这条承诺')
    const next = normalize({
      id: before.id, kind: before.kind, title: '', source: { type: before.source?.type || 'unknown' },
      sourceIds: before.sourceIds || [], dueAt: before.dueAt ?? null, status: before.status,
      createdAt: before.createdAt, updatedAt: at, evidence: minimalEvidence(before.evidence),
      redactedAt: at
    })
    this.entries.set(before.id, next)
    try { this.persist() } catch (err) { this.entries.set(before.id, before); throw err }
    return this.get(before.id)
  }

  /** 删除已结束记录（§11.4）：只删本地记录，**不重放**外部操作。仍在执行的走取消流程。 */
  remove(id) {
    this.load()
    const before = this.entries.get(String(id || ''))
    if (!before) return { ok: false, error: '找不到这条承诺' }
    if (!FINISHED.has(before.status)) return { ok: false, error: '仍在执行或待交付的承诺请走取消流程' }
    this.entries.delete(before.id)
    try { this.persist() } catch (err) { this.entries.set(before.id, before); throw err }
    return { ok: true, id: before.id }
  }

  /** 标记来源已被遗忘（用户选择保留提醒）：脱钩后不进人格回忆/锚点/上下文。 */
  detach(id, at = Date.now()) {
    this.load()
    const before = this.entries.get(String(id || ''))
    if (!before) throw new Error('找不到这条承诺')
    if (before.detachedAt) return this.get(before.id)
    const next = normalize({ ...before, detachedAt: at, updatedAt: at })
    this.entries.set(before.id, next)
    try { this.persist() } catch (err) { this.entries.set(before.id, before); throw err }
    return this.get(before.id)
  }

  /**
   * 按**可核验来源 ID** 精确查找关联承诺。
   * 刻意不做正文相似度匹配——§11.4 禁止"猜测来源后静默删除"。
   */
  bySourceId(sourceId) {
    this.load()
    const needle = String(sourceId || '')
    if (!needle) return []
    return [...this.entries.values()]
      .filter((item) => (item.sourceIds || []).includes(needle))
      .map((item) => this.get(item.id))
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
