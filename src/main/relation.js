// src/main/relation.js
// 关系层服务（S4）：关系统计的装配与记账 + 情绪时间线的按天落盘。
//
// 两类数据：
//   relation.json      —— { firstMetAt, interactionCount, activeDays[], lastActiveDay }（熟悉度的原料）
//   timeline/YYYY-MM-DD.json —— { version, date, points:[{t,mood,i}] }（情绪时间线，保留 30 天）
// 判定逻辑全在 core/relation/*（纯函数），这里只做 IO 与装配。

import { app } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import { join } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { emptyStats, normalizeStats, noteInteraction, describeRelation } from '../core/relation/familiarity.js'
import { normalizePoints, appendPoint, dailyBuckets, staleDates, TIMELINE, dateKeyOf } from '../core/relation/timeline.js'
import { loadRelationStats, saveRelationStats } from './persist.js'
import { recordLedger } from './ledger.js'

const DAY_MS = 86400000
/** 单次清理上限：避免一次删掉太多文件（也避开"单回合批量删除"类保护） */
const PRUNE_BATCH = 20

let stats = null
let today = { date: null, points: [] } // 今日时间线内存缓存（写盘前不必重复读文件）

const timelineDir = () => join(app.getPath('userData'), 'timeline')
const fileOf = (date) => join(timelineDir(), `${date}.json`)

/* ---------------- 关系统计 ---------------- */

/** 启动时装配；首次见面则建一份新的 */
export function initRelation(now = Date.now()) {
  const saved = loadRelationStats()
  stats = saved ? normalizeStats(saved, now) : emptyStats(now)
  if (!saved) saveRelationStats(stats)
  const r = describeRelation(stats, now)
  console.log(
    `[relation] ${saved ? '已恢复' : '初次见面'}：${r.level.label}（${Math.round(r.score * 100)}%）` +
      `，认识 ${r.daysKnown} 天、活跃 ${r.activeDays} 天、聊过 ${r.interactionCount} 次`
  )
  return stats
}

/** 记一次互动（他说话 / 戳她）。互动只加次数与当天活跃，不直接加分 */
export function noteRelationInteraction(now = Date.now()) {
  if (!stats) initRelation(now)
  stats = noteInteraction(stats, now)
  saveRelationStats(stats)
  recordLedger({ category: 'aggregate', text: `关系统计：互动累计 ${stats.interactionCount} 次。`,
    source: { type: 'relation-live', ref: `${now}:${stats.interactionCount}` }, occurredAt: now,
    certainty: 'aggregate', meta: { interactionCount: stats.interactionCount } })
  return stats
}

/** 关系摘要（IPC / 上下文注入共用一份口径） */
export function relationSummary(now = Date.now()) {
  if (!stats) initRelation(now)
  return describeRelation(stats, now)
}

/* ---------------- 情绪时间线 ---------------- */

function readDay(date) {
  try {
    const raw = JSON.parse(readFileSync(fileOf(date), 'utf8'))
    return normalizePoints(raw && raw.points)
  } catch {
    return []
  }
}

function ensureToday(date) {
  if (today.date === date) return
  today = { date, points: readDay(date) }
}

function pointsOf(date) {
  return today.date === date ? today.points : readDay(date)
}

function flushToday() {
  try {
    mkdirSync(timelineDir(), { recursive: true })
    writeFileSync(fileOf(today.date), JSON.stringify({ version: 1, date: today.date, points: today.points }), 'utf8')
  } catch (err) {
    console.error('[timeline] 写入失败：', err && err.message)
  }
}

/**
 * 记一个情绪点（采样规则在 core/relation/timeline.js，不满足则一次盘都不写）。
 * @param {{mood:string,intensity:number}} snapshot
 * @returns {boolean} 是否记下了
 */
export function recordMoodPoint(snapshot, now = Date.now()) {
  if (!snapshot || !snapshot.mood) return false
  const date = dateKeyOf(now)
  ensureToday(date)
  const next = appendPoint(today.points, { t: now, mood: snapshot.mood, i: snapshot.intensity })
  if (next === today.points) return false
  today.points = next
  flushToday()
  recordLedger({ category: 'subjective', text: `凪当时的情绪采样：${snapshot.mood}`,
    source: { type: 'timeline-live', ref: String(now) }, occurredAt: now,
    certainty: 'system-estimate', meta: { intensity: snapshot.intensity } })
  return true
}

/**
 * 读最近 n 天（含今天），旧→新排列，供关系页画色带。
 * @returns {{days:Array<{date:string,points:Array}>, buckets:Array, keepDays:number}}
 */
export function readTimeline(days = 7, now = Date.now()) {
  const n = Math.max(1, Math.min(60, Math.floor(Number(days)) || 7))
  ensureToday(dateKeyOf(now))
  const list = []
  for (let i = n - 1; i >= 0; i--) {
    const date = dateKeyOf(now - i * DAY_MS)
    list.push({ date, points: pointsOf(date) })
  }
  return { days: list, buckets: dailyBuckets(list), keepDays: TIMELINE.KEEP_DAYS }
}

/** 清掉保留期之外的时间线文件（每次启动跑一次；单次有上限） */
export function pruneTimeline(now = Date.now()) {
  try {
    const dir = timelineDir()
    if (!existsSync(dir)) return []
    const dates = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
    const dead = staleDates(dates, now).slice(0, PRUNE_BATCH)
    let removed = 0
    for (const d of dead) {
      try {
        unlinkSync(fileOf(d))
        removed++
      } catch (__err) { reportCatch('relation.pruneTimeline', CATCH_CLASS.MUST_PERSIST, __err) }
    }
    if (removed) console.log(`[timeline] 清理 ${removed} 个过期日期文件（保留最近 ${TIMELINE.KEEP_DAYS} 天）`)
    return dead.slice(0, removed)
  } catch (err) {
    console.warn('[timeline] 清理失败：', err && err.message)
    return []
  }
}

/** 重置今日缓存（设置页"重新认识"后调用） */
export function resetTimelineCache() {
  today = { date: null, points: [] }
}
