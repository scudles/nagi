import { app } from 'electron'
import { CalendarSnapshot } from '../../core/signals/calendar-store.js'

let snapshot = null
export function getCalendarSnapshot() {
  if (!snapshot) snapshot = new CalendarSnapshot(app.getPath('userData'))
  return snapshot
}

export function upcomingCalendarContext() {
  try { return getCalendarSnapshot().context() }
  catch (err) { console.warn('[calendar] 快照不可读：', err.message); return [] }
}
