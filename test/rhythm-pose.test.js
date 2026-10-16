// test/rhythm-pose.test.js
// BLUE-2 时段表现纯逻辑回归锁：
//   ① night/afternoon 预设的方向性与数值保守（isSubtlePose 口径）；
//   ② 预设里的参数必须真实存在于随本仓库发布的 Lisette 模型
//      （cdi3.json 321 项实扫）——「禁止映射不存在的参数」的静态一侧，
//      运行时一侧由 rhythmPoseTargets 的 availableIds 过滤负责；
//   ③ 开关/异常/未知时段 → null（不施加），availableIds 过滤后为空 → null；
//   ④ night 抑制随机待机动作；其余时段不抑制；
//   ⑤ 归来便签入口门：离开起点取上一份快照的 away.since（returnNow 会把它置 null），
//      时长达到 reunionMinMs 才弹，非归来转换不弹。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RHYTHM_POSE_PRESETS,
  RHYTHM_POSE_EASE_RATE,
  rhythmPoseTargets,
  rhythmSuppressesRandomMotion,
  reunionPrompt
} from '../src/core/presence/rhythm-pose.js'
import { isSubtlePose } from '../src/core/pose.js'

const MODEL_CDI = join(process.cwd(), 'models', 'Lisette', 'Lisette.cdi3.json')

/* ---------------- ① 预设方向性与保守度 ---------------- */

test('night 预设：垂目/低头/慢呼吸/微阖眼，全部轻微', () => {
  const p = RHYTHM_POSE_PRESETS.night
  assert.ok(p.ParamEyeBallY < 0, '深夜目光应微垂（眼珠 Y 为负）')
  assert.ok(p.ParamAngleX < 0, '深夜头应微低（角度 X 为负）')
  assert.ok(p.ParamBodyAngleX < 0, '深夜身体应微收')
  assert.ok(p.ParamBreath < 0, '深夜呼吸应放慢')
  assert.ok(p.ParamEyeLOpen < 0 && p.ParamEyeROpen < 0, '深夜眼应微阖')
  assert.ok(isSubtlePose(p), 'night 预设必须通过轻微口径（角度 ≤10°、归一值 ≤1 直观量级）')
})

test('afternoon 预设：半眯眼/微张口/低头/慢呼吸，全部轻微', () => {
  const p = RHYTHM_POSE_PRESETS.afternoon
  assert.ok(p.ParamEyeLOpen < 0 && p.ParamEyeROpen < 0, '午后应半眯眼')
  assert.ok(p.ParamMouthOpenY > 0, '午后应微张口（近似慵懒，模型无哈欠动作组）')
  assert.ok(p.ParamAngleX < 0, '午后头应微低')
  assert.ok(p.ParamBreath < 0, '午后呼吸应放缓')
  assert.ok(isSubtlePose(p), 'afternoon 预设必须通过轻微口径')
})

test('morning/noon/evening 无预设（不施加叠加）', () => {
  for (const period of ['morning', 'noon', 'evening']) {
    assert.equal(RHYTHM_POSE_PRESETS[period], undefined, `${period} 不应有预设`)
  }
})

test('平滑速率与思考姿态同量级（每秒收敛比例）', () => {
  assert.ok(RHYTHM_POSE_EASE_RATE > 0 && RHYTHM_POSE_EASE_RATE <= 10)
})

/* ---------------- ② 预设参数必须存在于随仓库发布的模型 ---------------- */

test('night/afternoon 预设的参数全部存在于 Lisette 模型（cdi3.json 实扫）', () => {
  const cdi = JSON.parse(readFileSync(MODEL_CDI, 'utf8'))
  const ids = new Set((cdi.Parameters || []).map((p) => p.Id))
  assert.ok(ids.size > 300, `模型参数应有 321 项，实际 ${ids.size}`)
  for (const [period, preset] of Object.entries(RHYTHM_POSE_PRESETS)) {
    for (const id of Object.keys(preset)) {
      assert.ok(ids.has(id), `${period} 预设映射了模型不存在的参数：${id}`)
    }
  }
})

