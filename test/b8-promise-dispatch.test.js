// test/b8-promise-dispatch.test.js
// B8-PROMISE-01 蓝区补充：**只从调度入口**验证提醒失败的健康状态与恢复。
//
// 为什么单独一个文件（而不是并进 acceptance-b8-promise-failure.test.js）：
// 绿区那份用例是独立验收资产，蓝区保持逐字原样（见该文件），
// 自己的补充断言放这里，避免绿区复验时看到被改过的期望。
//
// 这里刻意**不**直接调用 reportCatch —— 那样测的是"上报器好不好用"，
// 而不是"提醒真的没送到时，系统有没有如实变红"。全部用例都走
// startReminderEngine({onDue}) + tick() 这条真实链路。
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 每个用例一个独立 profile：模块级 items/book 是进程内单例，必须靠新目录隔离 */
let userData = mkdtempSync(join(tmpdir(), 'nagi-b8-dispatch-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })

const { clearMaintenanceTrace, maintenanceHealth, maintenanceTrace } = await import('../src/main/maintenance.js')
const remindersUrl = '../src/main/reminders.js'

/** 造一条"已经到期"的提醒，并换一个全新的 reminders 模块实例读它 */
async function freshReminders(id, text) {
  userData = mkdtempSync(join(tmpdir(), 'nagi-b8-dispatch-'))
  const at = Date.now() - 1000
  writeFileSync(join(userData, 'reminders.json'), JSON.stringify({ version: 1, items: [
    { id, text, at, repeat: 'none', createdAt: at - 10000 }
  ] }))
  const mod = await import(`${remindersUrl}?case=${id}`)
  mod.initReminders()
  return mod
}

after(() => {
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

test('B8-PROMISE-D1：回调返回 false（没抛错但也没送达）同样记承诺失败并保留重试', async () => {
  clearMaintenanceTrace()
  const mod = await freshReminders('false-once', '蓝区补充：回调返回 false')
  let calls = 0
  mod.startReminderEngine({ onDue: async () => { calls++; return false }, log: () => {}, checkSec: 3600 })
  await mod.tick(() => {})
  assert.equal(calls, 1, '必须真的进入投递回调')

  assert.equal(mod.listReminders().find((i) => i.id === 'false-once')?.firedAt, null,
    '没送达就不许记 firedAt，否则用户以为提醒过了')
  let health = maintenanceHealth()
  assert.equal(health.healthy, false, '回调返回 false 也是承诺失败，健康状态不能仍显示正常')
  assert.ok(health.sites.some((s) => s.site.startsWith('reminders.') && s.lastClass === 'promise'),
    '要落到 reminders.* 站点、类别为 promise')
  mod.stopReminderEngine()

  // 下一拍成功：既要用掉这次重试，也要把状态恢复
  mod.startReminderEngine({ onDue: async () => { calls++; return true }, log: () => {}, checkSec: 3600 })
  await mod.tick(() => {})
  assert.equal(calls, 2, '重试要真的再投一次，不是把上次的失败糊过去')
  assert.notEqual(mod.listReminders().find((i) => i.id === 'false-once')?.firedAt, null, '成功后要记 firedAt')
  health = maintenanceHealth()
  assert.equal(health.healthy, true, '成功送达后健康状态必须恢复')
  mod.stopReminderEngine()
})

test('B8-PROMISE-D2：抛错 → 变红 → 恢复后要有明确的恢复状态（不是把记录删掉）', async () => {
  clearMaintenanceTrace()
  const mod = await freshReminders('throw-once', '蓝区补充：回调抛错')
  let calls = 0
  mod.startReminderEngine({ onDue: async () => { calls++; throw new Error('验收注入：系统通知失败') }, log: () => {}, checkSec: 3600 })
  await mod.tick(() => {})
  assert.equal(calls, 1)
  assert.equal(mod.listReminders().find((i) => i.id === 'throw-once')?.firedAt, null, '失败必须保留可重试')

  // 再失败一次：次数要累计，"反复红"才看得出来
  await mod.tick(() => {})
  assert.equal(calls, 2, '每次到期都要重新投递')
  let health = maintenanceHealth()
  assert.equal(health.healthy, false)
  const red = health.sites.find((s) => s.site === 'reminders.dispatch')
  assert.ok(red && red.lastClass === 'promise' && red.count >= 2, '两次失败都要计入，便于看出"反复红"')
  mod.stopReminderEngine()

  mod.startReminderEngine({ onDue: async () => { calls++; return true }, log: () => {}, checkSec: 3600 })
  await mod.tick(() => {})
  assert.equal(calls, 3, '恢复后要重新投递')

  health = maintenanceHealth()
  assert.equal(health.healthy, true, '恢复后不再报红')
  const site = health.sites.find((s) => s.site === 'reminders.dispatch')
  assert.ok(site, '站点记录要留着：刚红过又好了，不能和从没红过长得一样')
  assert.equal(site.lastClass, null, '恢复后 lastClass 归零')
  assert.ok(Number.isFinite(site.recoveredAt) && site.recoveredAt > 0, '要有明确的恢复时间戳')
  assert.ok(site.count >= 2, '失败次数要跨恢复保留，不能一恢复就清零')
  mod.stopReminderEngine()
})

test('B8-PROMISE-D3：失败消息与恢复说明都不带提醒正文（健康快照会被 IPC 读走）', async () => {
  clearMaintenanceTrace()
  const SECRET = '蓝区私密日程：预约心理医生'
  const mod = await freshReminders('secret-once', SECRET)
  mod.startReminderEngine({
    onDue: async () => { throw new Error(`投递失败，提醒内容：${SECRET}`) },
    log: () => {}, checkSec: 3600
  })
  await mod.tick(() => {})
  const failed = maintenanceTrace(50).filter((t) => t.site === 'reminders.dispatch')
  assert.ok(failed.length >= 1, '要进轨迹')
  for (const t of failed) assert.ok(!t.message.includes(SECRET), '轨迹消息不得含提醒正文')
  const bad = maintenanceHealth().sites.find((s) => s.site === 'reminders.dispatch')
  assert.ok(bad && !bad.lastMessage.includes(SECRET), '健康快照消息不得含提醒正文')
  mod.stopReminderEngine()

  // 恢复说明同样不能带正文
  mod.startReminderEngine({ onDue: async () => true, log: () => {}, checkSec: 3600 })
  await mod.tick(() => {})
  const site = maintenanceHealth().sites.find((s) => s.site === 'reminders.dispatch')
  assert.ok(site && !site.lastMessage.includes(SECRET), '恢复说明不得含提醒正文')
  mod.stopReminderEngine()
})
