import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { calendarContext, parseCalendar } from './calendar.js'

const MAX_ICS_BYTES = 2 * 1024 * 1024

export class CalendarSnapshot {
  constructor(userDataDir) {
    this.dir = join(userDataDir, 'signals')
    this.ics = join(this.dir, 'calendar.ics')
    this.meta = join(this.dir, 'calendar.json')
  }

  importText(text, sourceName, at = Date.now()) {
    if (Buffer.byteLength(String(text || ''), 'utf8') > MAX_ICS_BYTES) throw new Error('日历文件超过 2MB')
    const parsed = parseCalendar(text, at)
    mkdirSync(this.dir, { recursive: true })
    const tempIcs = this.ics + '.' + randomUUID() + '.tmp'
    const tempMeta = this.meta + '.' + randomUUID() + '.tmp'
    writeFileSync(tempIcs, text, 'utf8')
    writeFileSync(tempMeta, JSON.stringify({ version: 1, importedAt: at,
      sourceName: basename(String(sourceName || 'calendar.ics')), total: parsed.total,
      unsupported: parsed.unsupported }), 'utf8')
    renameSync(tempIcs, this.ics)
    renameSync(tempMeta, this.meta)
    return this.status(at)
  }

  status(now = Date.now()) {
    if (!existsSync(this.ics) || !existsSync(this.meta)) return { authorized: false, events: [] }
    const meta = JSON.parse(readFileSync(this.meta, 'utf8'))
    const parsed = parseCalendar(readFileSync(this.ics, 'utf8'), now)
    return { authorized: true, importedAt: meta.importedAt, sourceName: meta.sourceName,
      total: parsed.total, unsupported: parsed.unsupported, events: parsed.events.slice(0, 20) }
  }

  context(now = Date.now()) {
    return calendarContext(this.status(now).events, now)
  }

  revoke() {
    rmSync(this.ics, { force: true })
    rmSync(this.meta, { force: true })
    return { authorized: false, events: [] }
  }
}
