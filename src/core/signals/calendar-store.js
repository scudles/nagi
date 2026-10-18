// src/core/signals/calendar-store.js
// 日历快照：用户导入 ICS 后她才知道"他今天有什么安排"（只读、随时可撤销）。
// 纯逻辑：文本 → 事件 → 上下文；落盘走注入的文档端口（B7 P2-05，core 不碰 fs）。
import { assertPorts } from '../store/document-io.js'
import { calendarContext, parseCalendar } from './calendar.js'

/** 文档键；真实路径（signals/calendar.ics 等）由 main 侧登记 */
export const CALENDAR_ICS_KEY = 'calendar-ics'
export const CALENDAR_META_KEY = 'calendar-meta'

const MAX_ICS_BYTES = 2 * 1024 * 1024

/** 取文件名：不用 node:path，core 侧连路径形状都不必知道 */
function fileStem(name) {
  const parts = String(name || 'calendar.ics').split(/[\\/]/)
  return parts[parts.length - 1] || 'calendar.ics'
}

export class CalendarSnapshot {
  constructor({ io, now } = {}) {
    assertPorts('CalendarSnapshot', { io, now }, ['io', 'now'])
    this.io = io
    this.now = now
  }

  importText(text, sourceName, at = this.now()) {
    if (Buffer.byteLength(String(text || ''), 'utf8') > MAX_ICS_BYTES) throw new Error('日历文件超过 2MB')
    const parsed = parseCalendar(text, at)
    this.io.write(CALENDAR_ICS_KEY, text)
    this.io.write(CALENDAR_META_KEY, JSON.stringify({
      version: 1, importedAt: at,
      sourceName: fileStem(sourceName), total: parsed.total,
      unsupported: parsed.unsupported
    }))
    return this.status(at)
  }

  status(now = this.now()) {
    const ics = this.io.read(CALENDAR_ICS_KEY)
    const metaRaw = this.io.read(CALENDAR_META_KEY)
    if (ics === null || metaRaw === null) return { authorized: false, events: [] }
    const meta = JSON.parse(metaRaw)
    const parsed = parseCalendar(ics, now)
    return { authorized: true, importedAt: meta.importedAt, sourceName: meta.sourceName,
      total: parsed.total, unsupported: parsed.unsupported, events: parsed.events.slice(0, 20) }
  }

  context(now = this.now()) {
    return calendarContext(this.status(now).events, now)
  }

  revoke() {
    this.io.remove(CALENDAR_ICS_KEY)
    this.io.remove(CALENDAR_META_KEY)
    return { authorized: false, events: [] }
  }
}
