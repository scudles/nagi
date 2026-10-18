// test/maintenance-health.test.js
// B8 可见性（CONTRACTS §12 / EVAL §3.11）：B8-HEALTH / PERSIST / PROMISE / DEGRADE / SEMANTIC。
//
// [policy] + [mock-io] 混合：健康状态本身是纯内存对象，但"设置页有状态标记"要落到
// 真实的 HTML 与 IPC 契约上——否则实现改了界面，测试还绿着（验收脚本自己会烂的老问题）。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CATCH_CLASS } from '../src/core/maintenance/catch-audit.js'
import {
  clearMaintenanceTrace,
  maintenanceHealth,
  maintenanceTrace,
  reportCatch
} from '../src/main/maintenance.js'
import { MAINTENANCE_IPC } from '../src/shared/protocol.js'

const ROOT = process.cwd()
const html = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')
const renderer = readFileSync(join(ROOT, 'src/renderer/js/main.js'), 'utf8')
const preload = readFileSync(join(ROOT, 'src/preload/index.js'), 'utf8')

after(() => clearMaintenanceTrace())

test('B8-HEALTH-01：主进程有只读健康 API，且 IPC 契约存在', () => {
  clearMaintenanceTrace()
  const health = maintenanceHealth()
  assert.equal(health.healthy, true)
  assert.deepEqual(health.sites, [])
  assert.ok(Array.isArray(maintenanceTrace(5)))
  // IPC 只读两件事：查健康、清记录
  assert.equal(MAINTENANCE_IPC.HEALTH, 'maintenance:health')
  assert.equal(MAINTENANCE_IPC.CLEAR, 'maintenance:clear')
  assert.match(preload, /maintenance:\s*\{[\s\S]*?health:/, 'preload 必须暴露 maintenance.health')
  assert.match(preload, /invoke\(MAINTENANCE_IPC\.HEALTH\)/)
})

test('B8-PERSIST-01：持久化失败 → 健康变红、进轨迹、设置页有状态标记', () => {
  clearMaintenanceTrace()
  reportCatch('rag.store-io.readText', CATCH_CLASS.MUST_PERSIST, new Error('EACCES: E:\\x\\y.json 读不到'))
  const health = maintenanceHealth()
  assert.equal(health.healthy, false, '持久化失败不能是"健康"')
  const site = health.sites.find((s) => s.site === 'rag.store-io.readText')
  assert.ok(site, '健康状态里要有这个站点')
  assert.equal(site.lastClass, CATCH_CLASS.MUST_PERSIST)
  assert.equal(site.lastMessage.includes('E:\\x\\y.json'), false, '健康状态必须脱敏')
  // 轨迹同样可查
  assert.equal(maintenanceTrace(5)[0].cls, CATCH_CLASS.MUST_PERSIST)

  // 设置页真的有一块状态区（不是只 console.warn）
  assert.match(html, /id="maint-status"/, '设置页必须有维护状态标记位')
  assert.match(html, /id="maint-trace"/)
  assert.match(renderer, /refreshMaintStatus/, '打开设置时必须刷新这块状态')
  assert.match(renderer, /window\.nagi\.maintenance\.health\(\)/)
})

test('B8-PROMISE-01：承诺失败 → 可重试语义 + 健康状态反映，不静默', () => {
  clearMaintenanceTrace()
  const r = reportCatch('reminders.tick', CATCH_CLASS.PROMISE, new Error('boom'))
  assert.equal(r.surfaced, true, '承诺失败必须出声')
  assert.equal(maintenanceHealth().healthy, false)
  const site = maintenanceHealth().sites.find((s) => s.site === 'reminders.tick')
  assert.equal(site.count, 1)
  // 重试由下一拍承担：再报一次同一站点，计数增长而不是消失
  reportCatch('reminders.tick', CATCH_CLASS.PROMISE, new Error('boom again'))
  assert.equal(maintenanceHealth().sites.find((s) => s.site === 'reminders.tick').count, 2)
  // 恢复后（下一次成功不写健康），手工用 degrade 一次也可视为降级——但真正的恢复口径是
  // "最近一次是 degrade"，所以这里断言的是：它不会因为一次成功就自动清除历史计数
  assert.equal(maintenanceHealth().sites.length, 1)
})

test('B8-DEGRADE-01：可降级错误只进轨迹，不进"坏"名单、不打扰', () => {
  clearMaintenanceTrace()
  const r = reportCatch('cache.write', CATCH_CLASS.DEGRADE, new Error('miss'))
  assert.equal(r.surfaced, false, '可降级不该出声')
  const health = maintenanceHealth()
  assert.equal(health.healthy, true, '可降级不应让健康变红')
  assert.equal(health.sites[0].lastClass, CATCH_CLASS.DEGRADE)
  // 界面上不会把它列进"出过问题"
  assert.match(renderer, /lastClass !== 'degrade'/)
})

test('B8-SEMANTIC-01：语义失败要明确失败，不伪装成功', () => {
  clearMaintenanceTrace()
  const r = reportCatch('llm.parse', CATCH_CLASS.SEMANTIC, new Error('unexpected token'))
  assert.equal(r.surfaced, true)
  assert.equal(maintenanceHealth().healthy, false)
  assert.equal(maintenanceHealth().sites[0].lastClass, CATCH_CLASS.SEMANTIC)
})

test('清空是"可删"：清掉后轨迹与健康一起归零', () => {
  reportCatch('a.b', CATCH_CLASS.MUST_PERSIST, new Error('x'))
  assert.ok(maintenanceTrace(10).length > 0)
  clearMaintenanceTrace()
  assert.equal(maintenanceTrace(10).length, 0)
  assert.deepEqual(maintenanceHealth().sites, [])
  assert.equal(maintenanceHealth().healthy, true)
})
