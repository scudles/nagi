// test/depth-motion.test.js
// Z 轴（前后）动作的纯逻辑验收。用户拍板（2026-10-17）的四条硬要求：
//   ① 有前倾 / 探头 / 后仰 / 左右+前后复合，且是常态或触发式都算数；
//   ② 位移、缩放、旋转的取值范围与过渡时长明确给出；
//   ③ 幅度明显可感知但不夸张；
//   ④ 衔接平滑、无跳帧。
// 角度正负号是实测约定：负 = 靠近屏幕（抬头/前倾），正 = 远离（低头/后仰）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEPTH_ACTIONS,
  DEPTH_AMBIENT,
  DEPTH_AMOUNT_MAX,
  DEFAULT_DEPTH_CONFIG,
  createDepthMotion,
  easeInOutSine,
  easeOutCubic
} from '../src/core/presence/depth-motion.js'

/** 确定性随机源：单测里 rng 完全可控 */
function seqRng(values) {
  let i = 0
  return () => values[i++ % values.length]
}

/** 以固定步长扫一段时间，收集每一帧的输出 */
function scan(dm, from, to, step = 16) {
  const out = []
  for (let t = from; t <= to; t += step) out.push({ t, ...dm.update(t) })
  return out
}

test('出厂默认：开启、基准幅度、常态摆动开', () => {
  assert.equal(DEFAULT_DEPTH_CONFIG.enabled, true)
  assert.equal(DEFAULT_DEPTH_CONFIG.amount, 1)
  assert.equal(DEPTH_AMOUNT_MAX, 2)
})

test('缓动曲线形状（过渡时长的"手感"由它决定）', () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  assert.ok(easeOutCubic(0.5) > 0.5, 'outCubic 前半程更快（动作"冲"出去）')
  assert.equal(easeInOutSine(0), 0)
  assert.equal(easeInOutSine(1), 1)
  assert.ok(Math.abs(easeInOutSine(0.5) - 0.5) < 1e-9, 'inOutSine 中点居中（后仰进出对称）')
})

test('中立态：容器恒等、参数全零（不干扰现有取景与姿态）', () => {
  // amount=0：任何叠加都必须是恒等变换
  const dm = createDepthMotion({ now: 0, amount: 0, auto: false })
  for (let t = 0; t <= 20000; t += 100) {
    const o = dm.update(t)
    assert.ok(Math.abs(o.transform.scale - 1) < 1e-12, `amount=0 时缩放必须恒为 1，t=${t} 得到 ${o.transform.scale}`)
    assert.equal(o.transform.dx, 0)
    assert.equal(Math.abs(o.transform.dy), 0)
    assert.deepEqual(o.params, {})
  }
  // 关闭开关：同样恒等（不留下"关了还在动"的残留）
  const off = createDepthMotion({ now: 0, auto: false })
  off.setEnabled(false, 0)
  for (let t = 0; t <= 5000; t += 100) {
    const o = off.update(t)
    assert.equal(o.transform.scale, 1)
    assert.equal(o.transform.dy, 0)
    assert.deepEqual(o.params, {})
  }
  // 开启时：全部落在常态摆动的声明包络内（±3% / ±4px），不会更大
  const on = createDepthMotion({ now: 0, auto: false })
  for (let t = 0; t <= 10000; t += 7) {
    const o = on.update(t)
    assert.ok(Math.abs(o.transform.scale - 1) <= DEPTH_AMBIENT.scale + 1e-9, `常态缩放不得超过 ±${DEPTH_AMBIENT.scale}`)
    assert.ok(Math.abs(o.transform.dy) <= DEPTH_AMBIENT.dy + 1e-9, `常态位移不得超过 ±${DEPTH_AMBIENT.dy}px`)
    assert.ok(Math.abs(o.params.ParamBodyAngleY || 0) <= DEPTH_AMBIENT.yaw + 1e-9)
    assert.ok(Math.abs(o.params.ParamAngleZ || 0) <= DEPTH_AMBIENT.roll + 1e-9)
  }
})

