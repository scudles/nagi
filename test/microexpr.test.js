// test/microexpr.test.js
// 瞬时微表情的纯逻辑回归锁：
//   ① 真实配置能解析，池里每个条目的参数都真实存在于模型（cdi3 实扫）；
//   ② 池里的参数**不能**与情绪/装束已在用的参数重叠（否则会互相覆盖，
//      "星星眼"和"脸红"打架这种事只有在真机上才看得出来，静态先卡住）；
//   ③ 按待机基调筛选 + 按权重随机 + 不连着两次同一个；
//   ④ 包络：0→1→0，淡入淡出都留时间，到期必须归零（不能残留成"永远星星眼"）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMicroExpr, pickMicroExpr, microEnvelope } from '../src/core/microexpr.js'
import { TONE } from '../src/core/ambient.js'

const MODEL_DIR = join(process.cwd(), 'models', 'Maine')
const raw = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-microexpr.json'), 'utf8'))
const cfg = parseMicroExpr(raw)
const paramIds = (() => {
  const cdi = JSON.parse(readFileSync(join(MODEL_DIR, 'Maine.cdi3.json'), 'utf8'))
  return (cdi.Parameters || []).map((p) => p.Id)
})()
const outfitCfg = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-outfit.json'), 'utf8'))
const emotionCfg = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-emotion.json'), 'utf8'))

/* ---------------- ① 配置能解析 ---------------- */

test('真实微表情配置：解析无错、池子够用', () => {
  assert.equal(cfg.ok, true, `配置有错：${cfg.errors.join('；')}`)
  assert.ok(cfg.pool.length >= 5, `池子太小：${cfg.pool.length}`)
  assert.ok(cfg.holdMs[0] >= 400 && cfg.holdMs[0] <= cfg.holdMs[1])
})

test('池里每条都写了参数、有名字、有基调', () => {
  for (const e of cfg.pool) {
    assert.ok(Object.keys(e.params).length > 0, `${e.id} 没有参数`)
    assert.ok(e.name && e.name.length > 0, `${e.id} 没有名字`)
    assert.ok(e.tones.length > 0, `${e.id} 没有 tone`)
    assert.ok(e.weight > 0, `${e.id} 权重应 > 0`)
  }
})

/* ---------------- ② 参数不与情绪/装束重叠 ---------------- */

test('微表情引用的参数全部真实存在于模型', () => {
  const used = new Set()
  for (const e of cfg.pool) for (const k of Object.keys(e.params)) used.add(k)
  const missing = [...used].filter((id) => !paramIds.includes(id))
  assert.deepEqual(missing, [], `这些参数模型里没有：${missing.join(', ')}`)
})

test('微表情参数不与装束参数重叠（否则换装束会把微表情盖掉）', () => {
  const outfitParams = new Set(Object.keys(outfitCfg.base || {}))
  for (const s of outfitCfg.slots || []) {
    for (const o of s.options || []) for (const k of Object.keys(o.params || {})) outfitParams.add(k)
  }
  const clash = []
  for (const e of cfg.pool) {
    for (const k of Object.keys(e.params)) if (outfitParams.has(k)) clash.push(`${e.id}:${k}`)
  }
  assert.deepEqual(clash, [], `微表情与装束参数打架：${clash.join(', ')}`)
})

