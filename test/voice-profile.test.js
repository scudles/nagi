// test/voice-profile.test.js
// BLUE-1 单测：语音情绪参数映射（core 纯函数 + 扩展接线 + hooks 契约兼容）。
//
// 覆盖任务书卡 B 的验收点：
//   - 每种情绪 × 关键时段的输出参数约束（方向性）
//   - 夜晚模式必降音量
//   - 返回 null / 异常时安全回退（函数不抛错、hooks 校验域内）
//   - TTS 链路不静默崩溃（输出恒为有限数、整数、在 hooks 校验域内）

import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { VOICE_PROFILE, resolveVoiceProfile } from '../src/core/voice/voice-profile.js'
import { NAGI_VOICE } from '../src/core/voice/engines.js'
import { createPresenceHooks } from '../src/core/presence/hooks.js'

/* ---------------- core 纯函数 ---------------- */

const edgeBase = { rate: NAGI_VOICE.edge.rate, pitch: NAGI_VOICE.edge.pitch, volume: NAGI_VOICE.edge.volume }
const call = (input, opts) => resolveVoiceProfile(input, opts)

test('六情绪方向性：joy 加快上扬、pout 放慢、worry 放慢低沉', () => {
  const calm = call({ emotion: 'calm', intensity: 1, engine: 'edge' })
  assert.deepEqual(calm, { voice: '', ...edgeBase }) // calm 满强度 = 基准本身
  const joy = call({ emotion: 'joy', intensity: 1, engine: 'edge' })
  assert.ok(joy.rate > calm.rate && joy.pitch > calm.pitch, 'joy 应更快更高')
  const pout = call({ emotion: 'pout', intensity: 1, engine: 'edge' })
  assert.ok(pout.rate < calm.rate && pout.pitch < calm.pitch, 'pout 应更慢更低')
  const worry = call({ emotion: 'worry', intensity: 1, engine: 'edge' })
  assert.ok(worry.rate < calm.rate && worry.pitch < calm.pitch && worry.volume < calm.volume, 'worry 应放慢、低沉、收敛')
  const smile = call({ emotion: 'smile', intensity: 1, engine: 'edge' })
  assert.ok(smile.rate > calm.rate && smile.pitch > calm.pitch, 'smile 应轻扬')
  const puzzled = call({ emotion: 'puzzled', intensity: 1, engine: 'edge' })
  assert.ok(puzzled.pitch > calm.pitch, 'puzzled 音高应上扬（疑问感）')
})

// OBS-1 的教训：情绪表曾「方向对但幅度小」，满强度 joy 只比 calm 快 8，
// 到 0.5 强度只剩 4，真机听上去就是同一张脸。方向性断言抓不到这种退化，
// 所以这里把「差异下限」也钉住——以后谁再调平，这条会红。
test('情绪差异下限：任意两情绪至少一轴拉开 ≥5，两极 ≥25，半强度仍听得出', () => {
  const es = VOICE_PROFILE.emotions
  const names = Object.keys(es)
  const axes = ['rate', 'pitch', 'volume']
  const gap = (a, b) => Math.max(...axes.map((k) => Math.abs((Number(es[a][k]) || 0) - (Number(es[b][k]) || 0))))
  let minGap = Infinity
  let worst = ''
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const g = gap(names[i], names[j])
      if (g < minGap) { minGap = g; worst = `${names[i]}<->${names[j]}` }
    }
  }
  assert.ok(minGap >= 5, `任意两情绪至少一轴差 >=5，最接近的一对 ${worst} = ${minGap}`)

  // 两极起伏：joy ↔ pout 语速要拉得开（「整体过于含蓄」的定量兜底）
  const span = Math.abs(es.joy.rate - es.pout.rate)
  assert.ok(span >= 25, `两极语速差应 >=25，实得 ${span}`)

  // 序关系：高兴往上走、闹别扭往下走，中间不许错位
  assert.ok(es.joy.rate > es.smile.rate && es.smile.rate > es.calm.rate, 'joy > smile > calm（语速）')
  assert.ok(es.pout.rate < es.worry.rate && es.worry.rate < es.calm.rate, 'pout < worry < calm（语速）')

  // 半强度仍要听得出：取整后不能塌成 0（这是旧表最致命的一点）
  const halfJoy = call({ emotion: 'joy', intensity: 0.5, engine: 'edge' })
  assert.ok(halfJoy.rate - edgeBase.rate > 4, `半强度 joy 语速差应 >4，实得 ${halfJoy.rate - edgeBase.rate}`)
  const halfWorry = call({ emotion: 'worry', intensity: 0.5, engine: 'edge' })
  assert.ok(edgeBase.rate - halfWorry.rate > 4, `半强度 worry 语速差应 >4，实得 ${edgeBase.rate - halfWorry.rate}`)
})

