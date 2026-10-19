// src/core/export/build.js
// C5 统一记忆/数据导出（P3-08，CONTRACTS §15）——**只做组装与标注，不碰 fs / 不读时钟**。
//
// 契约（§15.1，逐条对应实现）：
//   · 只由用户明确发起、选择本地目标后导出——发起与目标选择在 main 侧（export.js），
//     本模块只回答「导出内容长什么样」；
//   · 每条保留来源 ID、来源类型、信任层（用户确认 / 有来源观测 / 主观 / 模拟 / 未核实）、
//     发生/记录时间与更正状态——**逐条标注**，不是文件顶部一句笼统声明；
//   · 已遗忘内容只允许输出无正文的删除标记（ID + deletedAt + status:deleted），
//     不能从流水、日记、年鉴或便签重新带出正文——本模块对派生层做**逐条复核**：
//       ① 流水：按（occurredAt, eventKind）坐标对已删账本条目（遗忘链正是按这个坐标删条的）；
//       ② 日记 / 便签 / 年鉴用户文字：对已删账本条目的**正文做精确包含判断**——
//          这不是「按正文相似度猜测关联」（§11.4 禁的是那个），而是同一段已删正文
//          不得换个位置复活；猜测关联仍然禁止，所以承诺簿**不做**正文扫描，
//          旧记录一律标 linkStatus:'unknown' 交由用户自行核对；
//   · 主观 / 模拟逐条标注，不把模拟说成共同经历；
//   · 导出不是把所有条目拼成一段「共同回忆」——分节分条，各带各的来源。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

import { requireNow } from '../clock.js'

export const EXPORT_SCHEMA_VERSION = 1

/** 信任层（契约 §15.1 五层） */
export const TRUST_LAYERS = {
  USER_CONFIRMED: 'user-confirmed', // 用户确认
  OBSERVED: 'observed',             // 有来源观测
  SUBJECTIVE: 'subjective',         // 主观
  SIMULATED: 'simulated',           // 模拟
  UNVERIFIED: 'unverified'          // 未核实
}

export const TRUST_LABELS = {
  'user-confirmed': '用户确认',
  'observed': '有来源观测',
  'subjective': '主观',
  'simulated': '模拟',
  'unverified': '未核实'
}

/** 条目状态：live 正常 / corrected 已被更正（保留原文与更正时间，供审计）/ deleted 已遗忘（只留标记） */
export const ITEM_STATUS = {
  LIVE: 'live',
  CORRECTED: 'corrected',
  DELETED: 'deleted'
}

/**
 * 导出文件里固定写给用户看的一段话。
 * 重点说清两件事：旧外部副本应用碰不到；目标已存在时导出会失败而不是覆盖。
 */
export const EXPORT_NOTICE = [
  '本文件由你本人发起的一次性导出生成。',
  '已遗忘的内容只保留删除标记（ID 与删除时间），不含正文。',
  '主观记录、模拟状态与创作设定逐条标注，不代表共同经历。',
  '应用不会删除、修改或上传你已经导出的外部副本；若目标文件已存在，本次导出会失败而不是覆盖它。'
].join('')

/* ---------------- 信任层映射 ---------------- */

/** 账本条目 → 信任层（与 core/ledger/store.js 的 trustTier 同源，但导出需要更细的「用户确认」档） */
export function ledgerTrustLayer(entry) {
  if (entry?.category === 'subjective') return TRUST_LAYERS.SUBJECTIVE
  const certainty = entry?.certainty
  if (certainty === 'user-stated' || certainty === 'user-corrected') return TRUST_LAYERS.USER_CONFIRMED
  if (certainty === 'observed') return TRUST_LAYERS.OBSERVED
  return TRUST_LAYERS.UNVERIFIED
}

/** memory.json 条目 → 信任层（用户手动记下 vs 模型抽取的未核实摘录） */
export function memoryTrustLayer(entry) {
  return entry?.provenance === 'user-stated' ? TRUST_LAYERS.USER_CONFIRMED : TRUST_LAYERS.UNVERIFIED
}

/* ---------------- 删除标记 ---------------- */

/**
 * 已删条目的导出形态：**只有 ID 与删除时间**，没有任何可复原正文的字段。
 * 契约 §15.1：「已遗忘内容只允许输出无正文的删除标记」。
 */
export function deletedMarker({ id, deletedAt = null, sourceType = null, ref = null } = {}) {
  const out = {
    id: String(id ?? ''),
    status: ITEM_STATUS.DELETED,
    deletedAt: Number.isFinite(deletedAt) ? deletedAt : null
  }
  if (sourceType) out.sourceType = sourceType
  if (ref) out.ref = ref
  return out
}