test('三个触发动作的取值范围都在声明值内（幅度可感知但不夸张）', () => {
  for (const [name, spec] of Object.entries(DEPTH_ACTIONS)) {
    const dm = createDepthMotion({ now: 0, auto: false })
    assert.equal(dm.trigger(name, 0), true, `${name} 应被受理`)
    const total = spec.riseMs + spec.holdMs + spec.fallMs
    const frames = scan(dm, 0, total + 2000)
    let maxScale = -Infinity
    let minScale = Infinity
    let maxAbsDy = 0
    let maxAbsAngleX = 0
    let maxAbsBodyX = 0
    for (const f of frames) {
      maxScale = Math.max(maxScale, f.transform.scale)
      minScale = Math.min(minScale, f.transform.scale)
      maxAbsDy = Math.max(maxAbsDy, Math.abs(f.transform.dy))
      maxAbsAngleX = Math.max(maxAbsAngleX, Math.abs(f.params.ParamAngleX || 0))
      maxAbsBodyX = Math.max(maxAbsBodyX, Math.abs(f.params.ParamBodyAngleX || 0))
    }
    // 缩放：峰值必须达到声明值（可感知），且不超过「声明值 + 常态残余」。
    // 残余含两段：触发期间常态摆动 duck 到 20%（0.03×0.2），
    // 以及扫描窗口覆盖到动作结束之后、常态恢复全量时的 ±3% 自在摆动。
    const peakScale = name === 'leanBack' ? minScale : maxScale
    assert.ok(Math.abs(peakScale - spec.scale) < 0.035, `${name} 缩放峰值应约等于 ${spec.scale}，实际 ${peakScale.toFixed(3)}`)
    const bound = Math.max(Math.abs(spec.scale - 1), DEPTH_AMBIENT.scale) + DEPTH_AMBIENT.scale * 0.2
    assert.ok(maxScale - 1 <= bound + 1e-9, `${name} 放大总幅度不得超过 ${bound.toFixed(3)}，实际 ${(maxScale - 1).toFixed(4)}`)
    assert.ok(1 - minScale <= bound + 1e-9, `${name} 缩小总幅度不得超过 ${bound.toFixed(3)}，实际 ${(1 - minScale).toFixed(4)}`)
    // 位移：峰值达到声明值，总量不超 10px + 常态 4px
    assert.ok(Math.abs(maxAbsDy - Math.abs(spec.dy)) < 4.5, `${name} 位移峰值应约等于 ${spec.dy}px，实际 ${maxAbsDy.toFixed(2)}`)
    assert.ok(maxAbsDy <= 14 + 1e-9, `${name} 位移不得超过 14px（触发 10 + 常态 4）`)
    // 角度：不超过声明幅度 + 余量；且必须够大（一眼可辨）
    const declared = Math.max(...Object.values(spec.params).map(Math.abs))
    assert.ok(maxAbsAngleX <= declared + 1e-9, `${name} 头部角度不得超过声明值 ${declared}`)
    assert.ok(maxAbsBodyX <= declared + 1e-9, `${name} 身体角度不得超过声明值`)
    if (spec.params.ParamAngleX) {
      assert.ok(maxAbsAngleX >= 1.4, `${name} 头部角度必须明显可感知（≥1.4°），实际 ${maxAbsAngleX.toFixed(2)}`)
    }
  }
})

test('peek：侧头方向两侧都会出现（rng 可控）', () => {
  const dm = createDepthMotion({ now: 0, auto: false, rng: seqRng([0.9, 0.1, 0.9, 0.1]) })
  const sides = new Set()
  for (const r of [0.9, 0.1, 0.9, 0.1]) {
    const d = createDepthMotion({ now: 0, auto: false, rng: seqRng([r]) })
    d.trigger('peek', 0)
    const o = d.update(520) // rise 结束
    sides.add(Math.sign(o.params.ParamAngleY || 0))
  }
  assert.ok(sides.has(1) && sides.has(-1), `侧头应有 ± 两个方向，实际 ${[...sides]}`)
  assert.equal(dm.state().mode, 'idle')
})

test('方向语义：前倾/探头是负角（靠近），后仰是正角（远离）', () => {
  const up = createDepthMotion({ now: 0, auto: false })
  up.trigger('peek', 0)
  const oUp = up.update(520 + 450) // rise 中点后进入 hold
  assert.ok((oUp.params.ParamAngleX || 0) < -5, `探头应明显抬头（负角），实际 ${oUp.params.ParamAngleX}`)
  assert.ok((oUp.params.ParamBodyAngleX || 0) < 0, '探头应伴随身体前倾（负角）')
  assert.ok(oUp.transform.scale > 1.05, '探头应放大')
  assert.ok(oUp.transform.dy < -5, '探头应上移')

  const back = createDepthMotion({ now: 0, auto: false })
  back.trigger('leanBack', 0)
  const oBack = back.update(460 + 350)
  assert.ok((oBack.params.ParamAngleX || 0) > 4, `后仰应略微垂首/后撤（正角），实际 ${oBack.params.ParamAngleX}`)
  assert.ok((oBack.params.ParamBodyAngleX || 0) > 0, '后仰应伴随身体后撤（正角）')
  assert.ok(oBack.transform.scale < 0.96, '后仰应缩小')
  assert.ok(oBack.transform.dy > 5, '后仰应下沉')
})

