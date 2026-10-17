// test/reaction-engine.test.js
// 引擎编排层的回归锁（用假模型，不联网）：
//   ① 只在闸门放行时才调模型（不满足条件一次都不该调）；
//   ② 校验后的动作被正确分发到 onSustain / onFlash / onSay；
//   ③ **失败与超时也要记账**，否则会连着重试把配额打满；
//   ④ 没配模型时归还额度（不算"想过"），下次还能试；
//   ⑤ 模型输出垃圾时不会把表现下发出去（宁可不做）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReactionEngine } from '../src/main/reaction.js'
import { createThinkGate } from '../src/core/presence/reaction.js'

const FLASH = ['star', 'flower']
const GOOD = JSON.stringify({
  read: '他在写代码',
  feel: 'worry',
  strength: 0.4,
  mode: 'sustain',
  flash: null,
  why: '坐太久了',
  say: null
})

function harness({ model = async () => GOOD, gateCfg = {}, now = () => 1_700_000_000_000, timeoutMs } = {}) {
  const out = { sustain: [], flash: [], says: [], logs: [] }
  const gate = createThinkGate({ minGapMs: 0, hourMax: 99, dayMax: 99, ...gateCfg }, { now })
  const engine = createReactionEngine({
    getContext: () => ({ hour: 14, moodLabel: '平静', flashOptions: FLASH, talkedToday: 2 }),
    callModel: model,
    onSustain: (r) => out.sustain.push(r),
    onFlash: (r) => out.flash.push(r),
    onSay: (r) => out.says.push(r),
    log: (m) => out.logs.push(m),
    now,
    timeoutMs,
    gate
  })
  return { engine, out, gate }
}

test('闸门放行 → 调模型 → 校验后的持续表情被下发', async () => {
  const { engine, out } = harness()
  const r = await engine.observe({ category: 'work', sinceMs: 35 * 60000 })
  assert.equal(r.ran, true)
  assert.equal(r.act, 'sustain')
  assert.equal(out.sustain.length, 1)
  assert.equal(out.sustain[0].feel, 'worry')
  assert.ok(out.sustain[0].strength > 0 && out.sustain[0].strength <= 0.6)
  assert.equal(out.flash.length, 0)
  assert.equal(out.says.length, 0, '模型没给 say 就不该说话')
})

test('闸门不放行 → 一次模型都不调', async () => {
  let calls = 0
  const { engine } = harness({
    model: async () => {
      calls++
      return GOOD
    },
    gateCfg: { minGapMs: 60 * 60 * 1000 }
  })
  await engine.observe({ category: 'work' })
  await engine.observe({ category: 'video' }) // 间隔不够
  assert.equal(calls, 1, `只该调 1 次，实际 ${calls}`)
})

test('闪回：模型给 flash → 下发 onFlash，不走情绪', async () => {
  const flashJson = JSON.stringify({ read: '他在看视频', feel: null, strength: 0, mode: 'flash', flash: 'star', why: '有意思', say: null })
  const { engine, out } = harness({ model: async () => flashJson })
  const r = await engine.observe({ category: 'video' })
  assert.equal(r.act, 'flash')
  assert.equal(out.flash.length, 1)
  assert.equal(out.flash[0].flash, 'star')
  assert.equal(out.sustain.length, 0)
})

test('模型说"不做" → 什么都不下发', async () => {
  const noneJson = JSON.stringify({ read: '他在写代码', feel: null, strength: 0, mode: 'sustain', why: '没什么特别的', say: null })
  const { engine, out } = harness({ model: async () => noneJson })
  const r = await engine.observe({ category: 'work' })
  assert.equal(r.act, 'none')
  assert.equal(out.sustain.length + out.flash.length + out.says.length, 0)
})

test('没有可用模型 → 不算想过（归还额度），下次还能试', async () => {
  let calls = 0
  const { engine } = harness({
    model: async () => {
      calls++
      return null
    },
    gateCfg: { minGapMs: 60 * 60 * 1000 }
  })
  const r1 = await engine.observe({ category: 'work' })
  assert.equal(r1.ran, false)
  assert.equal(r1.reason, 'no-model')
  // 因为没记账，第二次即使间隔为 0 也应当可以再试
  const gate0 = createThinkGate({ minGapMs: 0 }, { now: () => Date.now() })
  assert.ok(gate0.shouldThink({ category: 'work' }))
  assert.equal(engine.state().skippedNoModel, 1)
  assert.equal(calls, 1)
})

