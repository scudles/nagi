// test/depth-motion.test.js
// Z 轴（前后）动作的纯逻辑验收。用户拍板（2026-10-17）的四条硬要求：
//   ① 有前倾 / 探头 / 后仰 / 左右+前后复合，且是常态或触发式都算数；
//   ② 位移、缩放、旋转的取值范围与过渡时长明确给出；
//   ③ 幅度明显可感知但不夸张；
//   ④ 衔接平滑、无跳帧。
// 角度语义（2026-10-17 顶点级实测，见 depth-motion.js 文件头）：
//   ParamBodyAngleY **负 = 躯干压缩 + 头下探（前倾）**，正 = 躯干伸展 + 头上抬（后仰）；
//   ParamBodyAngleX = 身体左右摆；ParamAngleZ = 歪头（± 随侧头方向）。
// ⚠ 旧版把 ParamAngleX 当"抬头/前倾"用是错的：实测 ParamAngleX 只产生横移（左右转头）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEPTH_ACTIONS,
  DEPTH_AMBIENT,
  DEPTH_AMOUNT_MAX,
  DEPTH_PIVOT_FY,
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
  // 开启时：全部落在常态摆动的声明包络内（±2.5% / ±3px / ±5° / ±3°），不会更大
  const on = createDepthMotion({ now: 0, auto: false })
  for (let t = 0; t <= 10000; t += 7) {
    const o = on.update(t)
    assert.ok(Math.abs(o.transform.scale - 1) <= DEPTH_AMBIENT.scale + 1e-9, `常态缩放不得超过 ±${DEPTH_AMBIENT.scale}`)
    assert.ok(Math.abs(o.transform.dy) <= DEPTH_AMBIENT.dy + 1e-9, `常态位移不得超过 ±${DEPTH_AMBIENT.dy}px`)
    // 左右摆走 ParamBodyAngleX（实测它才是横移的那个）
    assert.ok(Math.abs(o.params.ParamBodyAngleX || 0) <= DEPTH_AMBIENT.yaw + 1e-9)
    assert.ok(Math.abs(o.params.ParamAngleZ || 0) <= DEPTH_AMBIENT.roll + 1e-9)
  }
})