/* ---------------- 账本 ---------------- */

export function exportLedgerItem(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null
  if (entry.deletedAt) {
    return deletedMarker({ id: entry.id, deletedAt: entry.deletedAt, sourceType: 'ledger' })
  }
  return {
    id: entry.id,
    status: entry.correctedAt ? ITEM_STATUS.CORRECTED : ITEM_STATUS.LIVE,
    trustLayer: ledgerTrustLayer(entry),
    sourceType: 'ledger',
    source: {
      type: entry.source?.type ?? null,
      ref: entry.source?.ref ?? null
    },
    category: entry.category ?? null,
    occurredAt: Number.isFinite(entry.occurredAt) ? entry.occurredAt : null,
    recordedAt: Number.isFinite(entry.recordedAt) ? entry.recordedAt : null,
    correctedAt: Number.isFinite(entry.correctedAt) ? entry.correctedAt : null,
    text: typeof entry.text === 'string' ? entry.text : null
  }
}

/* ---------------- 记忆（memory.json） ---------------- */

export function exportMemoryItem(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null
  return {
    id: entry.id,
    status: ITEM_STATUS.LIVE,
    trustLayer: memoryTrustLayer(entry),
    sourceType: 'memory',
    recordedAt: Number.isFinite(entry.at) ? entry.at : null,
    text: typeof entry.text === 'string' ? entry.text : null
  }
}

/* ---------------- 流水（journal/YYYY-MM-DD.json） ---------------- */

/**
 * 已删账本条目里的「流水事件」坐标。遗忘链（main/journal.js removeJournalEntry）
 * 正是按 occurredAt + eventKind 定位并删条的；导出用同一坐标做第二道防线——
 * 磁盘上万一还留着（清理失败被 B8 放过、或旧版本残留），也不许带出正文。
 */
export function deadJournalEvents(ledgerEntries) {
  const out = []
  for (const entry of Array.isArray(ledgerEntries) ? ledgerEntries : []) {
    if (!entry?.deletedAt) continue
    if (!String(entry.source?.type || '').startsWith('journal')) continue
    out.push({
      occurredAt: entry.occurredAt,
      eventKind: entry.meta?.eventKind ?? null,
      ledgerId: entry.id
    })
  }
  return out
}

export function exportJournalDay(date, entries, deadEvents = []) {
  const items = []
  const list = Array.isArray(entries) ? entries : []
  for (let index = 0; index < list.length; index++) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object') continue
    const id = `journal:${date}#${index}`
    const dead = deadEvents.find((d) =>
      d.occurredAt === entry.t && (d.eventKind == null || d.eventKind === entry.kind))
    if (dead) {
      items.push({ ...deletedMarker({ id, sourceType: 'journal' }), ref: dead.ledgerId })
      continue
    }
    items.push({
      id,
      status: ITEM_STATUS.LIVE,
      // 流水是当天真实发生过的事件的记录（他说的 / 她回的 / 她主动开口），
      // 不是她的主观感受——信任层取「有来源观测」。
      trustLayer: TRUST_LAYERS.OBSERVED,
      sourceType: 'journal',
      at: Number.isFinite(entry.t) ? entry.t : null,
      kind: entry.kind ?? null,
      text: typeof entry.text === 'string' ? entry.text : null,
      user: typeof entry.user === 'string' ? entry.user : null,
      reply: typeof entry.reply === 'string' ? entry.reply : null
    })
  }
  return { date: String(date ?? ''), items }
}

/* ---------------- 日记（monologue/diary-YYYY-MM-DD.md） ---------------- */

/**
 * 日记一行 → 导出条目。行里**精确包含**某条已删账本正文时，只留删除标记。
 * （removeDiaryEntry 正是按「行以已删正文结尾」删行的；这里防它没删干净。）
 */
export function exportDiaryLine(line, { id, deletedTexts = [] } = {}) {
  const text = String(line ?? '')
  const dead = deletedTexts.some((needle) => needle && text.includes(needle))
  if (dead) return { ...deletedMarker({ id, sourceType: 'diary' }) }
  return {
    id,
    status: ITEM_STATUS.LIVE,
    trustLayer: TRUST_LAYERS.SUBJECTIVE,
    sourceType: 'diary',
    text
  }
}

export function exportDiaryFile(file, text, deletedTexts = []) {
  const items = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue
    items.push(exportDiaryLine(lines[index], { id: `diary:${file}#${index}`, deletedTexts }))
  }
  return { file: String(file ?? ''), items }
}

