import { reportCatch, CATCH_CLASS } from '../maintenance/reporter.js'
/** 同一提醒的每次发生各有独立键；重复提醒推进 at 后得到新键。 */
export function reminderOccurrenceKey(item) {
  return `${item.id}:${item.at}`
}

/** 原文投递。通知失败时只重试失败通道，避免再次弹出已展示的正文。 */
export function createReminderDelivery({ present, notify }) {
  const states = new Map()
  return (item) => {
    if (!item?.id || !item?.text || !Number.isFinite(item.at)) return false
    const key = reminderOccurrenceKey(item)
    const state = states.get(key) || { shown: false, notified: false, unavailable: false }
    if (!state.shown) {
      try { state.shown = present(item.text, key) === true } catch (__err) { reportCatch('delivery.createReminderDelivery', CATCH_CLASS.PROMISE, __err) }
    }
    if (!state.notified && !state.unavailable) {
      try {
        const result = notify(item.text, key)
        state.notified = result === true
        state.unavailable = result === 'unavailable'
      } catch (__err) { reportCatch('delivery.createReminderDelivery', CATCH_CLASS.PROMISE, __err) }
    }
    states.set(key, state)
    return state.notified || (state.unavailable && state.shown)
  }
}
