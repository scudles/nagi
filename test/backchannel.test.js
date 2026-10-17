// test/backchannel.test.js
// 非语言语气音（回合首尾）纯决策层单测。
//
// 覆盖：默认零影响、概率上限、有意留白、时段/勿扰压制、每日配额、最小间隔、
// 跨日归零、候选抽取不退化、脏输入安全、状态不可变。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKCHANNEL_LIMITS,
  BACKCHANNEL_LIBRARY,
  emptyBackchannelState,
  normalizeBackchannelState,
  resetBackchannelState,
  decideBackchannel
} from '../src/core/voice/backchannel.js'
import { DEFAULT_VOICE_SETTINGS, mergeVoiceSettings } from '../src/shared/voice-protocol.js'

/** 固定序列的随机数：测试完全确定，不依赖 Math.random */
const seqRng = (...values) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}
const constRng = (v) => () => v

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0) // 2026-10-17 20:00 (UTC+8)
const ON = { enabled: true, probability: 1 }
/** 关掉节流，专测"能不能出声"（节流本身另有单测） */
const ON_NO_THROTTLE = { enabled: true, probability: 1, minIntervalMs: 0, perDayMax: 100 }

test('默认不发声：开关未开 / 概率为 0 都零影响', () => {
  const s = emptyBackchannelState()
  assert.equal(decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state: s, config: {} }).reason, 'disabled')
  assert.equal(decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state: s, config: { enabled: false, probability: 1 } }).reason, 'disabled')
  assert.equal(decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state: s, config: { enabled: true } }).reason, 'probability-zero')
  assert.equal(decideBackchannel({ phase: 'end', mood: 'calm', now: T0, state: s, config: { enabled: true, probability: 0 } }).reason, 'probability-zero')
  // 连默认都没配时也不能出声
  assert.equal(decideBackchannel({ phase: 'start', now: T0, state: s }).reason, 'disabled')
})

// 「默认关闭」写在注释里不算数——要有一条测试盯着，哪天有人把它默认打开会立刻红。
test('出厂默认必须关闭：默认设置与缺项合并后都绝不发声', () => {
  assert.equal(DEFAULT_VOICE_SETTINGS.backchannel.enabled, false, '出厂不能默认开启语气音')
  assert.equal(DEFAULT_VOICE_SETTINGS.backchannel.probability, 0, '出厂概率必须是 0')
  const merged = mergeVoiceSettings({})
  assert.equal(merged.backchannel.enabled, false)
  assert.equal(decideBackchannel({
    phase: 'start', mood: 'calm', now: T0, state: emptyBackchannelState(),
    config: merged.backchannel, rng: constRng(0)
  }).text, null)
  // 旧配置（压根没有 backchannel 键）升级上来也不能突然发声
  const legacy = mergeVoiceSettings({ ttsEnabled: true })
  assert.equal(decideBackchannel({
    phase: 'end', mood: 'worry', now: T0, state: emptyBackchannelState(),
    config: legacy.backchannel, rng: constRng(0)
  }).text, null)
})

test('概率上限在代码里夹住：配成 0.9 也不会变成口头禅', () => {
  const s = emptyBackchannelState()
  // 实际生效上限 0.3，roll = 0.5 → 不通过
  const r = decideBackchannel({
    phase: 'start', mood: 'calm', now: T0, state: s,
    config: { enabled: true, probability: 0.9 }, rng: constRng(0.5)
  })
  assert.equal(r.text, null)
  assert.equal(r.reason, 'not-this-time')
  // 同一个 roll 在 0.3 以下就通过
  const r2 = decideBackchannel({
    phase: 'start', mood: 'calm', now: T0, state: s,
    config: { enabled: true, probability: 0.9 }, rng: constRng(0.1)
  })
  assert.equal(r2.reason, 'ok')
  assert.ok(BACKCHANNEL_LIMITS.probabilityMax <= 0.3)
})

