// RFC 5545 的有限只读子集：单次 VEVENT。无法可靠解释的事件直接跳过并计数。
import { requireNow } from '../clock.js'

const unescapeText = (s) => String(s || '').replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1')

function zonedDate(parts, zone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const target = Date.UTC(...parts)
    let guess = target
    for (let i = 0; i < 3; i++) {
      const actual = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, Number(p.value)]))
      const wall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
      guess += target - wall
    }
    const actual = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, Number(p.value)]))
    return Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) === target ? guess : null
  } catch { return null }
}

function parseDate(prop) {
  if (!prop) return null
  const value = prop.value
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)]
  const allDay = !m[4]
  let at
  if (m[7]) at = Date.UTC(...parts)
  else if (prop.tzid) at = zonedDate(parts, prop.tzid)
  else at = new Date(...parts).getTime()
  if (!Number.isFinite(at)) return null
  const d = new Date(at)
  if (m[7] && (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() !== parts[1] || d.getUTCDate() !== parts[2])) return null
  return { at, allDay }
}

export function parseCalendar(text, now) {
  const at = requireNow(now, 'parseCalendar')
  if (typeof text !== 'string' || !/^BEGIN:VCALENDAR\s*$/mi.test(text)) throw new Error('不是有效的 iCalendar 文件')
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const raw = []
  let event = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { event = {}; continue }
    if (line === 'END:VEVENT') { if (event) raw.push(event); event = null; continue }
    if (!event) continue
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const [name, ...params] = line.slice(0, colon).split(';')
    const prop = { value: line.slice(colon + 1), tzid: params.find((p) => /^TZID=/i.test(p))?.slice(5) || null }
    event[name.toUpperCase()] = prop
  }
  const events = []
  let unsupported = 0
  for (const item of raw) {
    if (item.STATUS?.value === 'CANCELLED') continue
    if (item.RRULE || item['RECURRENCE-ID'] || item.RDATE || item.EXDATE) { unsupported++; continue }
    const start = parseDate(item.DTSTART)
    const end = parseDate(item.DTEND)
    if (!start || (item.DTEND && !end)) { unsupported++; continue }
    const title = unescapeText(item.SUMMARY?.value).trim().slice(0, 160)
    if (!title) { unsupported++; continue }
    if (end && end.at < at || (!end && start.at < at)) continue
    events.push({ id: String(item.UID?.value || `${start.at}:${title}`).slice(0, 160), title,
      startsAt: start.at, endsAt: end?.at || null, allDay: start.allDay })
  }
  events.sort((a, b) => a.startsAt - b.startsAt)
  return { events, total: raw.length, unsupported }
}

export function calendarContext(events, now) {
  const at = requireNow(now, 'calendarContext')
  const until = at + 48 * 3600000
  return events.filter((e) => e.startsAt >= at && e.startsAt <= until).slice(0, 3).map((e) =>
    `用户授权的日历计划（不是已经发生的共同经历）：${new Date(e.startsAt).toLocaleString('zh-CN')} ${e.title}`)
}
