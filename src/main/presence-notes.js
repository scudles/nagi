// src/main/presence-notes.js
// BLUE-3 业务状态：她留下的东西（便签）+ 行动留痕 + 回忆物候选（含落盘）。
//
// 边界（契约 §1 / §4）：
//   · 只被蓝区扩展 `extensions/traces.js` 与 `ipc/notes.js` 调用；不碰红区状态机；
//   · **默认关闭**：notesEnabled / tracesEnabled / anchorsEnabled 全关时，不读盘、不建文件、
//     不产生任何记录；三个开关全关之后再同步一次就删除本模块的文件并清空内存；
//   · 便签的数量/间隔/幂等/勿扰由 core/presence/notes.js 决定（纯逻辑），这里只负责
//     「收集事实 → 过闸 → 存下来」以及上限清理；
//   · 外部便签文件写入**不在本模块**：未实现安全桥接前只显示应用内候选（不伪装写入成功）。
//
// 落盘：userData/notes.json，临时文件 + 改名（与 companion.js 同款），
// 不做周期写；单文件小，条数与天数都有硬上限。

import { app } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSettings } from './settings-store.js'
import { listMemories, loadRelationStats } from './persist.js'
import { getPromiseBook } from './promises.js'
import { selectForContext } from '../core/promises/book.js'
import { getLedger } from './ledger.js'
import { considerNote, normalizeNoteState, emptyNoteState } from '../core/presence/notes.js'
import { normalizeActionTrace, appendTrace, normalizeTraceList, TRACE_LIMITS } from '../core/presence/traces.js'
import { listAnchors, normalizeAnchorState, emptyAnchorState, ANCHOR_LIMITS } from '../core/presence/anchors.js'
import { familiarityScore, familiarityLevel } from '../core/relation/familiarity.js'
import { externalNotesView } from './notes-file.js'

/** 存储上限（契约只写「有上限」，这里取保守值） */
export const NOTES_STORE_LIMITS = {
  /** 便签最多留多少条 */
  maxNotes: 30,
  /** 便签最多留多少天 */
  keepDays: 14
}

let state = { notes: [], traces: [], noteState: emptyNoteState(), anchorState: emptyAnchorState() }
let loaded = false
/** 变化通知（广播给两窗）；由启动装配处注入，避免本模块依赖 windows.js */
let changedListener = null

export function setNotesChangedListener(fn) {
  changedListener = typeof fn === 'function' ? fn : null
}
function notify() {
  try {
    changedListener?.()
  } catch{ /* B8:degrade — 广播失败不影响已落盘的便签 */ }
}

const file = () => join(app.getPath('userData'), 'notes.json')

function presenceCfg() {
  return getSettings().presence || {}
}

/** 三个业务开关是否有任何一个开着 */
export function notesFeatureEnabled() {
  const p = presenceCfg()
  return p.notesEnabled === true || p.tracesEnabled === true || p.anchorsEnabled === true
}

function pruneNotes(notes, now) {
  const cutoff = now - NOTES_STORE_LIMITS.keepDays * 86400000
  const alive = (Array.isArray(notes) ? notes : []).filter((n) => n && n.id && Number.isFinite(n.at) && n.at >= cutoff)
  return alive.length > NOTES_STORE_LIMITS.maxNotes ? alive.slice(-NOTES_STORE_LIMITS.maxNotes) : alive
}

/** 只在开启时读盘；关闭时保持空状态且不创建文件 */
export function loadNotes(now = Date.now()) {
  if (loaded) return state
  loaded = true
  if (!notesFeatureEnabled()) {
    state = { notes: [], traces: [], noteState: emptyNoteState(now), anchorState: emptyAnchorState(now) }
    return state
  }
  let raw = null
  try {
    if (existsSync(file())) raw = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    raw = null
  }
  state = {
    notes: pruneNotes(raw?.notes, now),
    traces: normalizeTraceList(raw?.traces, { now }),
    noteState: normalizeNoteState(raw?.noteState, now),
    anchorState: normalizeAnchorState(raw?.anchorState, now)
  }
  return state
}