test('开启后 start / end 都能出声，且文本必在候选库内', () => {
  let state = emptyBackchannelState()
  const seen = new Set()
  for (const phase of ['start', 'end']) {
    for (const mood of Object.keys(BACKCHANNEL_LIBRARY.start)) {
      const r = decideBackchannel({
        phase, mood, now: T0 + seen.size, state,
        config: ON_NO_THROTTLE, rng: constRng(0)
      })
      const pool = BACKCHANNEL_LIBRARY[phase][mood]
      if (!pool.length) {
        assert.equal(r.text, null, `${phase}/${mood} 有意留白`)
        assert.equal(r.reason, 'no-candidate')
        continue
      }
      assert.ok(r.text, `${phase}/${mood} 应出声`)
      assert.ok(pool.some((c) => c.text === r.text), `文本应来自候选库：${r.text}`)
      seen.add(r.text)
      state = r.state
    }
  }
})

test('有意留白：闹别扭不接话（start）、开心收尾干脆（end）', () => {
  const s = emptyBackchannelState()
  assert.equal(decideBackchannel({ phase: 'start', mood: 'pout', now: T0, state: s, config: ON, rng: constRng(0) }).reason, 'no-candidate')
  assert.equal(decideBackchannel({ phase: 'end', mood: 'joy', now: T0, state: s, config: ON, rng: constRng(0) }).reason, 'no-candidate')
  // 但闹别扭在结尾是有声音的（哼）
  const r = decideBackchannel({ phase: 'end', mood: 'pout', now: T0, state: s, config: ON, rng: constRng(0) })
  assert.equal(r.reason, 'ok')
  assert.equal(r.kind, 'hmph')
})

test('夜晚默认压制，allowAtNight 才放开', () => {
  const s = emptyBackchannelState()
  const night = decideBackchannel({ phase: 'start', mood: 'calm', period: 'night', now: T0, state: s, config: ON, rng: constRng(0) })
  assert.equal(night.reason, 'quiet-night')
  const allowed = decideBackchannel({ phase: 'start', mood: 'calm', period: 'night', now: T0, state: s, config: { ...ON, allowAtNight: true }, rng: constRng(0) })
  assert.equal(allowed.reason, 'ok')
  // 白天不受影响
  assert.equal(decideBackchannel({ phase: 'start', mood: 'calm', period: 'noon', now: T0, state: s, config: ON, rng: constRng(0) }).reason, 'ok')
})

test('勿扰优先于一切：即使 allowAtNight 也闭嘴', () => {
  const s = emptyBackchannelState()
  const r = decideBackchannel({
    phase: 'start', mood: 'calm', period: 'night', quiet: true, now: T0, state: s,
    config: { ...ON, allowAtNight: true }, rng: constRng(0)
  })
  assert.equal(r.text, null)
  assert.equal(r.reason, 'do-not-disturb')
})

test('每日配额：用完当天不再出声，跨日自动归零', () => {
  let state = emptyBackchannelState()
  const perDayMax = 2
  const cfg = { ...ON, perDayMax, minIntervalMs: 0 }
  for (let i = 0; i < perDayMax; i++) {
    const r = decideBackchannel({ phase: 'start', mood: 'calm', now: T0 + i * 1000, state, config: cfg, rng: constRng(0) })
    assert.equal(r.reason, 'ok', `第 ${i + 1} 次应通过`)
    state = r.state
  }
  const blocked = decideBackchannel({ phase: 'start', mood: 'calm', now: T0 + 9999, state, config: cfg, rng: constRng(0) })
  assert.equal(blocked.reason, 'daily-limit')

  // 跨日：计数清零，又能出声（lastAt 保留以维持间隔节奏）
  const nextDay = T0 + 24 * 60 * 60 * 1000
  const next = decideBackchannel({ phase: 'start', mood: 'calm', now: nextDay, state, config: cfg, rng: constRng(0) })
  assert.equal(next.reason, 'ok')
  assert.equal(next.state.count, 1)
  assert.match(next.state.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.notEqual(next.state.day, state.day, '跨日应产生新的日键')
})

test('最小间隔：连着两句不会都加语气音', () => {
  let state = emptyBackchannelState()
  const cfg = { ...ON, perDayMax: 10, minIntervalMs: 3 * 60 * 1000 }
  const first = decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state, config: cfg, rng: constRng(0) })
  assert.equal(first.reason, 'ok')
  state = first.state
  const soon = decideBackchannel({ phase: 'end', mood: 'calm', now: T0 + 1000, state, config: cfg, rng: constRng(0) })
  assert.equal(soon.reason, 'too-soon')
  const later = decideBackchannel({ phase: 'end', mood: 'calm', now: T0 + 4 * 60 * 1000, state, config: cfg, rng: constRng(0) })
  assert.equal(later.reason, 'ok')
})

