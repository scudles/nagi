// src/main/persist.js
// 本地持久化：长期记忆（memory.json）、对话历史（history.json）、
// 情绪状态（mood.json，S4 跨重启延续）、关系统计（relation.json，S4 熟悉度）。
//
// 为什么要落盘：之前 history 只活在内存里，重启即清零 —— 每次开机凪都是陌生人，
// 只能说泛泛的话。记忆同样落盘，跨会话累积，才谈得上"认识你"。
// 情绪与关系同理：不落盘她就没有连续性（见 core/relation/）。
// 写入用防抖 + 原子替换（写 tmp → rename，B01 修复：旧的"先删原文件再 rename"
// 在两步之间崩溃会丢光旧数据）。flush 的逐文件结果如实返回，失败绝不静默。

import { app } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import * as fsApi from 'node:fs'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mergeMemoryEntries } from '../core/memory.js'
import { atomicWriteJsonSync } from '../core/persist-io.js'
import { recordLedger, deleteLedgerSource } from './ledger.js'

const usersFile = (name) => join(app.getPath('userData'), name)

/* ---------------- 通用读写 ---------------- */

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw == null ? fallback : raw
  } catch {
    return fallback
  }
}

const pending = new Map() // file -> timeout

/** 防抖落盘（同一文件 400ms 内的多次写合并为一次；原子替换，B01） */
function writeJsonSoon(file, data, delay = 400) {
  const t = pending.get(file)
  if (t) clearTimeout(t)
  pending.set(
    file,
    setTimeout(() => {
      pending.delete(file)
      try {
        mkdirSync(app.getPath('userData'), { recursive: true })
        const r = atomicWriteJsonSync(fsApi, file, data)
        if (!r.ok) {
          // 不重试入队：数据还在内存里，下次同文件写入会自然再试；
          // 退出时 flushPersist() 用当前内存兜底。此处如实记录，不装没发生。
          console.error('[persist] 防抖写入失败', file, r.error)
        }
      } catch (err) {
        console.error('[persist] 写入失败', file, err.message)
      }
    }, delay)
  )
}

/* ---------------- 退出刷盘与失败可见性（B01） ---------------- */

const PERSIST_FILES = ['memory.json', 'history.json', 'mood.json', 'relation.json']
const WARNINGS_FILE = 'persist-warnings.json'
const WARNINGS_KEEP = 20

/**
 * 进程退出前/关键操作后强制刷盘。
 *
 * 与旧版的三处差别（B01）：
 * 1. 走原子替换（写 tmp → rename），不再"先删原文件"——中断窗口关闭；
 * 2. 刷盘前先 load* 保证内存与磁盘一致——旧版直接写 `memories || []`，
 *    从未读过 memory 的进程（启动即退出）会把用户的记忆文件覆盖成空；
 * 3. 返回逐文件结果，失败绝不静默——调用方（ledger-actions / disposeAgent）必须检查。
 *
 * @returns {{ok:boolean, written:string[], failed:{file:string,error:string}[]}}
 */
export function flushPersist() {
  const written = []
  const failed = []
  for (const [, t] of pending) clearTimeout(t)
  pending.clear()
  // 保证"没读过的文件"不会被当成空写出去（旧版 latent bug：启动即退出即清空）
  loadMemories()
  loadHistory()
  loadMoodState()
  loadRelationStats()
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const snapshots = {
      'memory.json': { version: 1, entries: memories || [] },
      'history.json': { version: 1, messages: history || [], lastAt },
      'mood.json': moodState,
      'relation.json': relationStats
    }
    for (const name of PERSIST_FILES) {
      const data = snapshots[name]
      if (data == null) continue // mood/relation 从未有过状态：不创建空文件
      const r = atomicWriteJsonSync(fsApi, usersFile(name), data)
      if (r.ok) written.push(name)
      else failed.push({ file: name, error: r.error })
    }
  } catch (err) {
    failed.push({ file: '(目录)', error: err?.message || String(err) })
  }
  if (failed.length) {
    console.error('[persist] 刷盘未完全成功', JSON.stringify(failed))
    writeFlushWarnings(failed)
  }
  return { ok: failed.length === 0, written, failed }
}

