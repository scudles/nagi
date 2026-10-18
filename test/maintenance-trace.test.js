// test/maintenance-trace.test.js
// B8（P2-04）：失败轨迹的**有界 / 脱敏 / 可删**与后果分类上报。
//
// 保护的不变量：
//   1) 轨迹有上限，绝不无限长（超出丢最旧，并保留丢弃计数）；
//   2) 消息脱敏：打掉绝对路径、截断超长内容，不把用户路径写进轨迹；
//   3) clear() 之后内存里不留副本；
//   4) 只有 degrade 类可以静默；其余四类必须\"出声\"（warn）；
//   5) 非法分类回退 degrade，不抛错。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventTrace, redactMessage } from '../src/core/maintenance/event-trace.js'
import {
  CATCH_CLASS,
  createCatchReporter,
  createHealthRegistry,
  isCatchClass,
  mustSurface
} from '../src/core/maintenance/catch-audit.js'

test('脱敏：绝对路径打码、超长截断', () => {
  assert.equal(redactMessage('E:\\凪\\userData\\rag\\meta.json 读不到'), '[path] 读不到')
  assert.equal(redactMessage('/Users/kugua/Library/x.log failed'), '[path] failed')
  assert.equal(redactMessage('/home/nagi/.config/x'), '[path]')
  const long = redactMessage('x'.repeat(500))
  assert.ok(long.length <= 121, '超长消息必须截断')
  assert.ok(long.endsWith('…'))
  assert.equal(redactMessage(null), '')
})

test('有界：超过 limit 丢最旧，并记丢弃数', () => {
  const t = createEventTrace({ limit: 3, now: () => 1000 })
  for (let i = 0; i < 5; i++) t.push({ site: 's' + i, cls: 'degrade', message: 'm' + i })
  assert.equal(t.size(), 3)
  assert.equal(t.dropped(), 2)
  assert.deepEqual(t.list().map((e) => e.site), ['s2', 's3', 's4'])
  assert.deepEqual(t.list(2).map((e) => e.site), ['s3', 's4'])
})

test('list 返回副本，外部改动不污染轨迹', () => {
  const t = createEventTrace({ limit: 5 })
  t.push({ site: 'a', cls: 'degrade', message: 'x' })
  const first = t.list()
  first[0].site = 'hacked'
  assert.equal(t.list()[0].site, 'a')
})

test('可删：clear 之后为空，再 push 重新计数', () => {
  const t = createEventTrace({ limit: 3 })
  t.push({ site: 'a', cls: 'degrade', message: 'x' })
  t.clear()
  assert.equal(t.size(), 0)
  assert.deepEqual(t.list(), [])
  assert.equal(t.dropped(), 0)
  t.push({ site: 'b', cls: 'degrade', message: 'y' })
  assert.equal(t.size(), 1)
})

test('推送时会补齐时间与默认分类，且消息脱敏', () => {
  const t = createEventTrace({ limit: 5, now: () => 42 })
  const e = t.push({ site: 'rag.read', cls: 'must-persist', message: 'E:\\secret\\a.txt 打不开' })
  assert.equal(e.at, 42)
  assert.equal(e.cls, 'must-persist')
  assert.equal(e.message, '[path] 打不开')
  assert.equal(t.push(null), null)
})

test('后果分类：只有 degrade 可静默，其余必须出声', () => {
  assert.equal(mustSurface(CATCH_CLASS.DEGRADE), false)
  for (const cls of [CATCH_CLASS.VISIBLE, CATCH_CLASS.MUST_PERSIST, CATCH_CLASS.PROMISE, CATCH_CLASS.SEMANTIC]) {
    assert.equal(mustSurface(cls), true, cls)
  }
  assert.equal(isCatchClass('must-persist'), true)
  assert.equal(isCatchClass('whatever'), false)
})

test('上报器：按类写轨迹并决定是否 warn；非法分类回退 degrade', () => {
  const trace = createEventTrace({ limit: 10, now: () => 7 })
  const warned = []
  const report = createCatchReporter({ trace, warn: (m) => warned.push(m), now: () => 7 })

  const quiet = report('cache.write', CATCH_CLASS.DEGRADE, new Error('EACCES: E:\\a\\b.json'))
  assert.equal(quiet.surfaced, false)
  assert.equal(warned.length, 0, 'degrade 不出声')
  assert.equal(trace.list()[0].message, 'EACCES: [path]', '轨迹里也不许留路径')

  const loud = report('reminders.tick', CATCH_CLASS.PROMISE, new Error('boom'))
  assert.equal(loud.surfaced, true)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /catch:promise/)
  assert.match(warned[0], /reminders\.tick/)

  const fallback = report('x', 'unknown-class', new Error('e'))
  assert.equal(fallback.cls, CATCH_CLASS.DEGRADE)
  assert.equal(warned.length, 1, '回退成 degrade 后不出声')

  assert.equal(trace.size(), 3)
  assert.throws(() => createCatchReporter({}), /trace/)
})

/* ---------------- B8：健康状态（承诺失败可重试 + 健康） ---------------- */

test('健康状态：按站点累计，最近一次的类别决定是否健康', () => {
  const health = createHealthRegistry({ maxSites: 3, now: () => 100 })
  health.record('reminders.tick', CATCH_CLASS.PROMISE, 'boom')
  health.record('reminders.tick', CATCH_CLASS.DEGRADE, 'warn only')
  const snap = health.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].count, 2)
  assert.equal(snap[0].lastClass, CATCH_CLASS.DEGRADE, '最后一次是降级 → 视为恢复')
  assert.equal(health.healthy(), true)

  // 用 String.raw：普通字面量里 '\a' '\b' 是 JS 转义，会把路径吃掉或变成退格符
  health.record('rag.write', CATCH_CLASS.MUST_PERSIST, String.raw`E:\data\x.json 写不进`)
  assert.equal(health.healthy(), false)
  assert.equal(health.snapshot().find((s) => s.site === 'rag.write').lastMessage, '[path] 写不进', '健康状态也要脱敏')

  health.reset()
  assert.deepEqual(health.snapshot(), [])
})

test('健康状态：站点数有上限，未知分类回退 degrade', () => {
  const health = createHealthRegistry({ maxSites: 2, now: () => 1 })
  health.record('a', 'weird', 'x')
  health.record('b', CATCH_CLASS.PROMISE, 'y')
  health.record('c', CATCH_CLASS.PROMISE, 'z')
  assert.equal(health.snapshot().length, 2)
  assert.equal(health.healthy(), false)
})

test('上报器接健康状态：degrade 不出声但也要记录', () => {
  const trace = createEventTrace({ limit: 5 })
  const health = createHealthRegistry({ maxSites: 5 })
  const warned = []
  const report = createCatchReporter({ trace, health, warn: (m) => warned.push(m) })
  report('cache.write', CATCH_CLASS.DEGRADE, new Error('miss'))
  assert.equal(warned.length, 0)
  assert.equal(health.snapshot()[0].count, 1)
  assert.equal(trace.size(), 1)
})
