// src/main/journal.js
// 事件流水的落盘与读取（薄 IO，逻辑全在 core/journal.js）。
// 文件：userData/journal/YYYY-MM-DD.json，保留最近 7 天。
//
// 隐私：只记聊天文本与行为类别，绝不记窗口标题原文。

import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { JOURNAL, dateKey, normalizeEntries, appendEntry, pruneOld } from '../core/journal.js'
import { randomUUID } from 'node:crypto'
import { recordLedger } from './ledger.js'

let cache = { date: null, entries: [], dirty: false }
let flushTimer = null

const dir = () => join(app.getPath('userData'), 'journal')
const fileOf = (date) => join(dir(), `${date}.json`)

function ensureDay(now = Date.now()) {
  const key = dateKey(now)
  if (cache.date === key) return
  // 跨日之前先写完前一天；否则新事件会取消旧定时器并覆盖内存缓存。
  if (!flushJournal()) throw new Error('前一天的事件尚未落盘')
  cache = { date: key, entries: readDay(key), dirty: false }
}

function readDay(date) {
  try {
    const raw = JSON.parse(readFileSync(fileOf(date), 'utf8'))
    return normalizeEntries(raw && raw.entries)
  } catch {
    return []
  }
}

function flushSoon() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushJournal()
  }, 800)
  flushTimer.unref?.()
}

/** 立即写完待落盘事件；退出和跨日时调用，避免防抖窗口内丢记录。 */
export function flushJournal() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (!cache.date || !cache.dirty) return true
  try {
    mkdirSync(dir(), { recursive: true })
    writeFileSync(fileOf(cache.date), JSON.stringify({ version: 1, date: cache.date, entries: cache.entries }), 'utf8')
    cache.dirty = false
    return true
  } catch (err) {
    console.warn('[journal] 写入失败：', err && err.message)
    return false
  }
}

/**
 * 记一条今天发生的事。失败不影响主流程。
 * @param {{kind:'chat'|'proactive'|'reminder'|'poke'|string, text?:string, user?:string, reply?:string}} evt
 */
export function noteEvent(evt, now = Date.now(), ragIds = []) {
  try {
    ensureDay(now)
    const next = appendEntry(cache.entries, { ...evt, t: now })
    if (next !== cache.entries) {
      cache.entries = next
      cache.dirty = true
      flushSoon()
      const body = evt.kind === 'chat'
        ? [evt.user && `他：${evt.user}`, evt.reply && `我：${evt.reply}`].filter(Boolean).join('\n')
        : evt.kind === 'poke' ? '用户戳了凪' : String(evt.text || '')
      if (body) return recordLedger({ category: 'experience', text: body,
        source: { type: 'journal-live', ref: randomUUID() }, occurredAt: now,
        certainty: 'observed', ragIds, meta: { eventKind: evt.kind } })
    }
  } catch (err) {
    console.warn('[journal] 记事件失败：', err && err.message)
  }
}

/** 今天的全部事件（旧→新） */
export function todayEvents(now = Date.now()) {
  ensureDay(now)
  return cache.entries.slice()
}

/** 清掉保留期之外的流水文件（启动跑一次；单批限量，避开"单回合批量删除"类保护） */
export function pruneJournals(now = Date.now()) {
  try {
    const d = dir()
    if (!existsSync(d)) return []
    const dates = readdirSync(d)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
    const dead = pruneOld(dates, now, JOURNAL.KEEP_DAYS).slice(0, 20)
    let removed = 0
    for (const key of dead) {
      try {
        unlinkSync(fileOf(key))
        removed++
      } catch {
        /* 占用/不存在都跳过 */
      }
    }
    if (removed) console.log(`[journal] 清理 ${removed} 个过期流水文件（保留最近 ${JOURNAL.KEEP_DAYS} 天）`)
    return dead.slice(0, removed)
  } catch (err) {
    console.warn('[journal] 清理失败：', err && err.message)
    return []
  }
}
