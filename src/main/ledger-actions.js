// 用户纠错/忘记的单一入口：先清所有可供提示词和检索读取的旧来源，再改账本状态。
import { getLedger } from './ledger.js'
import { getYearbook } from './yearbook.js'
import { pruneNotesReferencing } from './presence-notes.js'
import { forgetGuard } from './forget-guard.js'
import { getRag } from './rag/index.js'
import { removeJournalEntry } from './journal.js'
import { detachForgottenSource } from './promises.js'
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
  // C5（§11.1「便签」）：引用了这件事的便签一并清掉。
  // 便签是她留给用户的话，留着一条提到原文的便签等于原文还能被读到。
  // 失败不阻断：便签是派生展示层，清不掉也不该让整次遗忘失败（与上面必须成功的六处不同）。
  const notePruned = pruneNotesReferencing([entry.text, ...parts])
  if (notePruned.removed > 0) console.log('[forget] 便签已清理 ' + notePruned.removed + ' 条')
  // C5-BG-02：把片段记进进程级遗忘表。
  // 主对话的异步记忆抽取可能正拿着旧输入等模型返回，结果回来时要靠这张表拦住复活。
  forgetGuard.noteForget([entry.text, ...parts])
  const memory = listMemories().filter((item) => item.text === entry.text ||
    (entry.source.type.startsWith('memory') && item.id === entry.source.ref))
  for (const item of memory) removeMemory({ id: item.id }, { updateLedger: false })
  loadHistory()
  // B01：刷盘失败绝不放行——六个下游清完了却没落盘，用户会以为"已忘记"，
  // 重启后旧内容复活。失败时抛错，账本状态保持原样（forget/correct 还没执行），可重试。
  const flushed = flushPersist()
  if (!flushed.ok) {
    throw new Error(`旧内容未完全落盘（${flushed.failed.map((f) => f.file).join('、')}），请重试；本次清理未生效`)
  }
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
    const dropped = scrub(entry)
    forgetDerived(ledger, entry)
    markRagCopies(ledger, dropped, id)
    getYearbook().pruneSource(id)
    // §11.4：承诺边界在账本状态写入之前处理，失败要如实回给用户（不能漏、也不能假装没关联）。
    const promiseOutcome = detachForgottenSource(entry.id)
    if (!ledger.forget(id)) throw new Error('账本状态未写入')
    return withPromiseNotice({ ok: true }, promiseOutcome)
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * 把「关联的提醒还在」如实说给用户：没有静默取消，也没有让用户浑然不知。
 * 只回提醒的 id / 时间，正文由管理界面在本地读（不外扩给模型上下文）。
 */
function withPromiseNotice(base, { kept = [], redacted = [], unknownHint = false } = {}) {
  return {
    ...base,
    promises: { kept, redacted, unknownHint },
    note: [
      kept.length ? `这条经历关联着 ${kept.length} 个你单独设的提醒，已保留；可在提醒里一并取消。` : '',
      redacted.length ? `已清理 ${redacted.length} 条关联履约记录（只留时间与类别）。` : '',
      unknownHint ? '另有一些较早的承诺没有记录来源，无法确认是否关联，建议你到提醒里自己看一眼。' : ''
    ].filter(Boolean).join(' ')
  }
}

export function correctExperience(id, text) {
  const body = String(text || '').trim()
  if (!body || body.length > 2000) return { ok: false, error: '更正内容需在 1–2000 字之间' }
  const ledger = getLedger()
  const entry = ledger.get(id)
  if (!entry || entry.deletedAt) return { ok: false, error: '没有这条记录' }
  try {
    const dropped = scrub(entry)
    forgetDerived(ledger, entry)
    markRagCopies(ledger, dropped, id)
    getYearbook().pruneSource(id)
    const rag = getRag().ingestFact({ text: body, source: 'user-correction' })
    addMemory(body, { recordLedgerEntry: false })
    // B01：新记忆没落盘就不许改账本——否则 UI 说"已更正"，重启后纠正内容消失
    const flushed = flushPersist()
    if (!flushed.ok) {
      throw new Error(`新内容未完全落盘（${flushed.failed.map((f) => f.file).join('、')}），请重试；本次更正未生效`)
    }
    const corrected = ledger.correct(id, body, Date.now(), rag.id ? [rag.id] : [])
    if (!corrected) throw new Error('更正未写入')
    return { ok: true, entry: corrected, indexed: rag.ok }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}