test('模型抛错 → 记账（不重试打满配额），且不影响别的东西', async () => {
  let calls = 0
  const { engine, out } = harness({
    model: async () => {
      calls++
      throw new Error('网络断了')
    },
    gateCfg: { minGapMs: 60 * 60 * 1000 }
  })
  const r = await engine.observe({ category: 'work' })
  assert.equal(r.ran, false)
  assert.equal(r.reason, 'error')
  assert.equal(calls, 1)
  assert.equal(out.sustain.length + out.flash.length, 0)
  // 记账之后同样的条件不会再触发
  const r2 = await engine.observe({ category: 'video' })
  assert.equal(r2.ran, false)
  assert.equal(calls, 1, '失败后不该立刻重试')
})

test('模型输出不是 JSON → 丢弃，不下发任何表现', async () => {
  const { engine, out } = harness({ model: async () => '我觉得他有点累了，应该担心一下。' })
  const r = await engine.observe({ category: 'work' })
  assert.equal(r.ran, false)
  assert.equal(r.reason, 'bad-json')
  assert.equal(out.sustain.length + out.flash.length + out.says.length, 0)
})

test('模型幻想出不存在的微表情 → 不下发', async () => {
  const bad = JSON.stringify({ mode: 'flash', flash: '彩虹眼', strength: 0.9, why: 'x' })
  const { engine, out } = harness({ model: async () => bad })
  const r = await engine.observe({ category: 'work' })
  assert.equal(r.act, 'none')
  assert.equal(out.flash.length, 0)
})

test('模型给了短句且当次有表现 → 才说话', async () => {
  const withSay = JSON.stringify({ feel: 'worry', strength: 0.45, mode: 'sustain', why: '坐太久', say: '起来走两步吧。' })
  const { engine, out } = harness({ model: async () => withSay })
  await engine.observe({ category: 'work' })
  assert.equal(out.says.length, 1)
  assert.equal(out.says[0].text, '起来走两步吧。')
})

test('模型给了短句但决定"不做" → 不说话（别凭白打扰）', async () => {
  const sayButNone = JSON.stringify({ feel: null, strength: 0, mode: 'sustain', say: '在忙吗？' })
  const { engine, out } = harness({ model: async () => sayButNone })
  await engine.observe({ category: 'work' })
  assert.equal(out.says.length, 0)
})

test('并发调用不会同时问两次模型', async () => {
  let calls = 0
  let release
  const gate0 = new Promise((r) => (release = r))
  const { engine } = harness({
    model: async () => {
      calls++
      await gate0
      return GOOD
    },
    gateCfg: { minGapMs: 0 }
  })
  const p1 = engine.observe({ category: 'work' })
  const p2 = engine.observe({ category: 'work' })
  assert.equal((await p2).reason, 'busy', '第二次应当被挡在 busy 外面')
  release()
  await p1
  assert.equal(calls, 1)
})

test('思考过程被记下来（工作台要显示"她刚才在想什么"）', async () => {
  const { engine } = harness()
  await engine.observe({ category: 'work' })
  const t = engine.lastThought()
  assert.ok(t, '应当留下一条记录')
  assert.equal(t.act, 'sustain')
  assert.ok(t.read.length > 0, '应当记下她"注意到什么"')
  assert.ok(t.why.length > 0, '应当记下"为什么"')
  assert.equal(t.reason, 'switch')
})

test('超时会中断并记账（不能让一次卡死的请求把引擎冻住）', async () => {
  const { engine } = harness({
    model: () => new Promise(() => {}), // 永不 resolve
    gateCfg: { minGapMs: 60 * 60 * 1000 },
    timeoutMs: 80
  })
  const r = await engine.observe({ category: 'work' })
  assert.equal(r.ran, false)
  assert.equal(r.reason, 'error')
  assert.equal(engine.state().busy, false, '超时后引擎必须解锁，否则再也不想了')
})