test('强度调制：幅度随 intensity 单调放大，0 强度等于基准', () => {
  const base = call({ emotion: 'calm', intensity: 0, engine: 'edge' })
  assert.deepEqual(base, { voice: '', ...edgeBase })
  const half = call({ emotion: 'joy', intensity: 0.5, engine: 'edge' })
  const full = call({ emotion: 'joy', intensity: 1, engine: 'edge' })
  const dHalf = Math.abs(half.rate - edgeBase.rate)
  const dFull = Math.abs(full.rate - edgeBase.rate)
  assert.ok(dFull > dHalf && dHalf > 0, `幅度应随强度放大：${dFull} > ${dHalf} > 0`)
  // intensity 越界与非有限数按 0 / 夹紧处理，不产生 NaN
  assert.deepEqual(call({ emotion: 'joy', intensity: -3, engine: 'edge' }), { voice: '', ...edgeBase })
  assert.deepEqual(call({ emotion: 'joy', intensity: 2, engine: 'edge' }), full)
  assert.deepEqual(call({ emotion: 'joy', intensity: 'abc', engine: 'edge' }), { voice: '', ...edgeBase })
})

test('昼夜时段：夜晚必降音量并放慢，午后犯困拉长', () => {
  const day = call({ emotion: 'calm', intensity: 0, rhythm: { enabled: true, period: 'noon' }, engine: 'edge' })
  const night = call({ emotion: 'calm', intensity: 0, rhythm: { enabled: true, period: 'night' }, engine: 'edge' })
  assert.ok(night.volume < day.volume, '夜晚必须降音量')
  assert.ok(night.rate < day.rate, '夜晚必须放慢')
  const afternoon = call({ emotion: 'calm', intensity: 0, rhythm: { enabled: true, period: 'afternoon' }, engine: 'edge' })
  assert.ok(afternoon.rate < day.rate, '午后应变慢（犯困拉长）')
  // 夜晚压制胜过情绪上扬：joy + 夜晚音量仍低于白天 joy
  const joyDay = call({ emotion: 'joy', intensity: 1, rhythm: { enabled: true, period: 'noon' }, engine: 'edge' })
  const joyNight = call({ emotion: 'joy', intensity: 1, rhythm: { enabled: true, period: 'night' }, engine: 'edge' })
  assert.ok(joyNight.volume < joyDay.volume && joyNight.rate < joyDay.rate)
})

test('时段开关：rhythm 缺失 / 关闭 / 未知时段均不施加时段调制', () => {
  const plain = call({ emotion: 'smile', intensity: 1, engine: 'edge' })
  assert.deepEqual(call({ emotion: 'smile', intensity: 1, rhythm: null, engine: 'edge' }), plain)
  assert.deepEqual(call({ emotion: 'smile', intensity: 1, rhythm: { enabled: false, period: 'night' }, engine: 'edge' }), plain)
  assert.deepEqual(call({ emotion: 'smile', intensity: 1, rhythm: { enabled: true, period: 'dawn' }, engine: 'edge' }), plain)
})

test('语气标记：已知项生效、未知项静默忽略', () => {
  const plain = call({ emotion: 'calm', intensity: 0, engine: 'edge' })
  const gentle = call({ emotion: 'calm', intensity: 0, toneTag: 'gentle', engine: 'edge' })
  assert.ok(gentle.rate < plain.rate && gentle.volume < plain.volume)
  const playful = call({ emotion: 'calm', intensity: 0, toneTag: 'playful', engine: 'edge' })
  assert.ok(playful.rate > plain.rate && playful.pitch > plain.pitch)
  assert.deepEqual(call({ emotion: 'calm', intensity: 0, toneTag: 'shouting', engine: 'edge' }), plain)
  assert.deepEqual(call({ emotion: 'calm', intensity: 0, toneTag: 42, engine: 'edge' }), plain)
})

test('安全回退：异常输入返回 null，绝不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, [], () => {}]) {
    assert.equal(call(bad), null)
  }
  // 缺 emotion / intensity 不是异常：按 calm + 0 强度给出基准
  assert.deepEqual(call({ engine: 'edge' }), { voice: '', ...edgeBase })
})

test('未知 engine 返回 null（交回编排层默认路径）', () => {
  assert.equal(call({ emotion: 'joy', intensity: 1, engine: 'gptsovits-x' }), null)
  assert.equal(call({ emotion: 'joy', intensity: 1, engine: 42 }), null)
  assert.equal(call({ emotion: 'joy', intensity: 1 }), null)
})

test('未知情绪按 calm 处理（仍施加时段与语气）', () => {
  const unknown = call({ emotion: 'anger', intensity: 1, engine: 'edge' })
  assert.deepEqual(unknown, { voice: '', ...edgeBase })
  const unknownNight = call({ emotion: 'anger', intensity: 1, rhythm: { enabled: true, period: 'night' }, engine: 'edge' })
  assert.ok(unknownNight.volume < edgeBase.volume)
})