/* ---------------- 便签 / 行动痕迹 / 关系锚点 ---------------- */

/** 便签 → 导出条目。模拟活动标「模拟」，其余是她的主观记录；含已删正文的只留标记。 */
export function exportNoteItem(note, deletedTexts = []) {
  if (!note || typeof note !== 'object' || typeof note.id !== 'string') return null
  const text = typeof note.text === 'string' ? note.text : ''
  if (deletedTexts.some((needle) => needle && text.includes(needle))) {
    return deletedMarker({ id: note.id, sourceType: 'note' })
  }
  return {
    id: note.id,
    status: ITEM_STATUS.LIVE,
    trustLayer: note.provenance === 'simulation' ? TRUST_LAYERS.SIMULATED : TRUST_LAYERS.SUBJECTIVE,
    sourceType: 'note',
    at: Number.isFinite(note.at) ? note.at : null,
    noteKind: note.noteKind ?? null,
    provenance: note.provenance ?? null,
    text
  }
}

/** 行动痕迹（工具跑过什么的记录）→ 导出条目。summary 也可能带出已删正文，同样逐条复核。 */
export function exportTraceItem(trace, deletedTexts = []) {
  if (!trace || typeof trace !== 'object' || typeof trace.id !== 'string') return null
  const summary = typeof trace.summary === 'string' ? trace.summary : ''
  if (deletedTexts.some((needle) => needle && summary.includes(needle))) {
    return deletedMarker({ id: trace.id, sourceType: 'trace' })
  }
  return {
    id: trace.id,
    status: ITEM_STATUS.LIVE,
    trustLayer: TRUST_LAYERS.OBSERVED,
    sourceType: 'trace',
    at: Number.isFinite(trace.at) ? trace.at : null,
    tool: trace.tool ?? null,
    status_: trace.status ?? null,
    summary
  }
}

/** 关系锚点 → 导出条目。锚点标题可能来自承诺标题，同样逐条复核。 */
export function exportAnchorItem(anchor, deletedTexts = []) {
  if (!anchor || typeof anchor !== 'object' || typeof anchor.id !== 'string') return null
  const text = typeof anchor.text === 'string' ? anchor.text
    : typeof anchor.title === 'string' ? anchor.title : ''
  if (deletedTexts.some((needle) => needle && text.includes(needle))) {
    return deletedMarker({ id: anchor.id, sourceType: 'anchor' })
  }
  return {
    id: anchor.id,
    status: ITEM_STATUS.LIVE,
    trustLayer: TRUST_LAYERS.SUBJECTIVE,
    sourceType: 'anchor',
    kind: anchor.kind ?? null,
    occurredAt: Number.isFinite(anchor.occurredAt) ? anchor.occurredAt : null,
    sourceIds: Array.isArray(anchor.sourceIds) ? [...anchor.sourceIds] : [],
    text
  }
}

/* ---------------- 承诺簿 ---------------- */

/**
 * 承诺 → 导出条目。
 * §11.4 边界：**不按正文相似度猜测关联**，所以这里不做正文扫描；
 * linkStatus 如实带出（linked / detached / unknown），旧记录标 unknown 交由用户自行核对。
 * 已降级为最小履约记录的（redactedAt）不带标题——存储侧已经清掉了。
 */
export function exportPromiseItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null
  const out = {
    id: item.id,
    kind: item.kind ?? null,
    status: item.status ?? null,
    linkStatus: item.linkStatus ?? null,
    // 承诺是用户自己设下的事，不是观测也不是她的主观感受
    trustLayer: TRUST_LAYERS.USER_CONFIRMED,
    sourceType: 'promise',
    dueAt: Number.isFinite(item.dueAt) ? item.dueAt : null,
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : null,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
    source: item.source && typeof item.source === 'object'
      ? { type: item.source.type ?? null, id: item.source.id ?? null }
      : null,
    sourceIds: Array.isArray(item.sourceIds) ? [...item.sourceIds] : []
  }
  if (item.redactedAt) {
    out.redacted = true
    out.redactedAt = Number.isFinite(item.redactedAt) ? item.redactedAt : null
  }
  if (item.detachedAt) {
    // 来源经历已遗忘、用户选择保留这条提醒：标题是用户自己的话，照实导出，
    // 但带上脱钩时间，读者知道它与已忘经历有关。
    out.detachedAt = Number.isFinite(item.detachedAt) ? item.detachedAt : null
  }
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  out.title = title || null
  // 证据只保留 kind 与 at（§11.4 最小履约记录；detail/path 等能复原正文的字段存储侧已丢弃）
  if (Array.isArray(item.evidence)) {
    out.evidence = item.evidence
      .filter((e) => e && typeof e.kind === 'string')
      .map((e) => ({ kind: e.kind, at: Number.isFinite(e.at) ? e.at : null }))
  }
  return out
}

