// src/main/reminders.js
// 日程提醒服务：落盘（userData/reminders.json）+ 定时检查到期 + 增删改查。
//
// 判定逻辑全在 core/reminders/schedule.js（纯函数），这里只做 IO、调度与装配。
// 到点后不在这里直接说话——交给 agent.js 的 onDue 回调，那里才碰情绪/广播/日记。

import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { reminderOccurrenceKey } from '../core/reminders/delivery.js'
import { reportCatch } from './maintenance.js'
import { CATCH_CLASS } from '../core/maintenance/catch-audit.js'
import {
  normalizeItem,
  normalizeItems,
  sortItems,
  isDue,
  advanceRepeat,
  parseWhen,
  formatWhen,
  remainingText,
  describeItem,
  REPEATS,
  REPEAT_LABEL,
  REMINDER_LIMIT,
  MAX_AHEAD_MS
} from '../core/reminders/schedule.js'
import { createReminderPromise, getPromiseBook, markReminder, rescheduleReminder, syncReminderPromises } from './promises.js'

/** 默认检查间隔（秒）。20 秒足够准，也不至于频繁读盘 */
const DEFAULT_CHECK_SEC = 20
/** 一次性提醒错过多久就不再打扰（关着应用错过了太久的事，事后提醒也没意义） */
const STALE_MS = 12 * 3600000

let items = null
let timer = null
let onDueCb = null
const dispatching = new Set()

const filePath = () => join(app.getPath('userData'), 'reminders.json')

function load() {
  if (items) return items
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'))
    const list = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : []
    items = normalizeItems(list)
  } catch {
    items = []
  }
  return items
}

function save() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const temp = filePath() + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  renameSync(temp, filePath())
}

/** 装配（首次用到时读盘）。app ready 之后调用 */
export function initReminders() {
  load()
  syncReminderPromises(items)
  let changed = false
  const store = getPromiseBook()
  items = items.filter((it) => {
    const p = store.get(`reminder:${it.id}`)
    if (p?.status === 'cancelled') { changed = true; return false }
    if (p?.status === 'completed' && !it.doneAt) { it.doneAt = p.updatedAt; changed = true }
    if (p?.status === 'missed' && !it.missedAt) { it.missedAt = p.updatedAt; changed = true }
    if (p?.status === 'delivered') {
      const sentAt = p.evidence?.findLast((e) => e.kind === 'notification-dispatched')?.at || p.updatedAt
      if (it.repeat === 'none' && !it.firedAt) { it.firedAt = sentAt; changed = true }
      if (it.repeat !== 'none') {
        if (it.at <= sentAt) {
          Object.assign(it, advanceRepeat(it, sentAt))
          changed = true
        }
        rescheduleReminder(it.id, it.at, sentAt)
      }
    }
    return true
  })
  if (changed) save()
  return items.length
}

/** 列表：附带展示字段，未完成在前 */
export function listReminders(now = Date.now()) {
  initReminders()
  return sortItems(load()).map((x) => ({
    ...x,
    when: formatWhen(x.at, now),
    remain: remainingText(x.at, now),
    repeatLabel: REPEAT_LABEL[x.repeat] || REPEAT_LABEL.none,
    promiseStatus: getPromiseBook().get(`reminder:${x.id}`)?.status || 'legacy-unknown'
  }))
}

/** 待提醒（未完成）条数，供上下文注入等轻量使用 */
export function pendingReminders(now = Date.now()) {
  return sortItems(load()).filter((x) => !x.doneAt && x.at > now)
}

/** 超限淘汰：先丢已完成的（按时间从早到晚），再丢最早的 */
function enforceLimit() {
  if (items.length <= REMINDER_LIMIT) return
  const done = items.filter((x) => x.doneAt).sort((a, b) => a.at - b.at)
  for (const v of done) {
    if (items.length <= REMINDER_LIMIT) break
    items = items.filter((x) => x.id !== v.id)
  }
  while (items.length > REMINDER_LIMIT) items.shift()
}

/**
 * 新增一条提醒。
 * @param {{text:string, when?:string|number, at?:number, repeat?:string, say?:string}} input
 * @returns {{ok:boolean, item?:object, error?:string}}
 */