test('缩放支点落在颈肩之间（不在肚脐，否则就是整体前后移动）', () => {
  // 实测地标（scripts/probe-framing-landmarks.mjs）：头顶 fy≈0.005、
  // 脸/下颌 0.17~0.21、颈肩过渡 0.21~0.24、肩 0.24~0.30、取景带底（肚脐）0.48。
  assert.ok(DEPTH_PIVOT_FY > 0.15, `支点必须在脸以下（否则头不会"探"出去），实际 ${DEPTH_PIVOT_FY}`)
  assert.ok(DEPTH_PIVOT_FY < 0.30, `支点必须在肩以上（否则肩膀跟着一起胀 = 整体移动），实际 ${DEPTH_PIVOT_FY}`)
  // 与取景带底（肚脐 0.48）必须有足够距离，缩放才读得出"头在长"
  assert.ok(0.48 - DEPTH_PIVOT_FY > 0.15, `支点与带底的距离要够（实际 ${(0.48 - DEPTH_PIVOT_FY).toFixed(3)}）`)
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
    let maxAbsBodyY = 0
    let maxAbsRoll = 0
    for (const f of frames) {
      maxScale = Math.max(maxScale, f.transform.scale)
      minScale = Math.min(minScale, f.transform.scale)
      maxAbsDy = Math.max(maxAbsDy, Math.abs(f.transform.dy))
      maxAbsBodyY = Math.max(maxAbsBodyY, Math.abs(f.params.ParamBodyAngleY || 0))
      maxAbsRoll = Math.max(maxAbsRoll, Math.abs(f.params.ParamAngleZ || 0))
    }
    // 缩放：峰值必须达到声明值（可感知），且不超过「声明值 + 常态残余」。
    // 残余含两段：触发期间常态摆动 duck 到 20%（0.03×0.2），
    // 以及扫描窗口覆盖到动作结束之后、常态恢复全量时的 ±3% 自在摆动。
    const peakScale = name === 'leanBack' ? minScale : maxScale
    assert.ok(Math.abs(peakScale - spec.scale) < 0.035, `${name} 缩放峰值应约等于 ${spec.scale}，实际 ${peakScale.toFixed(3)}`)
    const bound = Math.max(Math.abs(spec.scale - 1), DEPTH_AMBIENT.scale) + DEPTH_AMBIENT.scale * 0.2
    assert.ok(maxScale - 1 <= bound + 1e-9, `${name} 放大总幅度不得超过 ${bound.toFixed(3)}，实际 ${(maxScale - 1).toFixed(4)}`)
    assert.ok(1 - minScale <= bound + 1e-9, `${name} 缩小总幅度不得超过 ${bound.toFixed(3)}，实际 ${(1 - minScale).toFixed(4)}`)
    // 位移：峰值达到声明值，总量不超「触发 12 + 常态 3」
    assert.ok(Math.abs(maxAbsDy - Math.abs(spec.dy)) < 4.5, `${name} 位移峰值应约等于 ${spec.dy}px，实际 ${maxAbsDy.toFixed(2)}`)
    assert.ok(maxAbsDy <= 15 + 1e-9, `${name} 位移不得超过 15px（触发 12 + 常态 3），实际 ${maxAbsDy.toFixed(2)}`)
    // 角度：不超过声明幅度 + 余量
    const declared = Math.max(...Object.values(spec.params).map(Math.abs))
    assert.ok(maxAbsBodyY <= declared + 1e-9, `${name} 身体角度不得超过声明值 ${declared}，实际 ${maxAbsBodyY}`)
    // 歪头（ParamAngleZ）同时被常态摆动写（±roll）：触发期间常态 duck 到 20%，
    // 扫描窗口又覆盖到动作结束后的全量常态，取两者的较大者
    const declaredRoll = Math.max(
      Math.abs(spec.params.ParamAngleZ || 0) + DEPTH_AMBIENT.roll * 0.2,
      DEPTH_AMBIENT.roll
    )
    assert.ok(maxAbsRoll <= declaredRoll + 1e-9, `${name} 歪头角度不得超过 ${declaredRoll}，实际 ${maxAbsRoll}`)
    // ★幅度下限：只验方向等于没验（2026-10-17 教训）。身体俯仰必须真的走到声明值，
    // 且实测可感知的下限是 2°（ParamBodyAngleY −2 时头下移约 8px@588px 取景带）。
    if (spec.params.ParamBodyAngleY) {
      assert.ok(maxAbsBodyY >= Math.abs(spec.params.ParamBodyAngleY) * 0.95,
        `${name} 身体俯仰必须真的摆到 ${spec.params.ParamBodyAngleY}°，实际峰值 ${maxAbsBodyY.toFixed(2)}`)
      assert.ok(maxAbsBodyY >= 2, `${name} 身体俯仰峰值不得低于 2°（低于此在画面上看不出来），实际 ${maxAbsBodyY.toFixed(2)}`)
    }
    // 缩放同样补下限：达到声明值的 95%
    if (spec.scale > 1) {
      assert.ok(maxScale - 1 >= (spec.scale - 1) * 0.95, `${name} 放大必须真的走到 ${spec.scale}，实际 ${maxScale.toFixed(4)}`)
    } else {
      assert.ok(1 - minScale >= (1 - spec.scale) * 0.95, `${name} 缩小必须真的走到 ${spec.scale}，实际 ${minScale.toFixed(4)}`)
    }
  }
})

test('peek：歪头方向两侧都会出现（rng 可控）', () => {
  const dm = createDepthMotion({ now: 0, auto: false, rng: seqRng([0.9, 0.1, 0.9, 0.1]) })
  const sides = new Set()
  for (const r of [0.9, 0.1, 0.9, 0.1]) {
    const d = createDepthMotion({ now: 0, auto: false, rng: seqRng([r]) })
    d.trigger('peek', 0)
    const o = d.update(520) // rise 结束
    sides.add(Math.sign(o.params.ParamAngleZ || 0))
  }
  assert.ok(sides.has(1) && sides.has(-1), `歪头应有 ± 两个方向，实际 ${[...sides]}`)
  assert.equal(dm.state().mode, 'idle')
})

