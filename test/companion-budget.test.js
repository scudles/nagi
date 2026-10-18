import test from 'node:test'
import assert from 'node:assert/strict'
import { companionConfig, mayInterrupt, normalizeBudget, noteDelivered, noteExplicitIgnore, noteUserInteraction } from '../src/core/companion/budget.js'

const AT = new Date(2026, 9, 16, 9, 0).getTime()
const CONFIG = { maxDaily: 2, minGapMinutes: 30 }

test('每日预算、勿扰与只陪着优先；跨日只重置次数', () => {
  let state = normalizeBudget({}, AT)
  assert.equal(mayInterrupt(state, { now: AT, privacy: { doNotDisturb: true }, config: CONFIG }).reason, 'dnd')
  assert.equal(mayInterrupt(state, { now: AT, privacy: { onlyPresence: true }, config: CONFIG }).reason, 'only-presence')
  assert.equal(mayInterrupt(state, { now: AT, busy: true, config: CONFIG }).reason, 'busy')
  state = noteDelivered(state, AT, CONFIG)
  assert.equal(mayInterrupt(state, { now: AT + 60000, config: CONFIG }).reason, 'backoff')
  state = noteDelivered(state, AT + 30 * 60000, CONFIG)
  assert.equal(mayInterrupt(state, { now: AT + 3 * 3600000, config: CONFIG }).reason, 'daily-budget')
  const tomorrow = AT + 86400000
  assert.equal(mayInterrupt(state, { now: tomorrow, config: CONFIG }).state.deliveredToday, 0)
})

test('无回应和明确稍后都会延长间隔；用户主动互动后退避归零', () => {
  const cfg = { ...CONFIG, maxDaily: 3 }
  let state = noteDelivered(normalizeBudget({}, AT), AT, cfg)
  const stillWaiting = mayInterrupt(state, { now: AT + 3 * 60000, config: cfg })
  assert.equal(stillWaiting.state.ignoredStreak, 0, '仅过 3 分钟不能误判为已忽略')
  const ignored = mayInterrupt(state, { now: AT + 21 * 60000, config: cfg })
  assert.equal(ignored.state.ignoredStreak, 1)
  assert.equal(ignored.reason, 'backoff')
  assert.ok(ignored.state.nextAllowedAt >= AT + 60 * 60000)
  state = noteDelivered(ignored.state, AT + 60 * 60000, cfg)
  state = noteExplicitIgnore(state, AT + 61 * 60000, cfg)
  assert.equal(state.ignoredStreak, 2)
  assert.equal(mayInterrupt(state, { now: AT + 100 * 60000, config: cfg }).reason, 'backoff')
  state = noteUserInteraction(state, AT + 101 * 60000)
  assert.equal(state.ignoredStreak, 0)
  assert.equal(state.awaitingAt, null)
  assert.equal(companionConfig({ maxDaily: 99, minGapMinutes: 1 }).maxDaily, 10)
})
