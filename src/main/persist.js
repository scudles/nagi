// src/main/persist.js
// 本地持久化：长期记忆（memory.json）与对话历史（history.json）。
//
// 为什么要落盘：之前 history 只活在内存里，重启即清零 —— 每次开机凪都是陌生人，
// 只能说泛泛的话。记忆同样落盘，跨会话累积，才谈得上"认识你"。
// 写入用防抖 + 先写临时文件再改名，避免频繁 IO 与半截文件。

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_LIMIT, formatMemories, applyMemoryOps } from '../core/memory.js'

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

/** 防抖落盘（同一文件 400ms 内的多次写合并为一次） */
function writeJsonSoon(file, data, delay = 400) {
  const t = pending.get(file)
  if (t) clearTimeout(t)
  pending.set(
    file,
    setTimeout(() => {
      pending.delete(file)
      try {
        mkdirSync(app.getPath('userData'), { recursive: true })
        const tmp = file + '.tmp'
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
        try {
          if (existsSync(file)) unlinkSync(file)
        } catch {
          /* 目标被占用时直接覆盖 */
        }
        renameSync(tmp, file)
      } catch (err) {
        console.error('[persist] 写入失败', file, err.message)
      }
    }, delay)
  )
}

/** 进程退出前强制刷盘（will-quit 调用） */
export function flushPersist() {
  for (const [, t] of pending) clearTimeout(t)
  pending.clear()
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(usersFile('memory.json'), JSON.stringify({ version: 1, entries: memories || [] }, null, 2), 'utf8')
    writeFileSync(usersFile('history.json'), JSON.stringify({ version: 1, messages: history || [], lastAt }, null, 2), 'utf8')
  } catch (err) {
    console.error('[persist] 退出刷盘失败', err.message)
  }
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
  return formatMemories(loadMemories())
}

/** 完整条目（设置页展示用） */
export function listMemories() {
  return loadMemories().map((e) => ({ ...e }))
}

/** 手动新增一条 */
export function addMemory(text) {
  loadMemories()
  const t = String(text || '').trim()
  if (!t) return listMemories()
  memories = applyMemoryOps(memories, { add: [t] }, Date.now())
  persistMemories()
  return listMemories()
}

/** 删除一条（按 id 或原文） */
export function removeMemory({ id, text } = {}) {
  loadMemories()
  if (id) memories = memories.filter((e) => e.id !== id)
  else if (text) memories = applyMemoryOps(memories, { remove: [text] }, Date.now())
  persistMemories()
  return listMemories()
}

/**
 * 合并模型抽取出的增删指令。
 * @returns {{before:number, after:number, added:string[]}}
 */
export function mergeMemoryOps(ops, now = Date.now()) {
  loadMemories()
  const before = memories.length
  memories = applyMemoryOps(memories, ops || {}, now)
  const after = memories.length
  if (after !== before || (ops?.remove || []).length) persistMemories()
  return { before, after, added: (ops?.add || []).slice(0, MEMORY_LIMIT) }
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
