// src/main/diary.js
// 内心独白日史（D2 决策：后台静默记录——平时 UI 不显示，用户在日记查看器/文件夹里主动打开才看到）
// 落盘：userData/monologue/diary-YYYY-MM-DD.md，每条带时间与当时情绪强度。
//
// 2026-10-15：正文不再来自固定句子池，而是由 core/diary.js 依据「今天的经历 + 情绪 + 记忆」
// 即兴生成（见 agent.js 的 writeDiaryLine）。这里只负责落盘、读取与两项小状态：
//   - recentDiaryLines()：供生成时"不要重复"用
//   - 缓存残片的每周计数（人格设定 6.4 的极低频护栏）

import { app } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import { join } from 'node:path'
import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { getRag } from './rag/index.js'
import { randomUUID } from 'node:crypto'
import { getLedger, recordLedger } from './ledger.js'

function diaryDir() {
  return join(app.getPath('userData'), 'monologue')
}

function pad(n) { return String(n).padStart(2, '0') }

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 追加一条独白。
 * @param {{label:string,intensity:number}} snapshot 情绪快照
 * @param {string} text 正文
 * @param {{kind?:'inner'|'spoken'}} [opts] kind='inner' 时加「（心里）」前缀——
 *        便于日记里区分「她想但没说出口的」与「她真说过的话」
 */
export function appendDiary(snapshot, text, { kind } = {}) {
  try {
    const now = Date.now()
    const at = new Date(now)
    const dir = diaryDir()
    mkdirSync(dir, { recursive: true })
    const mark = kind === 'inner' ? '（心里）' : ''
    const line = `- ${timeStr(at)} ［${snapshot.label}·${Math.round(snapshot.intensity * 100)}%］ ${mark}${text}\n`
    appendFileSync(join(dir, `diary-${dateStr(at)}.md`), line, 'utf8')
    const dayStart = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
    const dependsOn = getLedger().list().filter((entry) => entry.source.type === 'journal-live' &&
      entry.occurredAt >= dayStart && entry.occurredAt <= now).map((entry) => entry.id)
    // RAG 的任何失败都不能让独白变成「没写」。文本先落日记文件，再尝试入档。
    let ragId = null
    try {
      const result = getRag().ingestDiary({ text, at: now, kind: kind === 'inner' ? 'inner' : 'spoken', mood: snapshot.label, intensity: snapshot.intensity })
      ragId = result?.id || null
    } catch (__err) { reportCatch('diary.appendDiary', CATCH_CLASS.VISIBLE, __err) }
    recordLedger({ category: 'subjective', text: `${mark}${text}`,
      source: { type: 'diary-live', ref: randomUUID() }, occurredAt: now,
      certainty: 'subjective', ragIds: ragId ? [ragId] : [],
      meta: { file: `diary-${dateStr(at)}.md`, kind: kind === 'inner' ? 'inner' : 'spoken', mood: snapshot.label, dependsOn } })
    return true
  } catch (err) {
    console.error('[diary] 写入失败：', err && err.message)
    return false
  }
}

/** 列出所有日记日期文件（新→旧） */
export function listDiaryDates() {
  try {
    return readdirSync(diaryDir())
      .filter((f) => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 读取一篇日记；文件不存在或越权返回 null */
export function readDiary(file) {
  if (!/^diary-\d{4}-\d{2}-\d{2}\.md$/.test(String(file || ''))) return null
  const full = join(diaryDir(), file)
  try {
    if (!statSync(full).isFile()) return null
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

export function removeDiaryEntry(entry) {
  if (!['diary', 'diary-live'].includes(entry?.source?.type)) return false
  const name = entry.meta?.file || String(entry.source.ref).split('#')[0]
  if (!/^diary-\d{4}-\d{2}-\d{2}\.md$/.test(name)) return false
  const file = join(diaryDir(), name)
  if (!existsSync(file)) return true
  const lines = readFileSync(file, 'utf8').split('\n')
  const kept = lines.filter((line) => !line.trim().endsWith(entry.text))
  if (kept.length !== lines.length) writeFileSync(file, kept.join('\n'), 'utf8')
  return true
}

const LINE_RE = /^- \d{2}:\d{2} ［[^］]*］\s*(.*)$/

/**
 * 最近写过的日记正文（新→旧，最多 n 条）——生成新日记时喂给模型做「不要重复」约束。
 * @param {number} n
 * @returns {string[]}
 */
export function recentDiaryLines(n = 6) {
  const want = Math.max(1, Math.floor(Number(n) || 6))
  const out = []
  for (const file of listDiaryDates()) {
    const text = readDiary(file)
    if (!text) continue
    const lines = text.split('\n').filter(Boolean).reverse() // 文件内旧→新，取最新的先看
    for (const line of lines) {
      const m = line.match(LINE_RE)
      if (!m || !m[1]) continue
      out.push(m[1].replace(/^（心里）/, '').trim())
      if (out.length >= want) return out
    }
  }
  return out
}

/* ---------------- 缓存残片的每周计数（极低频护栏） ---------------- */

const WEEK_MS = 7 * 86400000

function leakFile() {
  return join(diaryDir(), '.cache-leak.json')
}

function readLeak(now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(leakFile(), 'utf8'))
    const start = Number(raw && raw.weekStart)
    const count = Number(raw && raw.count)
    if (!Number.isFinite(start) || !Number.isFinite(count)) return { weekStart: now, count: 0 }
    if (now - start >= WEEK_MS) return { weekStart: now, count: 0 } // 过期即翻新一周
    return { weekStart: start, count }
  } catch {
    return { weekStart: now, count: 0 }
  }
}

/** 本周已经让缓存露头几次（生成前的判断用） */
export function cacheLeakCount(now = Date.now()) {
  return readLeak(now).count
}

/** 记一次缓存露头 */
export function noteCacheLeak(now = Date.now()) {
  try {
    const cur = readLeak(now)
    mkdirSync(diaryDir(), { recursive: true })
    writeFileSync(leakFile(), JSON.stringify({ version: 1, weekStart: cur.weekStart, count: cur.count + 1 }), 'utf8')
  } catch (err) {
    console.warn('[diary] 缓存计数写入失败：', err && err.message)
  }
}