test('候选抽取不退化：多候选时两个都能被抽到', () => {
  // calm/start 有两个候选；概率拉满、连续掷不同随机数，两个都应出现
  const pool = BACKCHANNEL_LIBRARY.start.calm
  assert.ok(pool.length >= 2, '本测试依赖 calm/start 至少两个候选')
  const got = new Set()
  let state = emptyBackchannelState()
  for (let i = 0; i < 40; i++) {
    const rng = seqRng(0, i / 40) // 第一次掷骰（门槛）恒 0，第二次（选候选）扫过 [0,1)
    const r = decideBackchannel({
      phase: 'start', mood: 'calm', now: T0 + i * 10 * 60 * 1000, state,
      config: { ...ON, perDayMax: 100, minIntervalMs: 0 }, rng
    })
    if (r.text) got.add(r.text)
    state = r.state
  }
  for (const c of pool) assert.ok(got.has(c.text), `候选未被抽到：${c.text}（实际 ${[...got]}）`)
})

test('位置与情绪的非法值：不出声，且不抛错', () => {
  const s = emptyBackchannelState()
  for (const phase of ['middle', '', null, 42, undefined]) {
    assert.equal(decideBackchannel({ phase, mood: 'calm', now: T0, state: s, config: ON, rng: constRng(0) }).text, null)
  }
  // 未知情绪按 calm 处理（仍能出声），不是静默丢弃
  assert.equal(decideBackchannel({ phase: 'start', mood: 'anger', now: T0, state: s, config: ON, rng: constRng(0) }).reason, 'ok')
  // 入参整体非法
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(decideBackchannel(bad).text, null)
  }
})

test('状态：不可变、脏数据可恢复、reset 后当天计数从 0 开始', () => {
  const snapshot = emptyBackchannelState()
  const frozen = JSON.parse(JSON.stringify(snapshot))
  const r = decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state: snapshot, config: ON, rng: constRng(0) })
  assert.equal(r.reason, 'ok')
  assert.deepEqual(snapshot, frozen, '传入的 state 不得被就地修改')

  // 脏状态：类型全错也不能崩
  const dirty = normalizeBackchannelState({ day: 123, count: 'x', lastAt: 'y', lastText: 7 })
  assert.deepEqual(dirty, { day: '', count: 0, lastAt: 0, lastText: '', lastKind: '' })
  assert.equal(decideBackchannel({ phase: 'start', mood: 'calm', now: T0, state: { count: -5, day: null }, config: ON, rng: constRng(0) }).reason, 'ok')

  const fresh = resetBackchannelState(T0)
  assert.equal(fresh.count, 0)
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fresh.day))
})

test('全组合扫描：要么 null，要么是库内文本；从不抛错', () => {
  const phases = [...Object.keys(BACKCHANNEL_LIBRARY), 'bogus', null]
  const moods = [...Object.keys(BACKCHANNEL_LIBRARY.start), 'bogus', null]
  const periods = ['night', 'morning', 'noon', null, 'bogus']
  let emitted = 0
  let blocked = 0
  for (const phase of phases) {
    for (const mood of moods) {
      for (const period of periods) {
        for (const quiet of [false, true]) {
          const r = decideBackchannel({
            phase, mood, period, quiet, now: T0, state: emptyBackchannelState(),
            config: { enabled: true, probability: 0.3, minIntervalMs: 0 }, rng: constRng(0)
          })
          assert.ok(r && typeof r.reason === 'string')
          assert.ok(r.state && Number.isFinite(r.state.count))
          if (r.text === null) { blocked++; continue }
          emitted++
          const pool = (BACKCHANNEL_LIBRARY[phase] || {})[mood] || (BACKCHANNEL_LIBRARY[phase] || {}).calm || []
          assert.ok(pool.some((c) => c.text === r.text), `文本越界：${r.text}`)
          assert.ok(r.text.length <= 6, `语气音必须极短：${r.text}`)
        }
      }
    }
  }
  assert.ok(emitted > 0 && blocked > 0, `两种结果都要覆盖到：emitted=${emitted} blocked=${blocked}`)
})
