// test/mood.test.js
// 情绪状态机单测（自桌宠原型 test-mood.js 重写；工厂模式 + 假时钟，无时间依赖 flaky）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMood, MOOD_PARAMS } from '../src/core/emotion/mood.js'
import { NagiPersona } from '../src/core/persona.js'

// 假时钟：起始取中午 12 点（非深夜，避免 night 推力干扰）
function fakeClock() {
  let t = new Date('2026-10-14T12:00:00').getTime()
  return { fn: () => t, advance: (ms) => { t += ms } }
}

const POKE_TEXTS = new Set(NagiPersona.poke.map((p) => p.text))
const SULLEN_TEXTS = new Set(NagiPersona.pokeSullen.map((p) => p.text))
const MONOLOGUE_TEXTS = new Set(NagiPersona.monologue)
const SULLEN_MONO_TEXTS = new Set(NagiPersona.monologueByMood.sullen)

// 浮点容差比较（强度运算有二进制误差，如 0.7 - 0.15 = 0.5499999999999999）
function close(a, b, eps = 1e-9) { return Math.abs(a - b) < eps }

test('初始状态：平静、零强度、无 LLM 提示', () => {
  const m = createMood({ now: fakeClock().fn })
  assert.equal(m.current().mood, 'calm')
  assert.equal(m.current().intensity, 0)
  assert.equal(m.label(), '平静')
  assert.equal(m.restingExpr(), 'calm')
  assert.equal(m.hintForLLM(), null)
})

test('参数表防回归：衰减/阈值/推力参数与原版一致', () => {
  assert.equal(MOOD_PARAMS.DECAY, 0.09)
  assert.equal(MOOD_PARAMS.REST_THRESHOLD, 0.35)
  assert.equal(MOOD_PARAMS.JOY_DEEP, 0.6)
  assert.equal(MOOD_PARAMS.IDLE_POUT_MIN, 25)
  assert.equal(MOOD_PARAMS.BURST_COUNT, 4)
  assert.equal(MOOD_PARAMS.HINT_THRESHOLD, 0.5)
})

test('同情绪叠加：joy 1.0 → 0.7，再 joy 0.5 → 0.95', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('joy', 1.0)
  assert.equal(m.current().mood, 'joy')
  assert.equal(m.current().intensity, 0.7)
  m.propose('joy', 0.5)
  assert.ok(close(m.current().intensity, 0.95))
})

test('异情绪强信号接管：pout 1.0 → 0.7', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0)
  assert.equal(m.current().mood, 'pout')
  assert.equal(m.current().intensity, 0.7)
})

test('异情绪弱信号只削弱不接管（粘性）', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0) // 0.7
  m.propose('joy', 0.5) // 候选 0.35 < 0.7 → 削弱 0.15
  assert.equal(m.current().mood, 'pout')
  assert.ok(close(m.current().intensity, 0.55))
})

test('接管边界：候选强度恰好等于当前才切换', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0) // 0.7
  m.propose('joy', 1.0) // 候选 0.7 >= 0.7 → 接管
  assert.equal(m.current().mood, 'joy')
  assert.equal(m.current().intensity, 0.7)
})

test('衰减：每 tick -0.09，8 tick 后归零回平静', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0) // 0.7
  for (let i = 0; i < 7; i++) m.tick()
  assert.equal(m.current().mood, 'pout') // 0.07 仍未归零
  m.tick()
  assert.equal(m.current().mood, 'calm')
  assert.equal(m.current().intensity, 0)
})

test('休息面容：joy 高强度 → 真笑', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('joy', 1.0) // 0.7 >= JOY_DEEP
  assert.equal(m.restingExpr(), 'joy')
})

test('休息面容：joy 低强度 → 微笑', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('joy', 0.5) // 候选 0.35，低于 JOY_DEEP
  assert.equal(m.restingExpr(), 'smile')
})

test('休息面容：低于阈值 → 平静（但情绪标签保留）', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('smile', 0.4) // 候选 0.28 < REST_THRESHOLD
  assert.equal(m.restingExpr(), 'calm')
  assert.equal(m.label(), '微笑')
})

test('环境推力：冷落 26 分钟 → 闹别扭', () => {
  const clock = fakeClock()
  const m = createMood({ now: clock.fn })
  m.noteInteraction()
  clock.advance(26 * 60000)
  m.tick()
  assert.equal(m.current().mood, 'pout')
  assert.equal(m.label(), '闹别扭')
  assert.equal(m.restingExpr(), 'pout') // 0.35 恰好过线
})