/* ---------------- ③ rhythmPoseTargets ---------------- */

const NIGHT = { enabled: true, period: 'night' }
const AFTERNOON = { enabled: true, period: 'afternoon' }
const ALL = Object.keys(RHYTHM_POSE_PRESETS.night)
  .concat(Object.keys(RHYTHM_POSE_PRESETS.afternoon))

test('night 快照 → night 目标（参数全可用时原样施加）', () => {
  assert.deepEqual(rhythmPoseTargets(NIGHT, ALL), {
    name: 'night',
    params: { ...RHYTHM_POSE_PRESETS.night }
  })
})

test('afternoon 快照 → afternoon 目标', () => {
  assert.deepEqual(rhythmPoseTargets(AFTERNOON, ALL), {
    name: 'afternoon',
    params: { ...RHYTHM_POSE_PRESETS.afternoon }
  })
})

test('availableIds 过滤：模型没有的参数不进目标', () => {
  const t = rhythmPoseTargets(NIGHT, ['ParamEyeBallY', 'ParamAngleX'])
  assert.deepEqual(t, { name: 'night', params: { ParamEyeBallY: -0.15, ParamAngleX: -2.5 } })
  // 缺 ParamBreath 的模型：night 目标里就不该有呼吸项
  const noBreath = rhythmPoseTargets(NIGHT, ALL.filter((id) => id !== 'ParamBreath'))
  assert.ok(!('ParamBreath' in noBreath.params), '过滤后不应残留 ParamBreath')
})

test('availableIds 过滤后为空 → null（本模型无对应表现，不施加）', () => {
  // night 预设六个参数一个都不在模型里 → 过滤后空 → null
  assert.equal(rhythmPoseTargets(NIGHT, ['ParamMouthOpenY', 'ParamArmLA']), null)
  assert.equal(rhythmPoseTargets(NIGHT, []), null)
})

test('不传 availableIds 时不过滤（调用方自担，调试/验证路径用）', () => {
  const t = rhythmPoseTargets(NIGHT)
  assert.equal(t.name, 'night')
  assert.equal(Object.keys(t.params).length, Object.keys(RHYTHM_POSE_PRESETS.night).length)
})

test('开关关闭 / 快照非法 / 未知时段 → null', () => {
  assert.equal(rhythmPoseTargets({ enabled: false, period: 'night' }, ALL), null)
  assert.equal(rhythmPoseTargets(null, ALL), null)
  assert.equal(rhythmPoseTargets(undefined, ALL), null)
  assert.equal(rhythmPoseTargets('night', ALL), null)
  assert.equal(rhythmPoseTargets({ enabled: true }, ALL), null, '缺 period')
  assert.equal(rhythmPoseTargets({ enabled: true, period: 'morning' }, ALL), null)
  assert.equal(rhythmPoseTargets({ enabled: true, period: '深夜' }, ALL), null)
})

/* ---------------- ④ 抑制随机待机动作 ---------------- */

test('night（开关开）抑制随机待机动作；其余一律不抑制', () => {
  assert.equal(rhythmSuppressesRandomMotion(NIGHT), true)
  assert.equal(rhythmSuppressesRandomMotion(AFTERNOON), false)
  assert.equal(rhythmSuppressesRandomMotion({ enabled: false, period: 'night' }), false)
  assert.equal(rhythmSuppressesRandomMotion({ enabled: true, period: 'morning' }), false)
  assert.equal(rhythmSuppressesRandomMotion(null), false)
  assert.equal(rhythmSuppressesRandomMotion(undefined), false)
})

/* ---------------- ⑤ 归来便签入口门 ---------------- */

const T0 = 1_700_000_000_000

