// src/core/monitor/throttle.js
// 凪 · 主动搭话节流（M3，纯逻辑 / 可注入时钟）。
// 三道闸：
//   ① 全局最小间隔——两次主动开口之间至少隔这么久，避免「一开口就连珠炮」
//   ② 单规则冷却——同一条规则 N 分钟内不重复
//   ③ 每日上限——同一条规则一天最多开口几次（按本地日期归零）

/** 默认全局最小间隔：3 分钟 */
export const MIN_GAP_MS = 3 * 60 * 1000

function localDayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function createThrottle({ now = () => Date.now(), minGapMs = MIN_GAP_MS } = {}) {
  const lastFire = new Map() // ruleId -> ts
  const daily = new Map() // ruleId -> { day, n }
  let lastAnyAt = 0

  /** 这条规则现在能不能开口（纯查询，不改状态） */
  function allow(rule, { gapMs = minGapMs } = {}) {
    if (!rule || !rule.id) return false
    const t = now()
    if (t - lastAnyAt < gapMs) return false
    const last = lastFire.get(rule.id) || 0
    if (t - last < (rule.cooldownMin || 0) * 60000) return false
    const dk = localDayKey(t)
    const rec = daily.get(rule.id)
    const n = rec && rec.day === dk ? rec.n : 0
    if (rule.dailyLimit && n >= rule.dailyLimit) return false
    return true
  }

  /** 记一次「已开口」（allow 通过后必须调用） */
  function note(rule) {
    if (!rule || !rule.id) return
    const t = now()
    lastFire.set(rule.id, t)
    lastAnyAt = t
    const dk = localDayKey(t)
    const rec = daily.get(rule.id)
    daily.set(rule.id, { day: dk, n: rec && rec.day === dk ? rec.n + 1 : 1 })
  }

  function reset() {
    lastFire.clear()
    daily.clear()
    lastAnyAt = 0
  }

  return { allow, note, reset }
}