function save() {
  if (!notesFeatureEnabled()) return false
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = `${file()}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), ...state }), 'utf8')
    renameSync(tmp, file())
    return true
  } catch (err) {
    console.warn('[notes] 写入失败', err?.message)
    return false
  }
}

/**
 * C5（CONTRACTS §11.1）：遗忘时清理**引用到被遗忘内容**的便签。
 *
 * 为什么必须做：便签是她留给用户的话，可能直接引用了那件事。
 * 契约给的两个选项是"一并处理"或"标已删"——这里选**一并删除**，
 * 因为"不可引用"是硬要求，留着一条「（已删除）」反而把原文的语境留在界面上。
 *
 * 匹配口径与 scrub() 对齐：用同一批"可识别片段"（整条正文 / 去前缀后的首句），
 * 片段太短（<4 字）不参与匹配，避免"今天"这类词把无关便签误删。
 *
 * @param {string[]} fragments
 * @returns {{removed:number, remaining:number}}
 */
export function pruneNotesReferencing(fragments = []) {
  // 片段匹配要**容忍引用**：便签里常常只写原文的一截（"他上次说不喜欢香菜"），
  // 而遗忘传入的是整句（"我不喜欢香菜，别给我点"）。所以除了整句，
  // 还要按标点切成子句各自参与匹配，否则永远是"整句对不上 → 便签留着"。
  const raw = (Array.isArray(fragments) ? fragments : []).map((s) => String(s || '').trim()).filter(Boolean)
  const expanded = new Set()
  for (const s of raw) {
    expanded.add(s)
    for (const piece of s.split(/[，,。.；;！!？?\s]+/)) {
      const t = piece.trim()
      if (t) expanded.add(t)
    }
  }
  const needles = [...expanded].filter((s) => s.length >= 4).slice(0, 40)
  if (!needles.length) return { removed: 0, remaining: (state.notes || []).length }
  loadNotes()
  const before = (state.notes || []).length
  state.notes = (state.notes || []).filter((n) => {
    const text = String(n?.text || '')
    return !needles.some((needle) => text.includes(needle))
  })
  const removed = before - state.notes.length
  if (removed > 0) save()
  return { removed, remaining: state.notes.length }
}

/**
 * 与设置同步：开关全关 → 清内存 + 删文件（下次开启重新开始，不回填）。
 * 由记录路径与 IPC 读取路径调用（不新增周期 timer）。
 */
export function syncNotesSettings(now = Date.now()) {
  const on = notesFeatureEnabled()
  if (!on) {
    const had = loaded && (state.notes.length || state.traces.length)
    state = { notes: [], traces: [], noteState: emptyNoteState(now), anchorState: emptyAnchorState(now) }
    loaded = true
    let removed = false
    try {
      if (existsSync(file())) {
        unlinkSync(file())
        removed = true
      }
    } catch (err) {
      console.warn('[notes] 关闭时删除文件失败', err?.message)
    }
    if (had || removed) notify()
    return { enabled: false, removed }
  }
  loadNotes(now)
  return { enabled: true, removed: false }
}

/** 记一条便签候选：过 core 的闸（幂等/配额/间隔/勿扰），通过才存 */
function offerNote({ kind, event, now }) {
  const p = presenceCfg()
  const r = considerNote({
    kind,
    event,
    now,
    state: state.noteState,
    config: { notesEnabled: p.notesEnabled === true },
    privacy: getSettings().privacy || {}
  })
  state.noteState = r.state
  if (!r.note) return null
  state.notes = pruneNotes([...state.notes, r.note], now)
  save()
  notify()
  return r.note
}

/**
 * presence 事件 → 便签 / 撤回。
 * @param {object} event 引擎事件（activity / reunion / activity-forgotten / …）
 */
export function recordPresenceEvent(event, now = Date.now()) {
  if (!event || typeof event !== 'object') return null
  syncNotesSettings(now)
  if (!notesFeatureEnabled()) return null
  if (event.kind === 'activity') return offerNote({ kind: 'activity', event: event.activity, now })
  if (event.kind === 'reunion') return offerNote({ kind: 'reunion', event, now })
  // 来源被忘记 → 派生便签必须跟着撤回（不能引用已删除的东西）
  if (event.kind === 'activity-forgotten') {
    const before = state.notes.length
    state.notes = state.notes.filter((n) => n.activityId !== event.id)
    if (state.notes.length !== before) {
      save()
      notify()
      return { withdrawn: before - state.notes.length }
    }
  }
  return null
}

/** action-trace → 留痕（tracesEnabled）+ 便签候选（notesEnabled） */
export function recordActionTrace(raw, now = Date.now()) {
  syncNotesSettings(now)
  if (!notesFeatureEnabled()) return null
  const trace = normalizeActionTrace(raw, now)
  if (!trace) return null
  const p = presenceCfg()
  if (p.tracesEnabled === true) {
    const r = appendTrace(state.traces, trace, { now })
    if (r.added) {
      state.traces = r.list
      save()
      notify()
    }
  }
  return offerNote({ kind: 'action', event: trace, now })
}

/** 只读列表（渲染层查看器用） */
export function listNotes(now = Date.now()) {
  syncNotesSettings(now)
  const p = presenceCfg()
  const anchorView = listAnchorCandidates(now)
  return {
    enabled: { notes: p.notesEnabled === true, traces: p.tracesEnabled === true, anchors: p.anchorsEnabled === true },
    // 安全桥接已实现（B23）：默认关闭 + 授权目录 + 逐次确认。界面按这个如实显示。
    externalWriteAvailable: true,
    external: externalNotesView(),
    notes: state.notes.map((n) => ({ ...n })),
    traces: state.traces.map((t) => ({ id: t.id, at: t.at, tool: t.tool, status: t.status, summary: t.result?.summary || '' })),
    anchors: anchorView.anchors.map((a) => ({ ...a })),
    anchorLevel: anchorView.level,
    limits: { ...NOTES_STORE_LIMITS, traceMax: TRACE_LIMITS.max, anchorPerDay: ANCHOR_LIMITS.perDayMax }
  }
}

/** 清内存与磁盘（不改设置开关） */
export function clearNotes(now = Date.now()) {
  state = { notes: [], traces: [], noteState: emptyNoteState(now), anchorState: emptyAnchorState(now) }
  loaded = true
  let removed = false
  try {
    if (existsSync(file())) {
      unlinkSync(file())
      removed = true
    }
  } catch (err) {
    return { ok: false, error: err?.message }
  }
  notify()
  return { ok: true, removed }
}

/* ---------------- 回忆物候选（只读展示，不自动开口） ---------------- */

/**
 * 聚合当前可用的回忆物锚点。
 *
 * 来源三处：关系统计（第一次见面）、长期记忆（共同引用/称呼）、承诺簿（承诺）。
 * 每个锚点的 sourceIds 都能在 evidence 里查到，才可能被引用——删除过的来源查不到，
 * 整条锚点就不出现（契约 §4 的「引用前重验」）。
 */
/**
 * 已被遗忘的账本条目 ID（含派生承诺一起忘的那些）。
 * 建锚点前用它重验承诺的 sourceIds——"引用前重验该来源仍可用"（§11.4）。
 */
function forgottenLedgerIds() {
  try {
    // 必须带 includeDeleted：账本默认把已遗忘条目藏起来了，
    // 不取墓碑就永远重验不出"来源已遗忘"，这条护栏形同虚设。
    return getLedger().list({ includeDeleted: true })
      .filter((e) => e?.deletedAt).map((e) => e.id)
  } catch {
    return []
  }
}

export function listAnchorCandidates(now = Date.now()) {
  const p = presenceCfg()
  if (p.anchorsEnabled !== true) return { anchors: [], level: null }
  const evMap = new Map()
  const anchors = []
  // 第一次见面：来源是关系统计，恒可访问
  let stats = null
  try {
    stats = loadRelationStats(now)
  } catch {
    stats = null
  }
  if (stats && Number.isFinite(stats.firstMetAt)) {
    evMap.set('relation:first-met', { id: 'relation:first-met' })
    anchors.push({
      id: 'anchor:first-contact',
      kind: 'first-contact',
      sourceIds: ['relation:first-met'],
      occurredAt: stats.firstMetAt,
      trust: 'observed',
      text: '我们第一次见面'
    })
  }
  // 长期记忆：提到称呼的是 user-stated，其余算 subjective 的共同引用
  for (const m of listMemories()) {
    if (!m?.id || !m.text) continue
    evMap.set(`memory:${m.id}`, { id: `memory:${m.id}` })
    const nicknameish = /叫|称呼|名字/.test(m.text)
    anchors.push({
      id: `anchor:mem:${m.id}`,
      kind: nicknameish ? 'nickname' : 'shared-reference',
      sourceIds: [`memory:${m.id}`],
      occurredAt: Number.isFinite(m.at) ? m.at : now,
      trust: m.provenance === 'user-stated' ? 'user-stated' : 'subjective',
      text: m.text
    })
  }
  // 承诺簿：把他要求过的、我说过会做的事留成承诺锚点
  try {
    for (const item of selectForContext(getPromiseBook().list(), { forgottenIds: forgottenLedgerIds() })) {
      if (!item?.id || !item.title) continue
      // §11.4：经历被遗忘后仍保留的提醒（detached）/已降级的最小履约记录（无正文），
      // 都不许被人格回忆、关系锚点或模型上下文读到——它们只归提醒交付与管理界面。
      const link = item.linkStatus || 'unknown'
      evMap.set(`promise:${item.id}`, { id: `promise:${item.id}` })
      anchors.push({
        id: `anchor:promise:${item.id}`,
        kind: 'promise',
        sourceIds: [`promise:${item.id}`],
        occurredAt: Number.isFinite(item.at) ? item.at : now,
        trust: link === 'linked' ? 'user-stated' : 'subjective',
        text: item.title
      })
    }
  } catch (__err) { reportCatch('presence-notes.listAnchorCandidates', CATCH_CLASS.VISIBLE, __err) }
  const evidence = [...evMap.values()]
  let levelKey = 'stranger'
  try {
    levelKey = familiarityLevel(familiarityScore(stats || {}, now)).key
  } catch {
    levelKey = 'stranger'
  }
  return { anchors: listAnchors({ now, relationLevel: levelKey, anchors, evidence, config: p }), level: levelKey }
}

/* ---------------- 测试钩子（仅内存，不落盘） ---------------- */

/** 只给单测用的状态读取（生产路径不调用） */
export function __peekState() {
  return state
}
