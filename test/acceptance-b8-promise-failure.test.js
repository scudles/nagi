// 独立验收复现：B8-PROMISE-01 必须从实际提醒 tick 的失败入口进入健康状态。
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-b8-promise-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })

const now = Date.now()
writeFileSync(join(userData, 'reminders.json'), JSON.stringify({ version: 1, items: [
  { id: 'fail-once', text: '验收提醒', at: now - 1000, repeat: 'none', createdAt: now - 10000 }
] }))

const { clearMaintenanceTrace, maintenanceHealth } = await import('../src/main/maintenance.js')
const { initReminders, listReminders, startReminderEngine, stopReminderEngine, tick } = await import('../src/main/reminders.js')

after(() => {
  stopReminderEngine()
  clearMaintenanceTrace()
  rmSync(userData, { recursive: true, force: true })
})

test('B8-PROMISE-01：提醒到期回调实际失败时，健康标记必须变红且保留重试', async () => {
  clearMaintenanceTrace()
  initReminders()
  let calls = 0
  startReminderEngine({ onDue: async () => { calls++; throw new Error('验收注入：系统通知失败') }, log: () => {}, checkSec: 3600 })
  await tick(() => {})
  assert.equal(calls, 1, '必须实际进入投递回调')
  assert.equal(listReminders().find((item) => item.id === 'fail-once')?.firedAt, null,
    '未送达提醒必须保持可重试')
  const health = maintenanceHealth()
  assert.equal(health.healthy, false, '实际承诺失败后设置页健康状态不能仍显示正常')
  assert.ok(health.sites.some((site) => site.site.startsWith('reminders.') && site.lastClass === 'promise'),
    '实际提醒失败需进入承诺失败轨迹')
})