/* ---------------- 年鉴 ---------------- */

/**
 * 年鉴一页 → 导出条目。事实部分跟随其账本来源的信任层；
 * 她的主观记录逐条标 subjective；用户编辑的文字是创作，不是共同经历。
 * 来源已被遗忘时（正常已被 pruneSource 删掉，这里是第二道防线）事实只留标记。
 */
export function exportYearbookPage(page, { deletedIds = new Set() } = {}) {
  if (!page || typeof page !== 'object' || typeof page.id !== 'string') return null
  const factDeleted = page.sourceId != null && deletedIds.has(page.sourceId)
  const fact = page.fact && typeof page.fact === 'object' ? page.fact : null
  const out = {
    id: page.id,
    sourceType: 'yearbook',
    sourceId: page.sourceId ?? null,
    title: typeof page.title === 'string' ? page.title : null,
    createdAt: Number.isFinite(page.createdAt) ? page.createdAt : null,
    updatedAt: Number.isFinite(page.updatedAt) ? page.updatedAt : null,
    fact: factDeleted
      ? { id: page.sourceId, status: ITEM_STATUS.DELETED, sourceType: 'ledger' }
      : {
        id: fact?.id ?? page.sourceId ?? null,
        status: ITEM_STATUS.LIVE,
        trustLayer: ledgerTrustLayer(fact || {}),
        sourceType: 'ledger',
        source: fact?.source ? { type: fact.source.type ?? null, ref: fact.source.ref ?? null } : null,
        occurredAt: Number.isFinite(fact?.occurredAt) ? fact.occurredAt : null,
        recordedAt: Number.isFinite(fact?.recordedAt) ? fact.recordedAt : null,
        text: typeof fact?.text === 'string' ? fact.text : null
      },
    subjective: (Array.isArray(page.subjective) ? page.subjective : [])
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => ({
        id: s.id,
        status: ITEM_STATUS.LIVE,
        trustLayer: TRUST_LAYERS.SUBJECTIVE,
        sourceType: 'ledger',
        recordedAt: Number.isFinite(s.recordedAt) ? s.recordedAt : null,
        text: typeof s.text === 'string' ? s.text : null
      }))
  }
  const note = typeof page.note === 'string' ? page.note.trim() : ''
  out.userNote = note
    ? { kind: 'user-creation', trustLayer: TRUST_LAYERS.SUBJECTIVE, text: note }
    : null
  return out
}

/** 身世碎片：出厂创作设定，永远不是共同经历 */
export function exportYearbookFragment(fragment) {
  if (!fragment || typeof fragment !== 'object' || typeof fragment.id !== 'string') return null
  return {
    id: fragment.id,
    title: typeof fragment.title === 'string' ? fragment.title : null,
    kind: 'creative-setting',
    trustLayer: TRUST_LAYERS.SUBJECTIVE,
    sourceType: 'yearbook',
    triggerSourceId: fragment.triggerSourceId ?? null,
    text: typeof fragment.text === 'string' ? fragment.text : null
  }
}

/* ---------------- 对话历史 ---------------- */

export function exportHistoryItem(message) {
  if (!message || typeof message !== 'object') return null
  const role = message.role === 'user' || message.role === 'assistant' ? message.role : null
  if (!role || typeof message.content !== 'string') return null
  return {
    role,
    // 用户自己说的话 = 用户确认；她的回复是当天对话的记录 = 有来源观测
    trustLayer: role === 'user' ? TRUST_LAYERS.USER_CONFIRMED : TRUST_LAYERS.OBSERVED,
    sourceType: 'history',
    at: Number.isFinite(message.at) ? message.at : null,
    content: message.content
  }
}

/* ---------------- 总装 ---------------- */

/**
 * 组装导出包。入参都是**普通数据**（main 侧已从各 store 取好），本函数不碰任何 IO。
 *
 * @param {object} sources
 *   ledger   账本条目数组（**含已删**，includeDeleted:true——删除标记要从这里来）
 *   memory   memory.json 条目数组
 *   journal  [{date, entries}]
 *   diary    [{file, text}]
 *   yearbook {pages, fragments}（getYearbook().list() 的形状）
 *   notes    listNotes() 的形状（{notes, traces, anchors}）
 *   promises 承诺簿条目数组
 *   history  对话历史数组
 * @param {number} now 导出时间（注入）
 */