test('时长契约：rise/hold/fall 三段各就各位，总时长符合声明', () => {
  const spec = DEPTH_ACTIONS.leanIn
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('leanIn', 0)
  // rise 中点：包络介于 0 和 1 之间（正在过渡）
  const mid = dm.update(spec.riseMs / 2)
  assert.equal(mid.phase, 'rise')
  assert.ok(mid.env > 0 && mid.env < 1, `rise 中点包络应在 (0,1)，实际 ${mid.env}`)
  // rise 结束进 hold
  const hold = dm.update(spec.riseMs)
  assert.equal(hold.phase, 'hold')
  assert.ok(Math.abs(hold.env - 1) < 1e-9)
  // hold 结束进 fall
  const fall = dm.update(spec.riseMs + spec.holdMs)
  assert.equal(fall.phase, 'fall')
  // fall 结束回 idle
  const done = dm.update(spec.riseMs + spec.holdMs + spec.fallMs)
  assert.equal(done.mode, 'idle')
  assert.equal(done.env, 0)
})

test('无跳帧：连续帧之间的包络与位移变化有上界（Lipschitz）', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('peek', 0)
  let prev = dm.update(0)
  const step = 16
  for (let t = step; t <= 1920 + 200; t += step) {
    const cur = dm.update(t)
    const dEnv = Math.abs(cur.env - prev.env)
    const dScale = Math.abs(cur.transform.scale - prev.transform.scale)
    const dDy = Math.abs(cur.transform.dy - prev.transform.dy)
    // 最快的一段（outCubic rise 的起点斜率 3/duration）留 1.5× 余量
    assert.ok(dEnv <= (3 * step) / 520 * 1.5 + 1e-9, `包络跳变 ${dEnv.toFixed(4)} @t=${t}`)
    assert.ok(dScale <= 0.10 * 1.5 * (step / 520) * 3 + 1e-9, `缩放跳变 ${dScale.toFixed(4)} @t=${t}`)
    assert.ok(dDy <= 10 * 1.5 * (step / 520) * 3 + 1e-9, `位移跳变 ${dDy.toFixed(4)} @t=${t}`)
    prev = cur
  }
})

test('打断不跳变：前倾未结束时探头，从当前包络续上', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('leanIn', 0)
  const before = dm.update(200) // rise 中途
  const envBefore = before.env
  dm.trigger('peek', 200)
  const after = dm.update(200)
  assert.ok(Math.abs(after.env - envBefore) < 1e-9, `打断后包络应连续：${envBefore} → ${after.env}`)
  assert.equal(after.mode, 'peek')
})

test('常态复合摆动：左右转身 + 前后不同相，周期 2400ms', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  const frames = scan(dm, 0, 4800, 8)
  // yaw（身体左右转）应完整摆过 ±7
  let yawMin = Infinity
  let yawMax = -Infinity
  let scaleMin = Infinity
  let scaleMax = -Infinity
  let dyMin = Infinity
  let dyMax = -Infinity
  for (const f of frames) {
    const yaw = f.params.ParamBodyAngleY || 0
    yawMin = Math.min(yawMin, yaw)
    yawMax = Math.max(yawMax, yaw)
    scaleMin = Math.min(scaleMin, f.transform.scale)
    scaleMax = Math.max(scaleMax, f.transform.scale)
    dyMin = Math.min(dyMin, f.transform.dy)
    dyMax = Math.max(dyMax, f.transform.dy)
  }
  assert.ok(yawMin <= -6.5 && yawMax >= 6.5, `身体左右转应摆满 ±7，实际 [${yawMin.toFixed(2)}, ${yawMax.toFixed(2)}]`)
  assert.ok(scaleMax - 1 >= 0.025 && 1 - scaleMin >= 0.025, `前后缩放幅度应约 ±3%，实际 [${scaleMin.toFixed(3)}, ${scaleMax.toFixed(3)}]`)
  assert.ok(dyMin <= -3.5 && dyMax >= 3.5, `前后位移幅度应约 ±4px，实际 [${dyMin.toFixed(2)}, ${dyMax.toFixed(2)}]`)
  // 复合而非同步：yaw 的零点与前后分量的极值点应对齐（相位差 π/2）
  let yawZeroT = -1
  for (const f of frames) {
    if (yawZeroT < 0 && f.t > 400 && Math.abs((f.params.ParamBodyAngleY || 0)) < 0.05) {
      yawZeroT = f.t
      break
    }
  }
  const nearZero = frames.find((f) => Math.abs(f.t - yawZeroT) < 40)
  assert.ok(nearZero && Math.abs(nearZero.transform.scale - 1) > 0.02, 'yaw 过正面时前后分量应接近极值（复合动作）')
  // 周期：yaw 两次向上过零的间距 ≈ 2400ms
  const zeros = frames.filter((f) => f.t > 100 && (f.params.ParamBodyAngleY || 0) > 0 && ((frames[frames.indexOf(f) - 1]?.params?.ParamBodyAngleY) || 0) <= 0).map((f) => f.t)
  if (zeros.length >= 2) {
    assert.ok(Math.abs(zeros[1] - zeros[0] - DEPTH_AMBIENT.periodMs) < 40, `周期应约 ${DEPTH_AMBIENT.periodMs}ms，实际 ${zeros[1] - zeros[0]}`)
  }
})