/** 把本次写失败落一份"小报告"，下次启动时如实告诉用户（best-effort，写失败只 log） */
function writeFlushWarnings(failed) {
  try {
    const prev = readJson(usersFile(WARNINGS_FILE), { events: [] })
    const events = Array.isArray(prev?.events) ? prev.events : []
    events.push({ at: Date.now(), failed })
    writeFileSync(usersFile(WARNINGS_FILE), JSON.stringify({ events: events.slice(-WARNINGS_KEEP) }), 'utf8')
  } catch (err) {
    console.error('[persist] 失败报告落盘失败', err.message)
  }
}

/** 启动时取回上次的写失败记录并清空（一次一提示，不复读；没有则返回 []） */
export function consumePersistWarnings() {
  const file = usersFile(WARNINGS_FILE)
  const prev = readJson(file, null)
  const events = Array.isArray(prev?.events) ? prev.events : []
  if (!events.length) return []
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch (__err) { reportCatch('persist.consumePersistWarnings', CATCH_CLASS.MUST_PERSIST, __err) }
  return events
}

/* ---------------- 长期记忆 ---------------- */

let memories = null

/** 读取（懒加载 + 缓存） */
export function loadMemories() {
  if (memories) return memories
  const raw = readJson(usersFile('memory.json'), { entries: [] })
  const entries = Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw) ? raw : []
  memories = entries.filter((e) => e && typeof e.text === 'string' && e.text.trim())
  return memories
}

function persistMemories() {
  writeJsonSoon(usersFile('memory.json'), { version: 1, entries: memories })
}

/** 给提示词用的短句数组 */
export function memoryLines() {
  return loadMemories().map((entry) =>
    `${entry.provenance === 'user-stated' ? '用户明确记下' : '未经核实的模型摘录'}：${entry.text}`)
}

/** 完整条目（设置页展示用） */
export function listMemories() {
  return loadMemories().map((e) => ({ ...e }))
}

/** 手动新增一条 */
export function addMemory(text, { recordLedgerEntry = true } = {}) {
  loadMemories()
  const t = String(text || '').trim()
  if (!t) return listMemories()
  const result = mergeMemoryEntries(memories, { add: [t] }, Date.now())
  memories = result.entries.map((entry) => result.added.includes(entry.text)
    ? { ...entry, provenance: 'user-stated' } : entry)
  for (const entry of memories.filter((item) => result.added.includes(item.text) && recordLedgerEntry)) {
    recordLedger({ category: 'claim', text: entry.text,
      source: { type: 'memory-manual', ref: entry.id }, occurredAt: entry.at,
      certainty: 'user-stated', meta: { memoryId: entry.id } })
  }
  persistMemories()
  return listMemories()
}

/** 删除一条（按 id 或原文） */
export function removeMemory({ id, text } = {}, { updateLedger = true } = {}) {
  loadMemories()
  const before = memories.filter((entry) => id ? entry.id === id : text && entry.text === text)
  if (id) memories = memories.filter((e) => e.id !== id)
  else if (text) memories = mergeMemoryEntries(memories, { remove: [text] }, Date.now()).entries
  if (updateLedger) for (const entry of before) {
    for (const type of ['memory-manual', 'memory-model', 'memory']) deleteLedgerSource(type, entry.id)
  }
  persistMemories()
  return listMemories()
}

/**
 * 合并模型抽取出的增删指令。
 * 按「内容变化」判断写盘：满额淘汰后数量不变，内容确实变了也必须落盘（D01 修复）。
 * @returns {{before:number, after:number, added:string[], removed:string[]}}
 */