test('环境推力：担心时被冷落不转闹别扭（担心优先）', () => {
  const clock = fakeClock()
  clock.advance(11.5 * 3600 * 1000) // 23:30
  const m = createMood({ now: clock.fn })
  m.noteInteraction()
  m.tick() // 深夜 → worry 0.315
  assert.equal(m.current().mood, 'worry')
  clock.advance(26 * 60000) // 00:56，冷落超 25 分钟
  m.tick()
  assert.equal(m.current().mood, 'worry') // 不转 pout
  assert.ok(m.current().intensity < 0.315) // 只衰减，没重复推 worry
})

test('环境推力：深夜担心每晚只推一次', () => {
  const clock = fakeClock()
  clock.advance(11.5 * 3600 * 1000) // 23:30
  const m = createMood({ now: clock.fn })
  m.tick()
  const first = m.current().intensity
  assert.ok(first > 0.3)
  m.tick() // 同时钟再 tick
  assert.ok(m.current().intensity < first) // 没有二次加强
})

test('环境推力：早 7 点后重置，当夜再次担心', () => {
  const clock = fakeClock()
  clock.advance(11.5 * 3600 * 1000) // 23:30
  const m = createMood({ now: clock.fn })
  m.tick()
  assert.equal(m.current().mood, 'worry')
  clock.advance(8.5 * 3600 * 1000) // 次日 08:00（worry 未衰减完，idle 不推 pout）
  m.tick()
  clock.advance(15.5 * 3600 * 1000) // 次日 23:30
  m.tick()
  assert.equal(m.current().mood, 'worry') // 重置后再次推担心
})

test('环境推力：90 秒内连发 4 条 → 开心，5 分钟内不重复推', () => {
  const clock = fakeClock()
  const m = createMood({ now: clock.fn })
  for (let i = 0; i < 4; i++) m.noteInteraction()
  m.tick()
  assert.equal(m.current().mood, 'joy')
  const first = m.current().intensity
  m.tick()
  assert.ok(m.current().intensity < first) // 只衰减未重复推
})

test('独白选池：pout 时 65% 走闹别扭池，绝不离池', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0)
  let sullenHits = 0
  for (let i = 0; i < 100; i++) {
    const line = m.pickMonologue()
    assert.ok(SULLEN_MONO_TEXTS.has(line) || MONOLOGUE_TEXTS.has(line))
    if (SULLEN_MONO_TEXTS.has(line)) sullenHits++
  }
  assert.ok(sullenHits > 0, '100 次里应出现闹别扭池（65% 概率）')
})

test('独白选池：calm 时只出通用池', () => {
  const m = createMood({ now: fakeClock().fn })
  for (let i = 0; i < 50; i++) {
    assert.ok(MONOLOGUE_TEXTS.has(m.pickMonologue()))
  }
})

test('戳一击选池：pout 时 60% 更冷，calm 时只出通用池', () => {
  const m = createMood({ now: fakeClock().fn })
  for (let i = 0; i < 50; i++) {
    assert.ok(POKE_TEXTS.has(m.pickPoke().text))
  }
  m.propose('pout', 1.0)
  let sullenHits = 0
  for (let i = 0; i < 100; i++) {
    const r = m.pickPoke()
    assert.ok(SULLEN_TEXTS.has(r.text) || POKE_TEXTS.has(r.text))
    if (SULLEN_TEXTS.has(r.text)) sullenHits++
  }
  assert.ok(sullenHits > 0, '100 次里应出现闹别扭戳击（60% 概率）')
})

test('LLM 提示：强度过线才给中文情绪名', () => {
  const m = createMood({ now: fakeClock().fn })
  assert.equal(m.hintForLLM(), null)
  m.propose('joy', 1.0) // 0.7 >= 0.5
  assert.equal(m.hintForLLM(), '开心')
  const m2 = createMood({ now: fakeClock().fn })
  m2.propose('smile', 0.4) // 0.28 < 0.5
  assert.equal(m2.hintForLLM(), null)
})

test('label 六情绪中文映射', () => {
  const cases = { calm: '平静', puzzled: '疑惑', smile: '微笑', worry: '担心', pout: '闹别扭', joy: '开心' }
  for (const [mood, label] of Object.entries(cases)) {
    const m = createMood({ now: fakeClock().fn })
    m.propose(mood, 1.0)
    assert.equal(m.label(), label)
  }
})

test('onChange 观察者：propose 后收到快照', () => {
  const m = createMood({ now: fakeClock().fn })
  const seen = []
  m.onChange((s) => seen.push(s))
  m.propose('joy', 1.0)
  assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(seen[0]).sort(), ['expr', 'intensity', 'label', 'mood'])
  assert.equal(seen[0].label, '开心')
  assert.equal(seen[0].expr, 'joy')
})

test('无效情绪名被忽略', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('angry', 1.0)
  assert.equal(m.current().mood, 'calm')
  assert.equal(m.current().intensity, 0)
})