test('away→present 且离开够久 → 弹入口', () => {
  const prev = { away: { state: 'away', since: T0 }, rhythm: { at: T0 } }
  const next = { away: { state: 'present', since: null }, rhythm: { at: T0 + 11 * 60 * 1000 } }
  const r = reunionPrompt(prev, next, { reunionMinMs: 5 * 60 * 1000 })
  assert.equal(r.prompt, true)
  assert.equal(r.durationMs, 11 * 60 * 1000)
})

test('suspended→present 同样算归来', () => {
  const prev = { away: { state: 'suspended', since: T0 }, rhythm: { at: T0 } }
  const next = { away: { state: 'present', since: null }, rhythm: { at: T0 + 6 * 60 * 1000 } }
  assert.equal(reunionPrompt(prev, next, { reunionMinMs: 5 * 60 * 1000 }).prompt, true)
})

test('离开时长不足门槛 → 不弹（比这更短的不汇报）', () => {
  const prev = { away: { state: 'away', since: T0 }, rhythm: { at: T0 } }
  const next = { away: { state: 'present', since: null }, rhythm: { at: T0 + 4 * 60 * 1000 } }
  const r = reunionPrompt(prev, next, { reunionMinMs: 5 * 60 * 1000 })
  assert.equal(r.prompt, false)
  assert.equal(r.durationMs, 4 * 60 * 1000)
})

test('门槛默认 5 分钟（配置缺失/非法时）', () => {
  const prev = { away: { state: 'away', since: T0 }, rhythm: { at: T0 } }
  const ok = { away: { state: 'present', since: null }, rhythm: { at: T0 + 5 * 60 * 1000 } }
  const no = { away: { state: 'present', since: null }, rhythm: { at: T0 + 4 * 60 * 1000 } }
  assert.equal(reunionPrompt(prev, ok, {}).prompt, true)
  assert.equal(reunionPrompt(prev, ok).prompt, true)
  assert.equal(reunionPrompt(prev, no, { reunionMinMs: 'x' }).prompt, false)
})

test('非归来转换不弹：present→present / away→away / suspended→suspended', () => {
  const stay = (state) => [
    { away: { state, since: state === 'present' ? null : T0 }, rhythm: { at: T0 } },
    { away: { state, since: null }, rhythm: { at: T0 + 60 * 60 * 1000 } }
  ]
  for (const state of ['present', 'away', 'suspended']) {
    const [prev, next] = stay(state)
    assert.equal(reunionPrompt(prev, next, { reunionMinMs: 60 * 1000 }).prompt, false, `${state}→${state} 不该弹`)
  }
})

test('上一份快照缺失 / since 不可用 → 不弹（不猜时长）', () => {
  const next = { away: { state: 'present', since: null }, rhythm: { at: T0 + 60 * 60 * 1000 } }
  assert.equal(reunionPrompt(null, next, { reunionMinMs: 60 * 1000 }).prompt, false)
  const noSince = { away: { state: 'away', since: null }, rhythm: { at: T0 } }
  assert.equal(reunionPrompt(noSince, next, { reunionMinMs: 60 * 1000 }).prompt, false)
  assert.equal(reunionPrompt({ away: { state: 'away' }, rhythm: { at: T0 } }, next, { reunionMinMs: 60 * 1000 }).prompt, false)
})

test('回来但还在离开态（away→away 之前误判防护）不弹；present→suspended 不弹', () => {
  const prev = { away: { state: 'away', since: T0 }, rhythm: { at: T0 } }
  const stillAway = { away: { state: 'away', since: T0 }, rhythm: { at: T0 + 60 * 60 * 1000 } }
  assert.equal(reunionPrompt(prev, stillAway, { reunionMinMs: 60 * 1000 }).prompt, false)
  const suspended = { away: { state: 'suspended', since: T0 }, rhythm: { at: T0 + 60 * 60 * 1000 } }
  const prevPresent = { away: { state: 'present', since: null }, rhythm: { at: T0 } }
  assert.equal(reunionPrompt(prevPresent, suspended, { reunionMinMs: 60 * 1000 }).prompt, false)
})
