import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createReminderDelivery } from '../src/core/reminders/delivery.js'

test('原文同时进入展示和系统通知；同一次发生只投递一次，失败可重试', () => {
  const shown = [], notified = []
  let fail = true
  const deliver = createReminderDelivery({
    present: (text, key) => { shown.push([text, key]); return false },
    notify: (text, key) => { notified.push([text, key]); return !fail }
  })
  const item = { id: 'r1', at: 123, text: '原始提醒正文' }
  assert.equal(deliver(item), false)
  fail = false
  assert.equal(deliver(item), true)
  assert.equal(deliver(item), true)
  assert.deepEqual(shown, Array(3).fill(['原始提醒正文', 'r1:123']))
  assert.deepEqual(notified, Array(2).fill(['原始提醒正文', 'r1:123']))
  assert.equal(deliver({ ...item, at: 456 }), true, '重复提醒的新发生可再次送达')
})

test('窗口已展示但系统通知失败时，只重试通知且不重复展示', () => {
  let shown = 0, notified = 0
  const deliver = createReminderDelivery({
    present: () => { shown++; return true },
    notify: () => { notified++; return notified > 1 }
  })
  const item = { id: 'r2', at: 123, text: '原文' }
  assert.equal(deliver(item), false)
  assert.equal(deliver(item), true)
  assert.equal(shown, 1)
  assert.equal(notified, 2)
})

// B1 · 作者裁决 A（CONTRACTS「作者裁决登记 · 裁决 A」，2026-10-18 冻结）：
// 勿扰只抑制表达层（桌面气泡），**重要提醒照常发系统通知**，不被勿扰阻断。
// 这里把口径钉在投递层：present 被勿扰挡掉时，只要通知发出，这次发生就算已送达。
test('裁决 A：勿扰关掉气泡时，重要提醒仍靠系统通知送达', () => {
  const notified = []
  let presentCalls = 0
  const deliver = createReminderDelivery({
    present: () => { presentCalls++; return false }, // 勿扰：saySomething 直接返回 false
    notify: (text, key) => { notified.push([text, key]); return true }
  })
  const item = { id: 'r-dnd', at: 999, text: '两点的会' }
  assert.equal(deliver(item), true, '气泡没发也要算送达')
  assert.deepEqual(notified, [['两点的会', 'r-dnd:999']])
  assert.equal(presentCalls, 1, '仍尝试过展示（不能因为勿扰就跳过整条链路）')
})

test('裁决 A 的边界：通知不可用且气泡被勿扰挡住时，不算送达（留给下一轮重试）', () => {
  const deliver = createReminderDelivery({
    present: () => false,
    notify: () => 'unavailable' // 系统不支持通知
  })
  const item = { id: 'r-dnd2', at: 999, text: '两点的会' }
  assert.equal(deliver(item), false, '两条通道都没成，不能伪报已送达')
})

const userData = mkdtempSync(join(process.cwd(), '.nagi-reminder-delivery-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })
after(() => rmSync(userData, { recursive: true, force: true }))

test('调度回调未完成时重入 tick 不会重复发送同一次提醒', async () => {
  const { addReminder, listReminders, startReminderEngine, stopReminderEngine, tick } = await import('../src/main/reminders.js')
  const added = addReminder({ text: '只发一次', at: Date.now() - 1000 })
  assert.equal(added.ok, true)
  let release
  const held = new Promise((resolve) => { release = resolve })
  let calls = 0
  startReminderEngine({ onDue: async (item) => {
    calls++
    assert.equal(item.deliveryKey, `${item.id}:${item.at}`)
    await held
    return true
  }, log: () => {} })
  try {
    const first = tick()
    await tick()
    assert.equal(calls, 1)
    release()
    await first
    await tick()
    assert.equal(calls, 1)
    assert.ok(listReminders().find((x) => x.id === added.item.id).firedAt)
  } finally { stopReminderEngine() }
})
