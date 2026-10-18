import { app } from 'electron'
import { calendarNow } from '../clock.js'
import { signalsDocumentIo } from '../store/document-io.js'
import { CalendarSnapshot } from '../../core/signals/calendar-store.js'

let snapshot = null
export function getCalendarSnapshot() {
  // B7（P2-05）：core 侧不再持有路径/时钟，这里注入真实端口与时钟
  if (!snapshot) snapshot = new CalendarSnapshot({ io: signalsDocumentIo(app.getPath('userData')), now: calendarNow })
  return snapshot
}

export function upcomingCalendarContext() {
  try { return getCalendarSnapshot().context() }
  catch (err) { console.warn('[calendar] 快照不可读：', err.message); return [] }
}