test('触发期间常态摆动让位（duck），结束后恢复', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  const idleEnv = dm.update(100).ambientEnv
  assert.equal(idleEnv, 1, '常态摆动默认全量')
  dm.trigger('peek', 100)
  const during = dm.update(100 + 520) // rise 结束
  assert.ok(during.ambientEnv < 0.3, `触发期间常态摆动应让位，实际 ${during.ambientEnv}`)
  const after = dm.update(100 + 520 + 900 + 500 + 50)
  assert.equal(after.ambientEnv, 1, '动作结束后常态摆动恢复')
})

test('自动触发：没人管她时她自己也会前倾/探头/后仰', () => {
  const dm = createDepthMotion({ now: 0, rng: seqRng([0.5, 0.5]) })
  // autoAt 初始在 16~38s 之间；一路平推到 40s 必然触发过一次
  let fired = false
  for (let t = 0; t <= 40000; t += 100) {
    const o = dm.update(t)
    if (o.mode !== 'idle') {
      fired = true
      assert.ok(Object.keys(DEPTH_ACTIONS).includes(o.mode), `自动触发的应是已知动作，实际 ${o.mode}`)
      break
    }
  }
  assert.ok(fired, '40 秒内应发生至少一次自动触发')
})

test('关开关是平滑收回，不是硬切；关闭期间触发被拒绝', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('leanIn', 0)
  dm.update(420) // rise 结束，env=1
  dm.setEnabled(false, 420)
  assert.equal(dm.trigger('peek', 420), false, '关闭期间触发应被拒绝')
  const mid = dm.update(420 + 200)
  assert.ok(mid.env > 0 && mid.env < 1, `关闭时应平滑淡出，实际 env=${mid.env}`)
  const done = dm.update(420 + 460 + 50)
  assert.equal(done.env, 0)
  assert.equal(done.mode, 'idle')
  // 关闭期间常态摆动也归零（否则"关了还在动"）
  assert.equal(done.ambientEnv, 0)
})

test('amount 滑杆线性缩放全部输出（0 = 完全关闭，2 = 双倍）', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('peek', 0)
  const base = dm.update(520)
  dm.setAmount(0)
  const zero = dm.update(520)
  assert.equal(zero.transform.scale, 1)
  assert.deepEqual(zero.params, {})
  dm.setAmount(2)
  const dbl = dm.update(520)
  assert.ok(Math.abs(dbl.transform.scale - 1 - (base.transform.scale - 1) * 2) < 1e-9, 'amount=2 时位移/缩放应翻倍')
  assert.ok(Math.abs(dbl.params.ParamAngleX - base.params.ParamAngleX * 2) < 1e-9)
  // 但 amount=2 也不允许突破"不夸张"的上限：触发 10% + 常态残余 3%×20%，都按 amount 放大
  const cap = 1 + (0.10 + DEPTH_AMBIENT.scale * 0.2) * 2
  assert.ok(dbl.transform.scale <= cap + 1e-9, `amount=2 缩放不得超过 ${cap.toFixed(3)}，实际 ${dbl.transform.scale.toFixed(4)}`)
  assert.ok(Math.abs(dbl.params.ParamAngleX) <= 6 * 2 + 1e-9)
})

test('release()：外部要求收回时平滑归零', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  dm.trigger('leanBack', 0)
  dm.update(460)
  dm.release(460)
  const mid = dm.update(460 + 230)
  assert.ok(mid.env > 0 && mid.env < 1)
  const done = dm.update(460 + 460 + 50)
  assert.equal(done.env, 0)
})