export function buildExportBundle(sources = {}, now) {
  const exportedAt = requireNow(now, 'buildExportBundle')
  const ledger = Array.isArray(sources.ledger) ? sources.ledger : []
  const deletedEntries = ledger.filter((e) => e && e.deletedAt)
  const deletedIds = new Set(deletedEntries.map((e) => e.id))
  const deletedTexts = deletedEntries
    .map((e) => (typeof e.text === 'string' ? e.text : ''))
    .filter(Boolean)
  const deadEvents = deadJournalEvents(ledger)

  const ledgerItems = ledger.map(exportLedgerItem).filter(Boolean)
  const memoryItems = (Array.isArray(sources.memory) ? sources.memory : [])
    .map(exportMemoryItem).filter(Boolean)
  const journalDays = (Array.isArray(sources.journal) ? sources.journal : [])
    .map((day) => exportJournalDay(day?.date, day?.entries, deadEvents))
    .filter((day) => day.items.length > 0)
  const diaryFiles = (Array.isArray(sources.diary) ? sources.diary : [])
    .map((f) => exportDiaryFile(f?.file, f?.text, deletedTexts))
    .filter((f) => f.items.length > 0)
  const noteItems = (Array.isArray(sources.notes?.notes) ? sources.notes.notes : [])
    .map((n) => exportNoteItem(n, deletedTexts)).filter(Boolean)
  const traceItems = (Array.isArray(sources.notes?.traces) ? sources.notes.traces : [])
    .map((t) => exportTraceItem(t, deletedTexts)).filter(Boolean)
  const anchorItems = (Array.isArray(sources.notes?.anchors) ? sources.notes.anchors : [])
    .map((a) => exportAnchorItem(a, deletedTexts)).filter(Boolean)
  const promiseItems = (Array.isArray(sources.promises) ? sources.promises : [])
    .map(exportPromiseItem).filter(Boolean)
  const yearbookPages = (Array.isArray(sources.yearbook?.pages) ? sources.yearbook.pages : [])
    .map((p) => exportYearbookPage(p, { deletedIds })).filter(Boolean)
  const yearbookFragments = (Array.isArray(sources.yearbook?.fragments) ? sources.yearbook.fragments : [])
    .filter((f) => f && f.unlocked)
    .map(exportYearbookFragment).filter(Boolean)
  const historyItems = (Array.isArray(sources.history) ? sources.history : [])
    .map(exportHistoryItem).filter(Boolean)

  const countDeleted = (items) => items.filter((i) => i && i.status === ITEM_STATUS.DELETED).length

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    generator: 'nagi',
    notice: EXPORT_NOTICE,
    trustLayers: { ...TRUST_LABELS },
    counts: {
      ledger: ledgerItems.length,
      ledgerDeleted: countDeleted(ledgerItems),
      memory: memoryItems.length,
      journal: journalDays.reduce((sum, d) => sum + d.items.length, 0),
      journalDeleted: journalDays.reduce((sum, d) => sum + countDeleted(d.items), 0),
      diary: diaryFiles.reduce((sum, f) => sum + f.items.length, 0),
      diaryDeleted: diaryFiles.reduce((sum, f) => sum + countDeleted(f.items), 0),
      notes: noteItems.length,
      notesDeleted: countDeleted(noteItems),
      traces: traceItems.length,
      tracesDeleted: countDeleted(traceItems),
      anchors: anchorItems.length,
      anchorsDeleted: countDeleted(anchorItems),
      promises: promiseItems.length,
      yearbookPages: yearbookPages.length,
      history: historyItems.length
    },
    sections: {
      ledger: { items: ledgerItems },
      memory: { items: memoryItems },
      journal: { days: journalDays },
      diary: { files: diaryFiles },
      notes: { items: noteItems, traces: traceItems, anchors: anchorItems },
      promises: { items: promiseItems },
      yearbook: { pages: yearbookPages, fragments: yearbookFragments },
      history: { messages: historyItems }
    }
  }
}

/* ---------------- 序列化 ---------------- */

export function serializeExport(bundle) {
  return JSON.stringify(bundle, null, 2) + '\n'
}

/** 重新读取导出文件时用：形状不对就如实抛错，不猜 */
export function parseExport(text) {
  const data = JSON.parse(String(text ?? ''))
  if (!data || typeof data !== 'object' ||
      data.schemaVersion !== EXPORT_SCHEMA_VERSION ||
      !data.sections || typeof data.sections !== 'object') {
    throw new Error('不是可识别的凪数据导出文件')
  }
  return data
}
