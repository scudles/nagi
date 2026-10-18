import test from 'node:test'
import assert from 'node:assert/strict'
import { createReunionCoordinator } from '../src/core/agent/reunion-coordinator.js'

test('归来已安排 defer 后再次触发，下一次仍可进入生成且不留控制器', async () => {
  const reunion = createReunionCoordinator()
  let calls = 0
  assert.equal(await reunion.run({ shouldDefer: () => true, work: async () => { calls++ } }), false)
  assert.equal(reunion.active, false)
  assert.equal(await reunion.run({ shouldDefer: () => false, work: async () => { calls++; return true } }), true)
  assert.equal(calls, 1)
  assert.equal(reunion.active, false)
})

test('归来生成中重入受阻；拒绝后释放控制器，后续可再次触发', async () => {
  const reunion = createReunionCoordinator()
  let rejectWork
  const running = reunion.run({ shouldDefer: () => false, work: () => new Promise((_resolve, reject) => { rejectWork = reject }) })
  assert.equal(reunion.active, true)
  assert.equal(await reunion.run({ shouldDefer: () => false, work: async () => true }), false)
  rejectWork(new Error('provider failed'))
  await assert.rejects(running, /provider failed/)
  assert.equal(reunion.active, false)
  assert.equal(await reunion.run({ shouldDefer: () => false, work: async () => true }), true)
})
