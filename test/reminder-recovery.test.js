import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PromiseBook } from '../src/core/promises/book.js'

const userData = mkdtempSync(join(process.cwd(), '.nagi-reminder-recovery-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })
after(() => rmSync(userData, { recursive: true, force: true }))

test('通知证据已写而提醒文件未写时，重启修复而不重复通知', async () => {
  const now = Date.now()
  writeFileSync(join(userData, 'reminders.json'), JSON.stringify({ version: 1, items: [
    { id: 'once', text: '一次', at: now - 1000, repeat: 'none', createdAt: now - 10000 },
    { id: 'daily', text: '每天', at: now - 1000, repeat: 'daily', createdAt: now - 10000 }
  ] }))
  const book = new PromiseBook(userData)
  for (const id of ['once', 'daily']) {
    book.create({ id: `reminder:${id}`, kind: 'reminder', title: id, source: { type: 'reminder' }, dueAt: now - 1000 })
    book.transition(`reminder:${id}`, 'delivered', { kind: 'notification-dispatched' }, now)
  }
  const { initReminders, listReminders } = await import('../src/main/reminders.js')
  initReminders()
  const once = listReminders().find((x) => x.id === 'once')
  const daily = listReminders().find((x) => x.id === 'daily')
  assert.equal(once.firedAt, now)
  assert.equal(once.doneAt, null)
  assert.ok(daily.at > now)
  assert.equal(daily.promiseStatus, 'scheduled')
  const disk = JSON.parse(readFileSync(join(userData, 'reminders.json'), 'utf8'))
  assert.equal(disk.items.find((x) => x.id === 'once').firedAt, now)
})