test('方向语义：前倾/探头是躯干压缩 + 头下探 + 放大下移，后仰反之', () => {
  const fwd = createDepthMotion({ now: 0, auto: false })
  fwd.trigger('peek', 0)
  const oF = fwd.update(520 + 450) // rise 结束进 hold
  assert.ok((oF.params.ParamBodyAngleY || 0) < -2.5, `探头应明显压缩躯干（负角），实际 ${oF.params.ParamBodyAngleY}`)
  assert.ok(oF.transform.scale > 1.05, `探头应放大，实际 ${oF.transform.scale}`)
  assert.ok(oF.transform.dy > 5, `探头应**下**移（头往前下方探），实际 dy=${oF.transform.dy}`)

  const back = createDepthMotion({ now: 0, auto: false })
  back.trigger('leanBack', 0)
  const oB = back.update(460 + 350)
  assert.ok((oB.params.ParamBodyAngleY || 0) > 2, `后仰应伸展躯干（正角），实际 ${oB.params.ParamBodyAngleY}`)
  assert.ok(oB.transform.scale < 0.97, `后仰应缩小，实际 ${oB.transform.scale}`)
  assert.ok(oB.transform.dy < 0, `后仰应上移（退回去），实际 dy=${oB.transform.dy}`)

  // 前后两个方向必须真的相反（曾经把 X/Y 搞反过，方向语义必须钉死）
  assert.ok(Math.sign(oF.params.ParamBodyAngleY) === -Math.sign(oB.params.ParamBodyAngleY), '前倾与后仰的身体角度必须反号')
  assert.ok(Math.sign(oF.transform.dy) === -Math.sign(oB.transform.dy), '前倾与后仰的纵向位移必须反号')
  assert.ok(Math.sign(oF.transform.scale - 1) === -Math.sign(oB.transform.scale - 1), '前倾放大、后仰缩小必须相反')
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
    // 最快的一段（outCubic rise 的起点斜率 3/duration）留 1.5× 余量；
    // 常数按**当前声明值**写死（缩放 0.06、位移 12px），改配置必须同步改这里
    assert.ok(dEnv <= (3 * step) / 520 * 1.5 + 1e-9, `包络跳变 ${dEnv.toFixed(4)} @t=${t}`)
    assert.ok(dScale <= 0.06 * 1.5 * (step / 520) * 3 + 1e-9, `缩放跳变 ${dScale.toFixed(4)} @t=${t}`)
    assert.ok(dDy <= 12 * 1.5 * (step / 520) * 3 + 1e-9, `位移跳变 ${dDy.toFixed(4)} @t=${t}`)
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

test('常态复合摆动：左右转身 + 前后不同相，周期与幅度按配置', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  // 扫描窗口覆盖两个完整周期（周期 2026-10-18 由 2400ms 放宽到 15000ms）
  const P = DEPTH_AMBIENT.periodMs
  const frames = scan(dm, 0, P * 2, Math.round(P / 120))
  let yawMin = Infinity
  let yawMax = -Infinity
  let scaleMin = Infinity
  let scaleMax = -Infinity
  let dyMin = Infinity
  let dyMax = -Infinity
  for (const f of frames) {
    const yaw = f.params.ParamBodyAngleX || 0
    yawMin = Math.min(yawMin, yaw)
    yawMax = Math.max(yawMax, yaw)
    scaleMin = Math.min(scaleMin, f.transform.scale)
    scaleMax = Math.max(scaleMax, f.transform.scale)
    dyMin = Math.min(dyMin, f.transform.dy)
    dyMax = Math.max(dyMax, f.transform.dy)
  }
  // 幅度一律按配置的 90% 当下限（采样比正弦峰值稀疏，留一点余量）
  assert.ok(
    yawMin <= -DEPTH_AMBIENT.yaw * 0.9 && yawMax >= DEPTH_AMBIENT.yaw * 0.9,
    `身体左右摆应摆满 ±${DEPTH_AMBIENT.yaw}，实际 [${yawMin.toFixed(2)}, ${yawMax.toFixed(2)}]`
  )
  assert.ok(
    scaleMax - 1 >= DEPTH_AMBIENT.scale * 0.9 && 1 - scaleMin >= DEPTH_AMBIENT.scale * 0.9,
    `前后缩放幅度应约 ±${DEPTH_AMBIENT.scale}，实际 [${scaleMin.toFixed(4)}, ${scaleMax.toFixed(4)}]`
  )
  assert.ok(
    dyMin <= -DEPTH_AMBIENT.dy * 0.9 && dyMax >= DEPTH_AMBIENT.dy * 0.9,
    `前后位移幅度应约 ±${DEPTH_AMBIENT.dy}px，实际 [${dyMin.toFixed(2)}, ${dyMax.toFixed(2)}]`
  )
  // 复合而非同步：yaw 的零点与前后分量的极值点应对齐（相位差 π/2）
  let yawZeroT = -1
  for (const f of frames) {
    if (yawZeroT < 0 && f.t > 400 && Math.abs(f.params.ParamBodyAngleX || 0) < DEPTH_AMBIENT.yaw * 0.02) {
      yawZeroT = f.t
      break
    }
  }
  const nearZero = frames.find((f) => Math.abs(f.t - yawZeroT) < P / 60)
  assert.ok(
    nearZero && Math.abs(nearZero.transform.scale - 1) > DEPTH_AMBIENT.scale * 0.6,
    'yaw 过正面时前后分量应接近极值（复合动作）'
  )
  // 周期：yaw 两次向上过零的间距 ≈ periodMs
  const zeros = frames
    .filter(
      (f) =>
        f.t > 100 &&
        (f.params.ParamBodyAngleX || 0) > 0 &&
        (frames[frames.indexOf(f) - 1]?.params?.ParamBodyAngleX || 0) <= 0
    )
    .map((f) => f.t)
  if (zeros.length >= 2) {
    assert.ok(
      Math.abs(zeros[1] - zeros[0] - P) < P / 30,
      `周期应约 ${P}ms，实际 ${zeros[1] - zeros[0]}`
    )
  }
})

test('触发期间常态摆动让位（duck），结束后恢复', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  const idleEnv = dm.update(100).ambientEnv
  assert.equal(idleEnv, 1, '常态摆动默认全量')
  dm.trigger('peek', 100)
  const P = DEPTH_ACTIONS.peek
  const during = dm.update(100 + P.riseMs) // rise 结束，env=1
  assert.ok(during.ambientEnv < 0.3, `触发期间常态摆动应让位，实际 ${during.ambientEnv}`)
  const after = dm.update(100 + P.riseMs + P.holdMs + P.fallMs + 50)
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
  // 时长一律**实读配置**（D40：期望值与配置同源，改过渡时长不该让测试假失败）
  const L = DEPTH_ACTIONS.leanIn
  dm.trigger('leanIn', 0)
  dm.update(L.riseMs) // rise 结束，env=1
  dm.setEnabled(false, L.riseMs)
  assert.equal(dm.trigger('peek', L.riseMs), false, '关闭期间触发应被拒绝')
  const mid = dm.update(L.riseMs + Math.round(L.fallMs / 2))
  assert.ok(mid.env > 0 && mid.env < 1, `关闭时应平滑淡出，实际 env=${mid.env}`)
  const done = dm.update(L.riseMs + L.fallMs + 50)
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
  assert.ok(Math.abs((dbl.params.ParamBodyAngleY || 0) - (base.params.ParamBodyAngleY || 0) * 2) < 1e-9, 'amount=2 时身体角度应翻倍')
  // 但 amount=2 也不允许突破"不夸张"的上限：触发 6% + 常态残余 2.5%×20%，都按 amount 放大
  const cap = 1 + (0.06 + DEPTH_AMBIENT.scale * 0.2) * 2
  assert.ok(dbl.transform.scale <= cap + 1e-9, `amount=2 缩放不得超过 ${cap.toFixed(3)}，实际 ${dbl.transform.scale.toFixed(4)}`)
  assert.ok(Math.abs(dbl.params.ParamBodyAngleY || 0) <= 3 * 2 + 1e-9)
})

test('release()：外部要求收回时平滑归零', () => {
  const dm = createDepthMotion({ now: 0, auto: false })
  const B = DEPTH_ACTIONS.leanBack
  dm.trigger('leanBack', 0)
  dm.update(B.riseMs)
  dm.release(B.riseMs)
  const mid = dm.update(B.riseMs + Math.round(B.fallMs / 2))
  assert.ok(mid.env > 0 && mid.env < 1)
  const done = dm.update(B.riseMs + B.fallMs + 50)
  assert.equal(done.env, 0)
})