export function addReminder(input = {}, now = Date.now(), { sourceIds = [] } = {}) {
  initReminders()
  const text = String(input.text || '').trim()
  if (!text) return { ok: false, error: '缺少提醒内容' }

  let at = null
  if (Number.isFinite(Number(input.at))) {
    at = Number(input.at)
    if (at < 1e11) at = at * 1000 // 十位按秒
  } else if (input.when != null) {
    const p = parseWhen(input.when, now)
    if (p.error) return { ok: false, error: p.error }
    at = p.at
  } else {
    return { ok: false, error: '缺少时间（when 或 at）' }
  }
  if (!Number.isFinite(at)) return { ok: false, error: '时间无法识别' }
  if (at < now - 5000) return { ok: false, error: `这个时间已经过去了（${formatWhen(at, now)}）` }
  if (at > now + MAX_AHEAD_MS) return { ok: false, error: '时间太远了（最多一年后）' }
  if (items.length >= REMINDER_LIMIT && !items.some((x) => x.doneAt)) {
    return { ok: false, error: '提醒已满，请先完成或删除旧提醒' }
  }

  const repeat = REPEATS.includes(input.repeat) ? input.repeat : 'none'
  const item = normalizeItem({
    id: randomUUID().slice(0, 8),
    text,
    say: input.say,
    at,
    repeat,
    createdAt: now
  })
  const before = items
  items = [...items]
  items.push(item)
  enforceLimit()
  try {
    save()
    // §11.4：新建提醒若引用某条经历，必须记录可核验的来源 ID，将来遗忘时按 ID 精确判定。
    createReminderPromise(item, { sourceIds })
  } catch (err) {
    items = before
    try { save() } catch { /* 下次启动会从承诺簿与提醒文件恢复可见状态 */ }
    return { ok: false, error: `提醒未能可靠保存：${err.message}` }
  }
  return { ok: true, item }
}

/** 删除（按 id，或按内容子串匹配） */
export function removeReminder({ id, text } = {}, _now = Date.now()) {
  initReminders()
  const oldItems = items
  const before = items.length
  if (id) {
    items = items.filter((x) => x.id !== id)
  } else if (text) {
    const q = String(text).trim()
    items = items.filter((x) => !(x.text.includes(q) || q.includes(x.text)))
  } else {
    return { ok: false, error: '需要 id 或 text' }
  }
  const removed = before - items.length
  if (removed) {
    try {
      save()
      for (const it of oldItems.filter((x) => !items.some((y) => y.id === x.id))) {
        markReminder(it.id, 'cancelled', { kind: 'user-cancelled' })
      }
    } catch (err) {
      items = oldItems
      try { save() } catch { /* 下次启动可再核对 */ }
      return { ok: false, error: `取消未能可靠保存：${err.message}` }
    }
  }
  return { ok: true, removed }
}

/** 标记完成（还在列表里，但不再触发） */
export function completeReminder(id, now = Date.now()) {
  initReminders()
  const it = items.find((x) => x.id === id)
  if (!it) return { ok: false, error: '找不到该提醒' }
  const previous = it.doneAt
  it.doneAt = now
  try {
    save()
    markReminder(it.id, 'completed', { kind: 'user-confirmation' }, now)
  } catch (err) {
    it.doneAt = previous
    try { save() } catch { /* 下次启动可再核对 */ }
    return { ok: false, error: `完成状态未能可靠保存：${err.message}` }
  }
  return { ok: true }
}

/* ---------------- 调度 ---------------- */

// 2026-10-17：改为 async —— 提醒的一句话已由 LLM 现场生成（新人设无台词铁律），
// onDue 回调因此变成异步。同步回调仍完全兼容（下面判断了 thenable）。
export async function tick(log) {
  initReminders()
  const now = Date.now()

  // 一次性提醒错过太久（>12h）记为未送达，不可冒充已完成。
  // 重复提醒不在此列——advanceRepeat 会把它们推到下一次。
  let changed = false
  for (const it of items) {
    if (!it.doneAt && !it.firedAt && !it.missedAt && it.repeat === 'none' && it.at < now - STALE_MS) {
      it.missedAt = now
      markReminder(it.id, 'missed', { kind: 'expired-without-dispatch' }, now)
      changed = true
      log && log(`[reminder] 未送达且已过时：${it.text}`)
    }
  }

  if (changed) save()
  const due = items.filter((x) => isDue(x, now))
  if (!due.length) {
    return
  }
  for (const it of due) {
    const occurrenceAt = it.at
    const key = reminderOccurrenceKey(it)
    if (dispatching.has(key)) continue
    dispatching.add(key)
    try {
      let delivered = false
      try {
        const r = onDueCb?.({ ...it, when: formatWhen(it.at, now), deliveryKey: key })
        // 兼容同步（返回 boolean）与异步（返回 Promise<boolean>）两种回调
        delivered = (r && typeof r.then === 'function' ? await r : r) === true
      } catch (err) {
        log && log('[reminder] 回调失败：' + (err && err.message ? err.message : err))
      }
      if (!delivered) continue
      if (!items.includes(it) || it.doneAt || it.missedAt || it.firedAt || it.at !== occurrenceAt) continue
      markReminder(it.id, 'delivered', { kind: 'notification-dispatched' }, now)
      const next = advanceRepeat(it, now)
      if (next) {
        const idx = items.findIndex((x) => x.id === it.id)
        if (idx >= 0) items[idx] = next
      } else {
        it.firedAt = now
      }
      save()
      if (next) rescheduleReminder(it.id, next.at, now)
    } finally {
      dispatching.delete(key)
    }
  }
}