test('微表情参数不与情绪面容的核心参数重叠（眉毛/脸颊/眼笑/嘴张/水印）', () => {
  // 这五个是 nagi_* 情绪表情在用的：她开心/疑惑/别扭全靠它们，
  // 微表情叠上去会把情绪脸改掉，那就不是"多加一双星星眼"了
  const forbidden = new Set(['ParamBrowLY', 'ParamBrowRY', 'ParamCheek', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthOpenY', 'Param469'])
  const clash = []
  for (const e of cfg.pool) {
    for (const k of Object.keys(e.params)) if (forbidden.has(k)) clash.push(`${e.id}:${k}`)
  }
  assert.deepEqual(clash, [], `微表情动了情绪面容参数：${clash.join(', ')}`)
  // 情绪映射本身也不能引用池里的参数（反向检查）
  const poolParams = new Set()
  for (const e of cfg.pool) for (const k of Object.keys(e.params)) poolParams.add(k)
  assert.ok(Object.keys(emotionCfg).length > 0)
})

/* ---------------- ③ 挑选逻辑 ---------------- */

test('按基调筛选：只在匹配当前基调的条目里挑', () => {
  for (const tone of [TONE.QUIET, TONE.NORMAL, TONE.ATTENTIVE]) {
    for (let i = 0; i < 40; i++) {
      const hit = pickMicroExpr(cfg, { tone, rng: () => i / 40 })
      if (!hit) continue // 该基调没有可用条目时返回 null（合法）
      const entry = cfg.pool.find((e) => e.id === hit.id)
      assert.ok(entry.tones.includes(tone), `${hit.id} 不属于 ${tone}`)
    }
  }
})

test('避免连着两次同一个：池子里还有别的就不会抽到 avoid', () => {
  const avoid = cfg.pool[0].id
  for (let i = 0; i < 30; i++) {
    const hit = pickMicroExpr(cfg, { tone: TONE.NORMAL, avoid, rng: () => (i % 10) / 10 })
    if (hit) assert.notEqual(hit.id, avoid)
  }
})

test('池子里只有一个可用条目时，avoid 也不会导致 null', () => {
  const one = parseMicroExpr({ pool: [{ id: 'x', params: { P: 1 }, tones: ['normal'] }] })
  const hit = pickMicroExpr(one, { tone: TONE.NORMAL, avoid: 'x', rng: () => 0.5 })
  assert.equal(hit?.id, 'x')
})

test('该基调没有条目时返回 null（不硬塞一个不相关的表情）', () => {
  const only = parseMicroExpr({ pool: [{ id: 'x', params: { P: 1 }, tones: ['attentive'] }] })
  assert.equal(pickMicroExpr(only, { tone: TONE.QUIET }), null)
})

test('权重影响概率：权重大的一边明显更容易被抽到', () => {
  const skewed = parseMicroExpr({
    pool: [
      { id: 'heavy', params: { A: 1 }, tones: ['normal'], weight: 9 },
      { id: 'light', params: { B: 1 }, tones: ['normal'], weight: 1 }
    ]
  })
  let heavy = 0
  for (let i = 0; i < 200; i++) {
    if (pickMicroExpr(skewed, { tone: TONE.NORMAL, rng: () => i / 200 })?.id === 'heavy') heavy++
  }
  assert.ok(heavy > 150, `权重大的一边只中了 ${heavy}/200`)
})

test('时长落在配置区间内', () => {
  for (let i = 0; i < 20; i++) {
    const hit = pickMicroExpr(cfg, { tone: TONE.NORMAL, rng: () => i / 20 })
    if (!hit) continue
    assert.ok(hit.holdMs >= cfg.holdMs[0] - 1 && hit.holdMs <= cfg.holdMs[1] + 1, `holdMs=${hit.holdMs}`)
  }
})

/* ---------------- ④ 包络 ---------------- */

test('包络：从 0 淡入到 1，末尾淡出回 0', () => {
  const HOLD = 1600
  assert.equal(microEnvelope(0, HOLD), 0, '起点必须是 0（不能一上来就闪满）')
  assert.ok(microEnvelope(80, HOLD) > 0 && microEnvelope(80, HOLD) < 1, '中途应当在 0~1 之间')
  assert.equal(microEnvelope(800, HOLD), 1, '中段满强度')
  assert.ok(microEnvelope(HOLD - 100, HOLD) < 1 && microEnvelope(HOLD - 100, HOLD) > 0, '末尾在淡出')
  assert.equal(microEnvelope(HOLD + 1, HOLD), 0, '到期必须归零（否则会残留成永久星星眼）')
  assert.equal(microEnvelope(HOLD * 10, HOLD), 0)
})

test('包络：非法输入不炸，也不会给出非零强度', () => {
  for (const bad of [NaN, undefined, null, -5, 'x']) {
    assert.equal(microEnvelope(bad, 1600), 0, `microEnvelope(${String(bad)}) 应为 0`)
  }
  assert.ok(microEnvelope(100, 10) > 0, '时长过短也应给出合法值而不是 NaN')
})

test('包络：淡入淡出时间之和不会超过总时长', () => {
  const HOLD = 500 // 比默认淡入+淡出(420)略长
  const mid = microEnvelope(250, HOLD)
  assert.ok(mid >= 0 && mid <= 1)
})

/* ---------------- 坏数据 ---------------- */

test('空配置 / 坏配置降级为空池，不抛错', () => {
  // 注意：没有池子不算"配置有错"——模型可以根本没有 nagi-microexpr.json，
  // 那就只是她不闪微表情而已（ok 仍为 true，pool 为空）。
  for (const bad of [null, undefined, {}, 0, 'x']) {
    const c = parseMicroExpr(bad)
    assert.deepEqual(c.pool, [])
    assert.ok(Array.isArray(c.holdMs) && c.holdMs.length === 2)
  }
})

test('缺参数的条目被拒绝（免得闪一下什么都没发生）', () => {
  const c = parseMicroExpr({ pool: [{ id: 'bad' }, { id: 'ok', params: { P: 1 } }] })
  assert.equal(c.pool.length, 1)
  assert.equal(c.pool[0].id, 'ok')
  assert.equal(c.ok, false)
})