test('SAPI 基准无 pitch 字段时输出仍有限', () => {
  const r = call({ emotion: 'joy', intensity: 1, engine: 'sapi' })
  assert.ok(Number.isFinite(r.pitch), 'sapi 也应给出有限 pitch（编排层会忽略）')
  assert.ok(r.rate >= -50 && r.rate <= 50 && r.volume >= 0 && r.volume <= 100)
})

test('值域与 hooks 契约：批量组合输出恒为合规参数', () => {
  const emotions = [...Object.keys(VOICE_PROFILE.emotions), 'unknown-mood']
  const periods = [...Object.keys(VOICE_PROFILE.periods), 'unknown-period']
  const tones = [...Object.keys(VOICE_PROFILE.toneTags), null, 'unknown-tone']
  const hooks = createPresenceHooks()
  hooks.registerVoiceParamsProvider((input) => resolveVoiceProfile(input))
  let checked = 0
  for (const engine of ['edge', 'sapi']) {
    for (const emotion of emotions) {
      for (const period of periods) {
        for (const intensity of [0, 0.37, 1]) {
          for (const toneTag of tones) {
            const input = { emotion, intensity, toneTag, engine, rhythm: { enabled: true, period } }
            const r = resolveVoiceProfile(input)
            assert.ok(r && typeof r === 'object')
            assert.equal(r.voice, '', 'voice 恒为空串 = 沿用当前音色')
            for (const k of ['rate', 'pitch', 'volume']) {
              assert.ok(Number.isInteger(r[k]), `${k} 应为整数：${r[k]}`)
            }
            assert.ok(r.rate >= -50 && r.rate <= 50 && r.pitch >= -50 && r.pitch <= 50)
            assert.ok(r.volume >= 0 && r.volume <= 100)
            // hooks 校验必须原样通过（契约：编排层只认过校验的输出）
            const passed = hooks.resolveVoiceParams(input)
            assert.deepEqual(passed, r, 'hooks 应放行本模块输出')
            checked++
          }
        }
      }
    }
  }
  assert.ok(checked > 300, `组合覆盖：${checked}`)
})

test('用户偏移折叠：设置页滑条继续有效', () => {
  const plain = call({ emotion: 'calm', intensity: 0, engine: 'edge' })
  const shifted = call({ emotion: 'calm', intensity: 0, engine: 'edge' }, { userRate: 10, userVolume: 50 })
  assert.equal(shifted.rate, plain.rate + 10)
  assert.equal(shifted.volume, 50)
  // 夜晚在用户音量之上再降
  const night = call({ emotion: 'calm', intensity: 0, rhythm: { enabled: true, period: 'night' }, engine: 'edge' }, { userVolume: 50 })
  assert.equal(night.volume, 50 + VOICE_PROFILE.periods.night.volume)
  // 极端用户偏移也被夹回校验域
  const extreme = call({ emotion: 'joy', intensity: 1, engine: 'edge' }, { userRate: 200, userVolume: -50 })
  assert.ok(extreme.rate <= 50 && extreme.volume >= 0)
})

/* ---------------- 扩展接线 ---------------- */

let extSettings = { voice: { rate: 5, volume: 60 } }
mock.module('electron', { exports: { app: { getPath: () => '' } } })
mock.module('../src/main/settings-store.js', { exports: { getSettings: () => extSettings } })
const ext = await import('../src/main/extensions/voice-profile.js')

test('扩展：install 注册 provider，折叠用户设置，可注销', () => {
  const api = {
    registered: null,
    registerVoiceParamsProvider(fn) { api.registered = fn; return () => { api.registered = null } }
  }
  const stop = ext.install(api)
  assert.equal(typeof api.registered, 'function')
  const r = api.registered({ emotion: 'joy', intensity: 1, rhythm: null, toneTag: null, engine: 'edge' })
  // edge 基准 -10 + 用户 5 + joy 16 = 11；pitch -2 + 10 = 8；音量 60 + 3 = 63
  assert.deepEqual(r, { voice: '', rate: 11, pitch: 8, volume: 63 })
  // 设置切换即时生效（下一次调用即读新值）
  extSettings = { voice: { rate: -5, volume: 100 } }
  const r2 = api.registered({ emotion: 'joy', intensity: 1, rhythm: null, toneTag: null, engine: 'edge' })
  // rate：-10 - 5 + 16 = 1；pitch：-2 + 10 = 8；音量：100 + 3 触顶夹回 100
  assert.deepEqual(r2, { voice: '', rate: 1, pitch: 8, volume: 100 })
  // 未知引擎 → null，编排层安全回退
  assert.equal(api.registered({ emotion: 'joy', intensity: 1, engine: 'nope' }), null)
  stop()
  assert.equal(api.registered, null)
})