/** 自测用：塞一条几秒后到期的提醒（NAGI_SELFTEST_REMINDER=1） */
function seedSelftest(log) {
  const now = Date.now()
  items = items.filter((x) => !String(x.text).startsWith('[自测]'))
  const item = normalizeItem({ id: 'selftest', text: '[自测] 该起来喝口水了', at: now + 3000, repeat: 'none', createdAt: now })
  items.push(item)
  save()
  createReminderPromise(item)
  log && log('[reminder] 已塞入自测提醒，3 秒后到期')
}

/**
 * 启动调度器（幂等）。
 * @param {{onDue:(item:object)=>void, log?:Function, checkSec?:number}} deps
 */
export function startReminderEngine({ onDue, log = console.log, checkSec } = {}) {
  if (timer) return
  initReminders()
  onDueCb = onDue
  const selftest = process.env.NAGI_SELFTEST_REMINDER === '1'
  const sec = selftest ? 1.2 : Math.max(5, Number(checkSec) || DEFAULT_CHECK_SEC)
  if (selftest && process.env.NAGI_SELFTEST_REMINDER_SEED !== '0') seedSelftest(log)

  // tick 已是 async：这里不 await（节拍不需要等），但要兜住可能的 rejection
  // B8：调度器自己的异常不能吞——提醒是承诺，tick 崩了要有轨迹可查。
  // 仍是异步不阻塞节拍，但失败会进统一轨迹（PROMISE 类，可重试由下一拍承担）。
  timer = setInterval(() => { tick(log).catch((err) => reportCatch('reminders.tick', CATCH_CLASS.PROMISE, err)) }, Math.round(sec * 1000))
  timer.unref?.()
  log(`[reminder] 日程提醒已启动（每 ${Math.round(sec)} 秒检查一次${selftest ? '，自测模式' : ''}）`)
}

export function stopReminderEngine() {
  if (timer) clearInterval(timer)
  timer = null
  onDueCb = null
}

/* ---------------- 给 Agent 的工具形态 ---------------- */

/** 注入 createToolRunner 的三个提醒工具（返回 {ok, summary, data}） */
export function reminderTools() {
  return {
    async add(args) {
      const r = addReminder(args || {})
      if (!r.ok) return { ok: false, summary: `没能记下提醒：${r.error}` }
      const rep = r.item.repeat !== 'none' ? `（${REPEAT_LABEL[r.item.repeat]}）` : ''
      return {
        ok: true,
        summary: `已记下提醒：${r.item.text} → ${formatWhen(r.item.at)}${rep}`,
        data: { id: r.item.id, at: r.item.at }
      }
    },
    async list() {
      const pending = listReminders().filter((x) => !x.doneAt && !x.missedAt && !(x.repeat === 'none' && x.firedAt))
      if (!pending.length) return { ok: true, summary: '目前没有待提醒的事。' }
      const lines = pending.slice(0, 20).map((x) => `- [${x.id}] ${x.when}${x.repeat !== 'none' ? '（' + x.repeatLabel + '）' : ''} ${x.text}`)
      return { ok: true, summary: `待提醒 ${pending.length} 条：\n${lines.join('\n')}`, data: { count: pending.length } }
    },
    async cancel(args) {
      const r = removeReminder(args || {})
      if (!r.ok) return { ok: false, summary: r.error }
      if (!r.removed) return { ok: false, summary: '没有找到匹配的提醒。' }
      return { ok: true, summary: `已取消 ${r.removed} 条提醒。` }
    }
  }
}

/** 供 IPC 用的一行摘要（日志/调试） */
export function reminderSummaryLine(item, now = Date.now()) {
  return describeItem(item, now)
}
