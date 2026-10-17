import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BLINK, createBlinkScheduler } from '../src/core/face/blink.js'

/** 固定随机源，方便算准 */
const fixed = (v) => () => v

function clockAt(t0 = 1000) {
  let t = t0
  return { now: () => t, add: (ms) => (t += ms), get t() { return t } }
}

test('不眨眼的时候恒为 1（睁开）', () => {
  const c = clockAt()
  const b = createBlinkScheduler({ minGapMs: 3000, maxGapMs: 3000 }, { now: c.now, rng: fixed(0) })
  for (let i = 0; i < 20; i++) {
    c.add(100)
    assert.equal(b.tick(), 1)
  }
})

test('到点会闭下去，再自己睁开（完整一次眨眼）', () => {
  const c = clockAt()
  const b = createBlinkScheduler({ minGapMs: 1000, maxGapMs: 1000, doubleChance: 0 }, { now: c.now, rng: fixed(0.5) })
  // 走到刚好该眨的时刻
  c.add(1000)
  let min = 1
  let closingSeen = false
  let openingSeen = false
  let prev = 1
  for (let i = 0; i < 40; i++) {
    const v = b.tick()
    if (v < min) min = v
    if (v < prev && v < 0.9) closingSeen = true
    if (v > prev && prev < 0.5) openingSeen = true
    prev = v
    c.add(10)
  }
  assert.ok(min <= DEFAULT_BLINK.minClose + 1e-6, `应该闭到底，实际最小 ${min}`)
  assert.ok(closingSeen, '应当看到闭眼过程')
  assert.ok(openingSeen, '应当看到睁眼过程')
  assert.equal(b.stats().count, 1)
})

test('一次眨眼的时长约等于 闭合+停顿+睁开', () => {
  const c = clockAt()
  const cfg = { minGapMs: 500, maxGapMs: 500, closeMs: 80, holdMs: 40, openMs: 120, doubleChance: 0 }
  const b = createBlinkScheduler(cfg, { now: c.now, rng: fixed(0.5) })
  c.add(500)
  // 刚进入闭合的那一帧系数还是 1（眼睑才开始动），所以看状态而不是看值
  b.tick()
  assert.equal(b.stats().phase, 'closing', '应当已经开始闭')
  c.add(20)
  assert.ok(b.tick() < 1, '闭上二十毫秒后应当小于 1')
  // 逐 10ms 走到重新完全睁开
  let back = -1
  for (let i = 0; i < 60; i++) {
    c.add(10)
    if (b.tick() >= 1) {
      back = i * 10 + 30
      break
    }
  }
  const total = cfg.closeMs + cfg.holdMs + cfg.openMs
  assert.ok(back > 0, '应当会睁开')
  assert.ok(Math.abs(back - total) <= 30, `从闭到睁应约 ${total}ms，实际 ${back}ms`)
})

test('偶尔连眨两下（双眨），间隔很短', () => {
  const c = clockAt()
  // rng 恒为 0 → 双眨概率必中，双眨间隔取下界
  const b = createBlinkScheduler({ minGapMs: 4000, maxGapMs: 4000, doubleChance: 1, doubleGapMs: [150, 300] }, { now: c.now, rng: fixed(0) })
  c.add(4000)
  let dip1 = 0
  let dip2 = 0
  let lastState = 1
  for (let i = 0; i < 120; i++) {
    const v = b.tick()
    if (v < 0.5 && lastState >= 0.5) {
      if (i * 10 <= 400) dip1++
      else dip2++
    }
    lastState = v
    c.add(10)
  }
  assert.ok(dip1 >= 1, '第一次眨眼')
  assert.ok(dip2 >= 1, `双眨应当紧接着再来一次，实际 ${dip2}`)
})

test('间隔可配：配得越短，同样时间眨得越多', () => {
  const run = (gapMs) => {
    const c = clockAt()
    const b = createBlinkScheduler({ minGapMs: gapMs, maxGapMs: gapMs, doubleChance: 0 }, { now: c.now, rng: fixed(0.5) })
    for (let i = 0; i < 300; i++) {
      c.add(50)
      b.tick()
    }
    return b.stats().count
  }
  const slow = run(5000)
  const fast = run(1000)
  assert.ok(fast > slow * 2, `1 秒间隔应远多于 5 秒：${fast} vs ${slow}`)
})

test('闭到底不会真的是 0（留一点缝，否则眼线消失）', () => {
  const c = clockAt()
  const b = createBlinkScheduler({ minGapMs: 100, maxGapMs: 100, doubleChance: 0 }, { now: c.now, rng: fixed(0.5) })
  c.add(100)
  let min = 1
  for (let i = 0; i < 40; i++) {
    min = Math.min(min, b.tick())
    c.add(10)
  }
  assert.ok(min > 0, `不该到 0，实际 ${min}`)
  assert.ok(min <= 0.05, `应当非常接近闭住，实际 ${min}`)
})

test('坏配置不会抛错，退回默认', () => {
  for (const bad of [null, undefined, {}, { minGapMs: 'x' }]) {
    const c = clockAt()
    const b = createBlinkScheduler(bad, { now: c.now, rng: fixed(0.5) })
    assert.equal(b.tick(), 1)
    assert.ok(Array.isArray(b.stats().config.doubleGapMs))
  }
})

test('reset 之后重新计时', () => {
  const c = clockAt()
  const b = createBlinkScheduler({ minGapMs: 1000, maxGapMs: 1000 }, { now: c.now, rng: fixed(0.5) })
  c.add(900)
  b.tick()
  b.reset()
  assert.equal(b.stats().count, 0)
  assert.equal(b.tick(), 1)
})
