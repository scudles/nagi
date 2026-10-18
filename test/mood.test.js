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

// 2026-10-17 新人设《灵魂与程序》：台词池已整体移除，下面这四个集合作废。
// 独白与戳一戳都不再出句子——心里的话由 LLM 生成，戳一下只用表情和动作。
// 这几条测试因此改为**钉住"不再出句子"**这个新契约，防止有人把池子加回来。

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

test('独白不再出句子（心里的话交给 LLM 现场生成）', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('pout', 1.0)
  for (let i = 0; i < 100; i++) {
    assert.equal(m.pickMonologue(), null, '状态机不该再提供任何独白句子')
  }
})

test('独白：任何情绪下都不出句子', () => {
  const m = createMood({ now: fakeClock().fn })
  for (const mood of ['calm', 'puzzled', 'smile', 'worry', 'pout', 'joy', 'liminal', 'tender', 'distant']) {
    m.propose(mood, 1.0)
    assert.equal(m.pickMonologue(), null, `${mood} 时不该有独白句子`)
  }
})

test('戳一击不再出声，但表情与动作照给（含闹别扭时的别开脸）', () => {
  const m = createMood({ now: fakeClock().fn })
  for (let i = 0; i < 50; i++) {
    const r = m.pickPoke()
    assert.equal(r.text, null, '戳一下不该出声')
    assert.ok(r.expr, '表情仍要给')
  }
  m.propose('pout', 1.0)
  let awayHits = 0
  for (let i = 0; i < 100; i++) {
    const r = m.pickPoke()
    assert.equal(r.text, null)
    if (r.turn === 'away') awayHits++
  }
  assert.ok(awayHits > 0, '闹别扭时应有别开脸的动作（不出声但态度在）')
})

test('宕机（liminal）衰减比常规慢，停得住', () => {
  const clock = fakeClock()
  const m = createMood({ now: clock.fn })
  m.propose('liminal', 1.0)
  const before = m.current().intensity
  clock.advance(15000)
  m.tick()
  // 与常量绑定而不是写死数字：以后调 LIMINAL_DECAY 不会让这条测试假失败
  const decayed = before - m.current().intensity
  assert.ok(
    Math.abs(decayed - MOOD_PARAMS.LIMINAL_DECAY) < 1e-9,
    `liminal 一个心跳应只衰减 ${MOOD_PARAMS.LIMINAL_DECAY}，实际 ${decayed}`
  )
  assert.ok(
    MOOD_PARAMS.LIMINAL_DECAY < MOOD_PARAMS.DECAY,
    'liminal 必须比常规情绪衰减得慢，否则宕机的停顿留不住'
  )
  assert.equal(m.current().mood, 'liminal', '一个心跳不该就淡回平静')
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
  // B5：快照多带两个归因字段（这次变化是谁推的、是否用户互动）
  assert.deepEqual(Object.keys(seen[0]).sort(), ['expr', 'intensity', 'label', 'mood', 'source', 'userInteraction'])
  assert.equal(seen[0].label, '开心')
  assert.equal(seen[0].expr, 'joy')
  assert.equal(seen[0].source, 'propose')
  assert.equal(seen[0].userInteraction, true)
})

/* ---------------- B5：情绪裁决统一（归因 / 冷落计时 / 离线衰减） ---------------- */

test('B5：idle 推力不刷新 lastInteraction（否则冷落计时自己把自己清零）', () => {
  const clock = fakeClock()
  const m = createMood({ now: clock.fn })
  m.propose('joy', 0.2, 'user') // 先有一次真正的互动
  const interactedAt = m.serialize().lastInteraction

  // 冷落门槛 + 一分钟，触发 pout 推力
  clock.advance(MOOD_PARAMS.IDLE_POUT_MIN * 60000 + 60000)
  m.tick()

  assert.equal(m.current().mood, 'pout')
  assert.equal(m.current().source, 'idle')
  assert.equal(m.current().userInteraction, false)
  // 关键：互动时间没被 idle 推力改写，冷落仍然从用户那次算起
  assert.equal(m.serialize().lastInteraction, interactedAt)
})

test('B5：night 推力也是环境事件，不算用户互动', () => {
  // 深夜 00:30 起表
  let t = new Date('2026-10-14T00:30:00').getTime()
  const m = createMood({ now: () => t })
  m.propose('joy', 0.2, 'user')
  const interactedAt = m.serialize().lastInteraction
  t += MOOD_PARAMS.TICK_MS
  m.tick()
  assert.equal(m.current().mood, 'worry')
  assert.equal(m.current().userInteraction, false)
  assert.equal(m.serialize().lastInteraction, interactedAt)
})

test('B5：liminal 在线与离线衰减同一条曲线（重启不会把停顿抹掉）', () => {
  const clock = fakeClock()
  const m = createMood({ now: clock.fn })
  m.propose('liminal', 1.0, 'user')
  const before = m.current().intensity
  clock.advance(MOOD_PARAMS.TICK_MS)
  m.tick()
  const onlineDrop = before - m.current().intensity

  // 同样的强度与同样的离线时长，restore 后的下降幅度必须一致
  const savedAt = clock.fn()
  const restored = createMood({ now: () => savedAt + MOOD_PARAMS.TICK_MS })
  const ok = restored.restore({ mood: 'liminal', intensity: before, savedAt, lastInteraction: savedAt })
  assert.equal(ok, true)
  const offlineDrop = before - restored.current().intensity
  assert.ok(close(onlineDrop, offlineDrop), `在线 ${onlineDrop} vs 离线 ${offlineDrop}`)
  assert.ok(close(onlineDrop, MOOD_PARAMS.LIMINAL_DECAY))
  assert.equal(restored.current().mood, 'liminal')
})

test('无效情绪名被忽略', () => {
  const m = createMood({ now: fakeClock().fn })
  m.propose('angry', 1.0)
  assert.equal(m.current().mood, 'calm')
  assert.equal(m.current().intensity, 0)
})
