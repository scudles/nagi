// src/core/relation/timeline.js
// 情绪时间线（S4）：把状态机里"值得记一笔"的变化采样成点，供关系页画色带、也留作日后回溯。
//
// 采样为什么要挑：状态机每 15 秒心跳一次，全记下来一天 5760 个点、既没信息量也浪费盘。
// 规则：情绪切换必记；同情绪只在强度变化超过阈值、且距上一点够久时才记。
// 文件读写（userData/timeline/YYYY-MM-DD.json）在 main/relation.js，这里只管纯逻辑。

import { localDateKey } from './familiarity.js'

export const TIMELINE = {
  MIN_GAP_MS: 60000, // 同情绪两点最小间隔（1 分钟）
  INTENSITY_STEP: 0.15, // 同情绪强度变化阈值
  MAX_POINTS_PER_DAY: 600, // 单日上限（超出丢最早的；正常远达不到）
  KEEP_DAYS: 30 // 保留天数
}

const DAY_MS = 86400000

/** 规范化一个点 → { t, mood, i }；非法返回 null */
export function normalizePoint(p) {
  if (!p || !Number.isFinite(p.t)) return null
  const mood = typeof p.mood === 'string' && p.mood ? p.mood : 'calm'
  const raw = Number(p.i)
  const i = Number.isFinite(raw) ? (raw < 0 ? 0 : raw > 1 ? 1 : raw) : 0
  return { t: p.t, mood, i }
}

/** 规范化一串点（过滤非法 + 只保留升序） */
export function normalizePoints(points) {
  const out = []
  for (const p of Array.isArray(points) ? points : []) {
    const n = normalizePoint(p)
    if (!n) continue
    if (out.length && n.t < out[out.length - 1].t) continue
    out.push(n)
  }
  return out
}

/**
 * 这一笔该不该记？
 * @param {Array<{t:number,mood:string,i:number}>} points 已有点（升序）
 * @param {{t:number,mood:string,i:number}} point
 * @param {{MIN_GAP_MS?:number,INTENSITY_STEP?:number}} [opts]
 */
export function shouldRecord(points, point, opts = {}) {
  const minGap = Number.isFinite(opts.MIN_GAP_MS) ? opts.MIN_GAP_MS : TIMELINE.MIN_GAP_MS
  const step = Number.isFinite(opts.INTENSITY_STEP) ? opts.INTENSITY_STEP : TIMELINE.INTENSITY_STEP
  const p = normalizePoint(point)
  if (!p) return false
  const list = Array.isArray(points) ? points : []
  const last = list.length ? normalizePoint(list[list.length - 1]) : null
  if (!last) return true
  if (p.t < last.t) return false // 时间倒流（改过系统时钟）→ 丢
  if (p.mood !== last.mood) return true // 情绪切换：必记
  if (p.t - last.t < minGap) return false
  return Math.abs(p.i - last.i) >= step
}

/** 追加（返回新数组；不满足规则时原样返回入参） */
export function appendPoint(points, point, opts = {}) {
  const list = Array.isArray(points) ? points : []
  if (!shouldRecord(list, point, opts)) return list
  const next = [...list, normalizePoint(point)]
  return next.length > TIMELINE.MAX_POINTS_PER_DAY ? next.slice(-TIMELINE.MAX_POINTS_PER_DAY) : next
}

/**
 * 折成可画的色段：每个点管到下一个点为止。
 * @param {Array} points
 * @param {{from:number,to:number}} range 时间窗口（毫秒时间戳）
 * @returns {Array<{from:number,to:number,mood:string,i:number}>} from/to 为 0~1 的比例
 */
export function toSegments(points, range) {
  const list = normalizePoints(points)
  const from = Number(range && range.from)
  const to = Number(range && range.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const span = to - from
  const ratio = (t) => Math.min(1, Math.max(0, (t - from) / span))
  const out = []
  for (let k = 0; k < list.length; k++) {
    const cur = list[k]
    const a = ratio(cur.t)
    const b = k + 1 < list.length ? ratio(list[k + 1].t) : 1
    if (b <= a) continue
    out.push({ from: a, to: b, mood: cur.mood, i: cur.i })
  }
  return out
}

/**
 * 逐日摘要（关系页画近 N 天迷你条）。
 * @param {Array<{date:string, points:Array}>} days
 * @returns {Array<{date:string, count:number, dominant:string, peak:number}>}
 */
export function dailyBuckets(days) {
  return (Array.isArray(days) ? days : []).map((d) => {
    const pts = normalizePoints(d && d.points)
    const count = {}
    let peak = 0
    for (const p of pts) {
      count[p.mood] = (count[p.mood] || 0) + 1
      if (p.i > peak) peak = p.i
    }
    let dominant = 'calm'
    let best = 0
    for (const [m, c] of Object.entries(count)) {
      if (c > best) {
        best = c
        dominant = m
      }
    }
    return { date: (d && d.date) || '', count: pts.length, dominant, peak }
  })
}

/** 该清掉的日期键（保留最近 keep 天，含今天） */
export function staleDates(dates, now = Date.now(), keep = TIMELINE.KEEP_DAYS) {
  const days = Math.max(1, Math.floor(keep))
  const cutoff = localDateKey(now - (days - 1) * DAY_MS)
  return (Array.isArray(dates) ? dates : []).filter((d) => typeof d === 'string' && d && d < cutoff)
}

/** 今天这个点的落盘日期键 */
export function dateKeyOf(ts) {
  return localDateKey(ts)
}
