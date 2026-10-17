// test/face-expression.test.js
// 面部表达三层（肌肉/微动/口型）的纯逻辑回归锁：
//   ① 真实配置能解析；每个情绪都定义了肌肉向量；
//   ② **肌肉引用的参数必须真实存在于模型**（否则写了也没用，而且不会报错）；
//   ③ 强度缩放与混合：intensity=0 必须真的归零、1 取满值、中间线性；
//   ④ 微动幅度必须"感觉得到但看不出来"：不超过配置振幅，且相邻两帧不能突变（否则是抽动不是肌肉）；
//   ⑤ 左右眉/眼必须不同步（同步抖动看起来像故障）；
//   ⑥ 眼球扫视：间隔与幅度受控，能注入假时钟单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  blendMuscles,
  createSaccade,
  musclesFor,
  neutralOf,
  parseFaceConfig,
  pickViseme,
  scaleMuscles,
  tremorAt,
  visemeParams
} from '../src/core/face/expression.js'

const MODEL_DIR = join(process.cwd(), 'models', 'Maine')
const cfg = parseFaceConfig(JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-face.json'), 'utf8')))
const emotionCfg = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-emotion.json'), 'utf8'))
const exprNames = (() => {
  const m = JSON.parse(readFileSync(join(MODEL_DIR, 'Maine.model3.json'), 'utf8'))
  return (m.FileReferences?.Expressions || []).map((e) => e.Name).filter(Boolean)
})()
const paramIds = (() => {
  const cdi = JSON.parse(readFileSync(join(MODEL_DIR, 'Maine.cdi3.json'), 'utf8'))
  return (cdi.Parameters || []).map((p) => p.Id)
})()

/* ---------------- ① 配置 ---------------- */

test('真实面部配置：解析无错，六个情绪都有定义', () => {
  assert.equal(cfg.ok, true, `配置有错：${cfg.errors.join('；')}`)
  const need = ['nagi_neutral', '脸红', 'nagi_smile', 'nagi_joy', 'nagi_puzzled', '紧张汗', 'nagi_pout']
  for (const n of need) assert.ok(cfg.emotions[n], `缺情绪 ${n}`)
})

test('情绪映射解析出来的表情名必须真实存在于模型（2026-10-17 修：smile/worry 曾填文件名导致彻底没脸）', () => {
  // live2d.js 的 resolveExpression 用 model3.json 的 Name 匹配；nagi-emotion.json 里
  // 填文件名（blush / nervous_sweat）会静默返回 null，那个情绪就什么都不做。
  const keys = Object.keys(emotionCfg).filter((k) => !k.startsWith('_') && k !== 'removeRedGlow')
  const bad = []
  for (const k of keys) {
    const expr = emotionCfg[k]?.expr
    if (typeof expr !== 'string' || !expr) {
      bad.push(`${k}: 没有 expr`)
      continue
    }
    if (!exprNames.includes(expr)) bad.push(`${k} → ${expr}（模型里没有这个表情 Name）`)
  }
  assert.deepEqual(bad, [], bad.join('；'))
})

test('每个情绪键都能解析到带肌肉向量的面容（解析到了但没肌肉 = 只有 exp3 突变，没有强度层次）', () => {
  for (const k of Object.keys(emotionCfg).filter((x) => !x.startsWith('_') && x !== 'removeRedGlow')) {
    const expr = emotionCfg[k].expr
    assert.ok(cfg.emotions[expr], `${k} → ${expr} 在 nagi-face.json 里没有肌肉向量`)
  }
})

test('calm（nagi_neutral）必须是空向量——她的平静就是全 0', () => {
  assert.deepEqual(cfg.emotions.nagi_neutral, {})
})

test('原先只有特效符号的两个情绪现在真的动了五官', () => {
  // 2026-10-17 之前：smile 只有 Param19（脸红）、worry 只有 Param15（紧张汗），脸上什么都没发生
  const faceParam = /^(ParamBrow|ParamMouth|ParamEyeLSmile|ParamEyeRSmile|ParamCheek|Param29|Param25)/
  const smileFace = Object.keys(cfg.emotions.nagi_smile).filter((k) => faceParam.test(k))
  const worryFace = Object.keys(cfg.emotions.紧张汗).filter((k) => faceParam.test(k))
  assert.ok(smileFace.length >= 3, `smile 的五官参数太少：${smileFace.join(',')}`)
  assert.ok(worryFace.length >= 3, `worry 的五官参数太少：${worryFace.join(',')}`)
  // 特效符号仍然保留（脸红 / 紧张汗），只是现在会随强度渐显
  assert.equal(cfg.emotions.nagi_smile.Param19, 0.55)
  assert.equal(cfg.emotions.紧张汗.Param15, 1)
})

/* ---------------- ② 参数必须真实存在 ---------------- */

test('肌肉向量引用的参数全部真实存在于模型', () => {
  const used = new Set()
  for (const vec of Object.values(cfg.emotions)) for (const k of Object.keys(vec)) used.add(k)
  const missing = [...used].filter((id) => !paramIds.includes(id))
  assert.deepEqual(missing, [], `模型里没有这些参数：${missing.join(',')}`)
})

test('口型引用的参数也存在', () => {
  const used = new Set()
  for (const vec of Object.values(cfg.visemes)) for (const k of Object.keys(vec)) used.add(k)
  const missing = [...used].filter((id) => !paramIds.includes(id))
  assert.deepEqual(missing, [], `口型用了不存在的参数：${missing.join(',')}`)
})

test('微动通道引用的参数也存在', () => {
  const used = cfg.tremor.channels.map((c) => c.param)
  const missing = used.filter((id) => !paramIds.includes(id))
  assert.deepEqual(missing, [], `微动用了不存在的参数：${missing.join(',')}`)
})

test('肌肉向量不与装束参数打架（装束保持层会覆盖同一参数）', () => {
  const outfit = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-outfit.json'), 'utf8'))
  const outfitParams = new Set(Object.keys(outfit.base || {}))
  for (const s of outfit.slots || []) {
    for (const o of s.options || []) for (const k of Object.keys(o.params || {})) outfitParams.add(k)
  }
  const clash = []
  for (const [name, vec] of Object.entries(cfg.emotions)) {
    for (const k of Object.keys(vec)) if (outfitParams.has(k)) clash.push(`${name}:${k}`)
  }
  assert.deepEqual(clash, [], `情绪肌肉与装束参数冲突：${clash.join(',')}`)
})

/* ---------------- ③ 强度缩放与混合 ---------------- */

test('强度 0 = 全零（情绪回落时脸真的松下来）', () => {
  const joy = musclesFor(cfg, 'nagi_joy')
  assert.deepEqual(scaleMuscles(joy, 0), {})
})

test('强度 1 = 原值，0.5 = 一半（线性）', () => {
  const joy = musclesFor(cfg, 'nagi_joy')
  const full = scaleMuscles(joy, 1)
  const half = scaleMuscles(joy, 0.5)
  assert.equal(full.ParamEyeLSmile, 0.95)
  assert.equal(half.ParamEyeLSmile, 0.475)
})

test('强度越界被夹到 [0,1]', () => {
  const joy = musclesFor(cfg, 'nagi_joy')
  assert.equal(scaleMuscles(joy, 5).ParamEyeLSmile, 0.95)
  assert.deepEqual(scaleMuscles(joy, -2), {})
})

test('混合：t=0 取前者、t=1 取后者、t=0.5 各半', () => {
  const a = { P: 1, Q: 0.5 }
  // b 里不显式写 P:0 —— 函数会把"算出 0"的参数剔掉（省得给模型塞一堆 0），
  // 期望值要跟这个约定一致
  const b = { R: 0.8 }
  assert.deepEqual(blendMuscles(a, b, 0), a)
  assert.deepEqual(blendMuscles(a, b, 1), b)
  const mid = blendMuscles(a, b, 0.5)
  assert.equal(mid.P, 0.5)
  assert.equal(mid.Q, 0.25)
  assert.equal(mid.R, 0.4)
})

test('混合：从 joy 到 calm 会把笑眼一路松回 0（不是突跳）', () => {
  const joy = musclesFor(cfg, 'nagi_joy')
  const calm = musclesFor(cfg, 'nagi_neutral')
  const mid = blendMuscles(joy, calm, 0.5)
  assert.ok(mid.ParamEyeLSmile > 0 && mid.ParamEyeLSmile < 0.95, `中途值应在 0~0.95 之间，实际 ${mid.ParamEyeLSmile}`)
})

test('没有定义肌肉的表情返回 null（调用方据此退回 exp3）', () => {
  assert.equal(musclesFor(cfg, '不存在的表情'), null)
})

/* ---------------- ④ 微动幅度与连续性 ---------------- */

test('微动幅度不超过配置振幅（防止"抽搐"）', () => {
  const maxByParam = {}
  for (const c of cfg.tremor.channels) maxByParam[c.param] = c.amp * cfg.tremor.amplitude
  for (let i = 0; i < 400; i++) {
    const t = i * 37
    const tr = tremorAt(cfg, t, 7)
    for (const [k, v] of Object.entries(tr)) {
      assert.ok(Math.abs(v) <= maxByParam[k] + 1e-6, `${k} 在 t=${t} 时为 ${v}，超过上限 ${maxByParam[k]}`)
    }
  }
})

test('微动是连续的：相邻两帧的变化很小（不是随机抖动）', () => {
  let worst = 0
  let prev = null
  for (let i = 0; i < 300; i++) {
    const t = i * 40 // 40ms 一帧
    const tr = tremorAt(cfg, t, 3)
    if (prev) {
      for (const k of Object.keys(tr)) {
        worst = Math.max(worst, Math.abs((tr[k] || 0) - (prev[k] || 0)))
      }
    }
    prev = tr
  }
  assert.ok(worst < 0.01, `相邻帧最大跳变 ${worst.toFixed(4)} 太大，会看起来像抽动`)
})

test('微动不为零（否则等于没做）', () => {
  let any = 0
  for (let i = 0; i < 50; i++) any = Math.max(any, Object.keys(tremorAt(cfg, i * 100, 1)).length)
  assert.ok(any > 0, '任何时刻都没有微动')
})

test('左右眉不同步（同步抖动像故障）', () => {
  let diff = 0
  for (let i = 0; i < 200; i++) {
    const tr = tremorAt(cfg, i * 50, 5)
    diff = Math.max(diff, Math.abs((tr.ParamBrowLY || 0) - (tr.ParamBrowRY || 0)))
  }
  assert.ok(diff > 0.01, `左右眉几乎同步（最大差 ${diff.toFixed(4)}）`)
})

test('scale=0 时微动完全关闭（设置页可以关掉它）', () => {
  assert.deepEqual(tremorAt(cfg, 1234, 1, 0), {})
})

test('不同 seed 给出不同的微动（每次启动不会一模一样）', () => {
  const a = tremorAt(cfg, 5000, 1)
  const b = tremorAt(cfg, 5000, 9)
  const keys = Object.keys(a).filter((k) => a[k] !== undefined && b[k] !== undefined)
  assert.ok(keys.some((k) => Math.abs(a[k] - b[k]) > 1e-6), '不同 seed 结果相同')
})

/* ---------------- ⑤ 眼球扫视 ---------------- */

function fakeClock(start = 0) {
  let t = start
  return { now: () => t, add: (ms) => (t += ms) }
}

test('扫视：幅度受控，且会随时间换目标', () => {
  const c = fakeClock()
  const s = createSaccade(cfg, { now: c.now, rng: Math.random })
  const seen = new Set()
  // 采样 20ms：滑行只有 70ms，采太稀会看不到中间位置
  for (let i = 0; i < 600; i++) {
    const p = s.tick()
    assert.ok(Math.abs(p.x) <= cfg.tremor.saccade.amp + 1e-6, `x 超幅：${p.x}`)
    assert.ok(Math.abs(p.y) <= cfg.tremor.saccade.amp + 1e-6, `y 超幅：${p.y}`)
    seen.add(p.x.toFixed(3))
    c.add(20)
  }
  assert.ok(seen.size > 3, `扫视几乎没变过（只有 ${seen.size} 个不同位置）`)
})

test('扫视：滑过去是渐进的（不是瞬移）', () => {
  const c = fakeClock()
  const s = createSaccade(cfg, { now: c.now, rng: () => 0.99 })
  c.add(10)
  const a = s.tick()
  c.add(20)
  const b = s.tick()
  const jump = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  assert.ok(jump < cfg.tremor.saccade.amp, `一次跳了 ${jump.toFixed(3)}，不像"眼睛移过去"`)
})

/* ---------------- ⑥ 口型 ---------------- */

test('元音：能挑、不连续重复、形状不为空', () => {
  assert.ok(cfg.visemeOrder.length >= 3, `元音太少：${cfg.visemeOrder.join(',')}`)
  const a = pickViseme(cfg, () => 0.1)
  const b = pickViseme(cfg, () => 0.1, a)
  assert.ok(a && b)
  assert.notEqual(a, b, '连续两次不该是同一个元音')
  const shape = visemeParams(cfg, a)
  assert.ok(shape && Object.keys(shape).length > 0, '元音没有对应参数')
})

test('元音之间音色不同（不是同一个形状换个名字）', () => {
  const shapes = cfg.visemeOrder.map((k) => JSON.stringify(visemeParams(cfg, k)))
  assert.equal(new Set(shapes).size, shapes.length, '有两个元音的形状完全一样')
})

/* ---------------- 眼开闭的中性值（2026-10-17 修） ---------------- */

test('眼开闭按强度插值，不会被"强度低"压成闭眼', () => {
  const cfg = parseFaceConfig({ emotions: { joy: { ParamEyeLOpen: 0.8, ParamBrowLY: 0.5 } } })
  const vec = musclesFor(cfg, 'joy')
  // 满强度：就是配置值
  assert.equal(scaleMuscles(vec, 1).ParamEyeLOpen, 0.8)
  // 0.3 强度：从 1 插值到 0.8 → 1 + (0.8-1)*0.3 = 0.94（不是 0.8*0.3=0.24）
  const low = scaleMuscles(vec, 0.3)
  assert.ok(Math.abs(low.ParamEyeLOpen - 0.94) < 1e-6, `实际 ${low.ParamEyeLOpen}`)
  assert.ok(low.ParamEyeLOpen > 0.9, '低强度时眼睛应当几乎全睁，不能闭合')
  // 眉毛这种中性 0 的仍然按乘法
  assert.ok(Math.abs(low.ParamBrowLY - 0.15) < 1e-6, `实际 ${low.ParamBrowLY}`)
})

test('强度为 0 时眼开闭回到 1（中性），且不会把 1 写进结果里', () => {
  const cfg = parseFaceConfig({ emotions: { joy: { ParamEyeLOpen: 0.8 } } })
  const out = scaleMuscles(musclesFor(cfg, 'joy'), 0)
  assert.equal('ParamEyeLOpen' in out, false, '正好等于中性值时不该写（写了也是 1，没必要）')
})

test('neutralOf：眼开闭是 1，其余是 0', () => {
  assert.equal(neutralOf('ParamEyeLOpen'), 1)
  assert.equal(neutralOf('ParamEyeROpen'), 1)
  assert.equal(neutralOf('ParamBrowLY'), 0)
  assert.equal(neutralOf('ParamMouthForm'), 0)
})
