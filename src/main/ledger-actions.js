// 用户纠错/忘记的单一入口：先清所有可供提示词和检索读取的旧来源，再改账本状态。
import { getLedger } from './ledger.js'
import { getYearbook } from './yearbook.js'
import { getRag } from './rag/index.js'
import { removeJournalEntry } from './journal.js'
import { removeDiaryEntry } from './diary.js'
import { addMemory, flushPersist, listMemories, loadHistory, purgeHistoryFragments, removeMemory } from './persist.js'

function fragments(entry) {
  const lines = String(entry.text || '').split('\n')
    .map((line) => line.replace(/^(他|我)：/, '').replace(/^（心里）/, '').trim())
    .filter(Boolean)
  return [...new Set([entry.text, ...lines])]
}

function scrub(entry) {
  const rag = getRag()
  if (!rag.ready) throw new Error('记忆检索未就绪，无法确认旧内容已清除')
  const dropped = new Set()
  const ids = [...entry.ragIds]
  if (['rag', 'rag-summary'].includes(entry.source.type)) ids.push(entry.source.ref)
  for (const id of ids) {
    const result = rag.forget(id)
    if (!result.ok && result.error !== '没有这条') throw new Error(result.error)
    dropped.add(id)
    for (const linked of result.cascaded || []) dropped.add(linked)
  }
  const ragNeedles = [entry.text, entry.text.startsWith('他：')
    ? entry.text.split('\n')[0].slice(2) : entry.text.replace(/^（心里）/, '')]
  for (const part of new Set(ragNeedles.filter(Boolean))) {
    const exact = rag.forgetText(part)
    if (exact.ok) {
      dropped.add(exact.id)
      for (const id of exact.cascaded || []) dropped.add(id)
    }
    if (part.length < 6) continue
    const matched = rag.forgetMatching(part, entry.occurredAt,
      entry.category === 'experience' ? 600000 : 86400000)
    if (!matched.ok) throw new Error(matched.error)
    for (const id of matched.ids) dropped.add(id)
  }
  if (entry.source.type.startsWith('journal') && !removeJournalEntry(entry)) throw new Error('流水来源定位失败')
  if (entry.source.type.startsWith('diary') && !removeDiaryEntry(entry)) throw new Error('日记来源定位失败')
  const parts = fragments(entry).filter((part) => part !== entry.text)
  purgeHistoryFragments(parts.length ? parts : [entry.text])
  const memory = listMemories().filter((item) => item.text === entry.text ||
    (entry.source.type.startsWith('memory') && item.id === entry.source.ref))
  for (const item of memory) removeMemory({ id: item.id }, { updateLedger: false })
  loadHistory()
  flushPersist()
  return dropped
}

function forgetDerived(ledger, entry) {
  if (entry.category !== 'experience') return
  for (const child of ledger.list().filter((item) =>
    item.meta?.dependsOn?.includes(entry.id) ||
    (item.category === 'claim' && item.meta?.derivedFromUserText &&
      entry.text.includes(item.meta.derivedFromUserText)))) {
    scrub(child)
    ledger.forget(child.id)
  }
}

function markRagCopies(ledger, dropped, excludeId) {
  for (const entry of ledger.list()) {
    if (entry.id === excludeId) continue
    if (!['rag', 'rag-summary'].includes(entry.source.type)) continue
    if (entry.ragIds.some((id) => dropped.has(id))) ledger.forget(entry.id)
  }
}

export function forgetExperience(id) {
  const ledger = getLedger()
  const entry = ledger.get(id)
  if (!entry || entry.deletedAt) return { ok: false, error: '没有这条记录' }
  try {
    getYearbook().pruneSource(id)
    const dropped = scrub(entry)
    forgetDerived(ledger, entry)
    markRagCopies(ledger, dropped, id)
    if (!ledger.forget(id)) throw new Error('账本状态未写入')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function correctExperience(id, text) {
  const body = String(text || '').trim()
  if (!body || body.length > 2000) return { ok: false, error: '更正内容需在 1–2000 字之间' }
  const ledger = getLedger()
  const entry = ledger.get(id)
  if (!entry || entry.deletedAt) return { ok: false, error: '没有这条记录' }
  try {
    getYearbook().pruneSource(id)
    const dropped = scrub(entry)
    forgetDerived(ledger, entry)
    markRagCopies(ledger, dropped, id)
    const rag = getRag().ingestFact({ text: body, source: 'user-correction' })
    addMemory(body, { recordLedgerEntry: false })
    flushPersist()
    const corrected = ledger.correct(id, body, Date.now(), rag.id ? [rag.id] : [])
    if (!corrected) throw new Error('更正未写入')
    return { ok: true, entry: corrected, indexed: rag.ok }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}
