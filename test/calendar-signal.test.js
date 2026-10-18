import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCalendar, calendarContext } from '../src/core/signals/calendar.js'
import { CalendarSnapshot, CALENDAR_ICS_KEY, CALENDAR_META_KEY } from '../src/core/signals/calendar-store.js'
import { createMemoryDocumentIo } from '../src/core/store/document-io.js'

const now = Date.UTC(2026, 9, 16, 0, 0, 0)
const ics = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:meeting-1',
  'DTSTART;TZID=Asia/Shanghai:20261016T100000',
  'DTEND;TZID=Asia/Shanghai:20261016T110000',
  'SUMMARY:和朋友见', ' 面', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:repeat-1', 'DTSTART:20261017T090000Z',
  'SUMMARY:重复任务', 'RRULE:FREQ=DAILY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cancel-1', 'DTSTART:20261017T100000Z',
  'SUMMARY:取消的事', 'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR'
].join('\r\n') + '\r\n'

test('日历只读解析折行与时区；重复和取消事件不被编造成今日事实', () => {
  const parsed = parseCalendar(ics, now)
  assert.equal(parsed.total, 3)
  assert.equal(parsed.unsupported, 1)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].title, '和朋友见面')
  assert.equal(parsed.events[0].startsAt, Date.UTC(2026, 9, 16, 2, 0, 0))
  assert.match(calendarContext(parsed.events, now)[0], /计划（不是已经发生的共同经历）/)
  assert.throws(() => parseCalendar('not ics', now), /不是有效/)
})

test('日历快照本地保存、重新装载与撤销后上下文消失', () => {
  // B7（P2-05）：io 端口与时钟都注入；两个 CalendarSnapshot 共用同一个端口即代表"同一份落盘"
  const io = createMemoryDocumentIo()
  const opened = () => new CalendarSnapshot({ io, now: () => now })
  const first = opened()
  assert.equal(first.status(now).authorized, false)
  const imported = first.importText(ics, '个人日历.ics', now)
  assert.equal(imported.authorized, true)
  assert.equal(imported.sourceName, '个人日历.ics')
  assert.equal(opened().context(now).length, 1)
  first.revoke()
  assert.equal(opened().status(now).authorized, false)
  assert.deepEqual(opened().context(now), [])
  // 撤销后两份文档都必须消失（只删 meta 会留下"看得见的 ICS 原文"）
  assert.equal(io.read(CALENDAR_ICS_KEY), null)
  assert.equal(io.read(CALENDAR_META_KEY), null)
})

test('导入只认文件名，不接受路径穿越（core 侧连 path 都不引入）', () => {
  const io = createMemoryDocumentIo()
  const snapshot = new CalendarSnapshot({ io, now: () => now })
  const imported = snapshot.importText(ics, 'C:\\Users\\某人\\Desktop\\周计划.ics', now)
  assert.equal(imported.sourceName, '周计划.ics')
  assert.doesNotMatch(JSON.stringify(snapshot.status(now)), /C:\\\\Users|Desktop/)
})
