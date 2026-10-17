import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_EYE_WANDER, createEyeWander } from '../src/core/face/eye.js'

function clock(t0 = 5000) {
  let t = t0
  return { now: () => t, add: (ms) => (t += ms) }
}

test('眼球会自己换注视点（不是一直不动）', () => {
  const c = clock()
  const e = createEyeWander({}, { now: c.now, rng: Math.random })
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const p = e.tick()
    seen.add(`${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    c.add(50)
  }
  assert.ok(seen.size > 5, `10 秒内应当有多个不同位置，实际只有 ${seen.size} 个`)
  assert.ok(e.stats().moves >= 2, `应当换过几次注视点，实际 ${e.stats().moves}`)
})

test('幅度不超过配置上限（别把眼珠翻到边上去）', () => {
  const c = clock()
  const e = createEyeWander({ amp: 0.5 }, { now: c.now, rng: Math.random })
  for (let i = 0; i < 400; i++) {
    const p = e.tick()
    assert.ok(Math.abs(p.x) <= 0.5 + 1e-9, `x 超界 ${p.x}`)
    assert.ok(Math.abs(p.y) <= 0.5 + 1e-9, `y 超界 ${p.y}`)
    c.add(40)
  }
})

test('停留期间完全静止（扫视是"跳一下然后停住"，不是一直在飘）', () => {
  const c = clock()
  const e = createEyeWander({ holdMs: [600, 600], glideMs: [100, 100] }, { now: c.now, rng: () => 0.9 })
  // 走到一个目标已经到达的时刻
  for (let i = 0; i < 6; i++) {
    e.tick()
    c.add(60)
  }
  const a = e.tick()
  c.add(200)
  const b = e.tick()
  assert.equal(a.x.toFixed(4), b.x.toFixed(4), '停留期不该动')
  assert.equal(a.y.toFixed(4), b.y.toFixed(4))
})

test('扫视很快到位（70~140ms 量级，不是缓慢漂）', () => {
  const c = clock()
  const e = createEyeWander({ glideMs: [80, 80], holdMs: [2000, 2000] }, { now: c.now, rng: () => 0.95 })
  // 先等到"该换注视点"的时刻（初始一次停留是 holdMs）
  c.add(2100)
  const p0 = e.tick() // 开始这一次扫视
  c.add(40)
  const p1 = e.tick()
  c.add(60)
  const p2 = e.tick()
  const moved = Math.abs(p1.x - p0.x) + Math.abs(p2.x - p1.x)
  assert.ok(moved > 0, `扫视过程中位置应当变化（p0=${p0.x} p1=${p1.x} p2=${p2.x}）`)
  // 到位之后不再变化
  c.add(300)
  const p3 = e.tick()
  c.add(200)
  const p4 = e.tick()
  assert.equal(p3.x.toFixed(4), p4.x.toFixed(4), '到位后应当静止')
})

test('左右动的范围比上下大（真人眼球也是这样）', () => {
  const c = clock()
  const e = createEyeWander({ verticalScale: 0.4, amp: 0.8 }, { now: c.now, rng: Math.random })
  let maxX = 0
  let maxY = 0
  for (let i = 0; i < 1200; i++) {
    const p = e.tick()
    maxX = Math.max(maxX, Math.abs(p.x))
    maxY = Math.max(maxY, Math.abs(p.y))
    c.add(40)
  }
  assert.ok(maxX > maxY, `横向应当比纵向大：${maxX.toFixed(2)} vs ${maxY.toFixed(2)}`)
  assert.ok(maxY <= 0.8 * 0.4 + 1e-9)
})

test('坏配置降级不抛错', () => {
  for (const bad of [null, undefined, {}, { amp: 'x' }]) {
    const c = clock()
    const e = createEyeWander(bad, { now: c.now, rng: () => 0.5 })
    const p = e.tick()
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
    assert.ok(Array.isArray(e.stats().config.glideMs))
  }
})

test('默认幅度是"能看出在动，但不至于翻白眼"', () => {
  assert.ok(DEFAULT_EYE_WANDER.amp >= 0.4 && DEFAULT_EYE_WANDER.amp <= 0.8, `amp=${DEFAULT_EYE_WANDER.amp} 不合理`)
  assert.ok(DEFAULT_EYE_WANDER.glideMs[1] <= 200, '扫视不该慢到像漂移')
})