export function mergeMemoryOps(ops, now = Date.now(), provenance = {}) {
  loadMemories()
  const before = memories
  const r = mergeMemoryEntries(before, ops || {}, now)
  memories = r.entries.map((entry) => r.added.includes(entry.text)
    ? { ...entry, provenance: 'model-extracted' } : entry)

  for (const entry of before.filter((item) => r.removed.includes(item.text))) {
    for (const type of ['memory-manual', 'memory-model', 'memory']) deleteLedgerSource(type, entry.id)
  }

  for (const entry of memories.filter((item) => r.added.includes(item.text))) {
    recordLedger({ category: 'claim', text: entry.text,
      source: { type: 'memory-model', ref: entry.id }, occurredAt: now,
      certainty: 'unverified', meta: { memoryId: entry.id, derivedFromUserText: String(provenance.userText || '') } })
  }
  if (r.changed) persistMemories()
  return { before: before.length, after: memories.length, added: r.added, removed: r.removed }
}

/* ---------------- 情绪状态（S4：跨重启延续） ---------------- */

let moodState = null

/** 上次退出时的情绪快照（无则 null）。恢复逻辑在 core/emotion/mood.js 的 restore() */
export function loadMoodState() {
  if (moodState) return moodState
  const raw = readJson(usersFile('mood.json'), null)
  moodState = raw && typeof raw === 'object' ? raw : null
  return moodState
}

export function saveMoodState(state) {
  if (!state || typeof state !== 'object') return
  moodState = state
  writeJsonSoon(usersFile('mood.json'), state)
}

/* ---------------- 关系统计（S4：熟悉度） ---------------- */

let relationStats = null

/** 关系统计 { firstMetAt, interactionCount, activeDays[], lastActiveDay }（无则 null） */
export function loadRelationStats() {
  if (relationStats) return relationStats
  const raw = readJson(usersFile('relation.json'), null)
  relationStats = raw && typeof raw === 'object' ? raw : null
  return relationStats
}

export function saveRelationStats(stats) {
  if (!stats || typeof stats !== 'object') return
  relationStats = stats
  writeJsonSoon(usersFile('relation.json'), { version: 1, ...stats })
}

/** 清空关系与情绪（设置页"重新认识"用；时间线文件由调用方处理） */
export function resetRelationStats() {
  relationStats = null
  moodState = null
  try {
    const base = app.getPath('userData')
    for (const f of ['relation.json', 'mood.json']) {
      const p = join(base, f)
      if (existsSync(p)) unlinkSync(p)
    }
  } catch (err) {
    console.error('[persist] 重置关系失败', err.message)
  }
}

/* ---------------- 对话历史 ---------------- */

let history = null
let lastAt = null

const HISTORY_LIMIT = 40

export function loadHistory() {
  if (history) return history
  const raw = readJson(usersFile('history.json'), { messages: [] })
  const msgs = Array.isArray(raw?.messages) ? raw.messages : Array.isArray(raw) ? raw : []
  history = msgs
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-HISTORY_LIMIT)
  lastAt = Number.isFinite(raw?.lastAt) ? raw.lastAt : null
  return history
}

export function saveHistory(messages, at = Date.now()) {
  history = (messages || []).slice(-HISTORY_LIMIT)
  lastAt = at
  writeJsonSoon(usersFile('history.json'), { version: 1, messages: history, lastAt })
}

/** 上次互动时间戳（用于「距离上次和他说话多久」），没有则 null */
export function lastInteractionAt() {
  if (history === null) loadHistory()
  return lastAt
}

/** 清空对话历史（设置页用） */
export function clearHistory() {
  history = []
  lastAt = null
  writeJsonSoon(usersFile('history.json'), { version: 1, messages: [], lastAt: null })
}

export function purgeHistoryFragments(fragments) {
  loadHistory()
  const needles = fragments.map((text) => String(text || '').trim()).filter(Boolean)
  if (!needles.length) return 0
  const before = history.length
  history = history.filter((message) => !needles.some((needle) =>
    message.content.trim() === needle || (needle.length >= 3 && message.content.includes(needle))))
  if (history.length !== before) writeJsonSoon(usersFile('history.json'), { version: 1, messages: history, lastAt })
  return before - history.length
}
