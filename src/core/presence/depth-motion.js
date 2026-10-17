// src/core/presence/depth-motion.js
// 前后（Z 轴）方向的动作：前倾凑近、探头看你、后仰松弛，以及「左右转身 + 轻微前后」
// 的常态复合摆动。用户拍板（2026-10-17）：现有动作只有左右平移/摆动，要补纵深方向，
// 幅度明显可感知但不夸张，衔接平滑无跳帧。
//
// 本文件是**纯逻辑状态机**：不碰 pixi、不碰 DOM、不读时钟（now 由调用方注入），
// 于是"位移/缩放/旋转的取值范围、过渡时长、有无跳帧"全部可以单测钉死。
// 渲染层（live2d.js）每帧调 update(now)，拿到两样东西分别落到两层：
//   · transform { scale, dx, dy } —— 套在模型外面的那一层容器（pixi Container）。
//     缩放/位移都绕**模型锚点**（取景带底边 = 肚脐线）进行，所以"探头"是头部长大靠近，
//     不是整张图乱飘；容器层绝不设 rotation（旋转走模型参数，画面不歪）。
//   · params { ParamAngleX: … } —— 模型参数增量，由渲染层 addParameterValueById 写入
//     （与 pose/rhythm 同款：只在当帧有效，不累积、不覆盖别的层）。
//
// 角度正负号是**实测**出来的（scripts/probe-angle-sign.mjs，2026-10-17，逐档截图比对）：
// 该模型的 ParamAngleX / ParamBodyAngleX **负 = 靠近屏幕（抬头/前倾），正 = 远离（低头/后仰）**
// ——与数学右手系相反，一切以像素为准。ParamAngleY = 左右转头、ParamAngleZ = 歪头，
// 侧头两侧对称用，不依赖正负号约定。

/** 缓动：Trigger 动作用（导出供单测断言曲线形状） */
export function easeOutCubic(t) {
  const x = clamp01(t)
  return 1 - (1 - x) ** 3
}

export function easeInOutSine(t) {
  const x = clamp01(t)
  return 0.5 - 0.5 * Math.cos(Math.PI * x)
}

const EASES = { outCubic: easeOutCubic, inOutSine: easeInOutSine }

/**
 * 触发式动作参数表。单位：
 *   scale —— 容器缩放增量（1.06 = 放大 6%）；dy —— 容器纵向位移（CSS 像素，负 = 向上）；
 *   rise/hold/fall —— 过渡时长（ms）：淡入 / 保持 / 淡出；
 *   params —— 模型参数目标值（角度，度）。
 * 取值范围的原则：明显可感知（≥6% 缩放 / ≥4px 位移 / ≥6° 角度）但不夸张
 * （缩放 ≤10%、位移 ≤10px、头部角度 ≤6°、身体角度 ≤2°）。身体角度刻意压低：
 * 待机摆头（动作期 ±5°）+ 时段表现（−1°）+ 思考姿态（−2°）都写同一族参数，
 * 全部叠起来也必须留在 ±10 的值域里，不靠核心静默裁切兜底。
 */
export const DEPTH_ACTIONS = {
  /** 身体前倾：轻微放大 + 上移，抬头关注（对话开始） */
  leanIn: {
    label: '前倾凑近',
    scale: 1.06,
    dy: -6,
    riseMs: 420,
    holdMs: 600,
    fallMs: 420,
    ease: 'outCubic',
    params: { ParamBodyAngleX: -2, ParamAngleX: -1.5 }
  },
  /** 探头看你：放大最多、上移最多、明显抬头，侧头方向每次随机（归来） */
  peek: {
    label: '探头看你',
    scale: 1.10,
    dy: -10,
    riseMs: 520,
    holdMs: 900,
    fallMs: 500,
    ease: 'outCubic',
    params: { ParamBodyAngleX: -1.5, ParamAngleX: -6, ParamAngleY: 4 }
  },
  /** 身体后仰：轻微缩小 + 下沉，松弛（说完一句靠回去） */
  leanBack: {
    label: '后仰松弛',
    scale: 0.95,
    dy: 10,
    riseMs: 460,
    holdMs: 700,
    fallMs: 460,
    ease: 'inOutSine',
    params: { ParamBodyAngleX: 3, ParamAngleX: 6 }
  }
}

/** 常态复合摆动（左右 + 前后）：永续循环，无人触发时也有"活着"的纵深呼吸 */
export const DEPTH_AMBIENT = {
  label: '常态纵深摆动',
  periodMs: 2400, // 一个完整来回
  yaw: 7, // ParamBodyAngleY 幅度（身体左右转）
  roll: 3, // ParamAngleZ 幅度（头歪）
  scale: 0.03, // 容器缩放幅度（转身时略微远近）
  dy: 4 // 容器纵向位移幅度（px）
}

/** 自动触发：常态摆动之外，没人管她时她自己偶尔前倾/探头/后仰 */
export const DEPTH_AUTO = {
  minGapMs: 16000,
  maxGapMs: 38000,
  pick: { leanIn: 0.55, peek: 0.25, leanBack: 0.2 }
}

/** 幅度上限（设置页滑杆 0~2，1 = 设计基准） */
export const DEPTH_AMOUNT_MAX = 2

/** 出厂默认 */
export const DEFAULT_DEPTH_CONFIG = { enabled: true, amount: 1, ambient: true, auto: true }

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function clampAmount(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(DEPTH_AMOUNT_MAX, n)
}

/**
 * 建一个 Z 轴动作状态机。
 * @param {{rng?:()=>number, now?:number, enabled?:boolean, amount?:number, ambient?:boolean, auto?:boolean}} opts
 *   rng 注入随机源（单测传确定性序列）；auto=false 关掉自动触发（单测/只想要常态摆动时）
 */
export function createDepthMotion(opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random
  const t0 = Number.isFinite(opts.now) ? opts.now : 0
  let enabled = opts.enabled !== false
  let amount = clampAmount(opts.amount ?? DEFAULT_DEPTH_CONFIG.amount)
  let ambientOn = opts.ambient !== false
  let autoOn = opts.auto !== false

  // 触发动作状态
  let mode = 'idle' // idle | leanIn | peek | leanBack
  let phase = 'idle' // idle | rise | hold | fall
  let phaseAt = t0
  let envStart = 0 // 本次 rise 的起点包络（打断时从当前值续上，不跳变）
  let fallFrom = 1 // 本次 fall 的起点包络（进 fall 时定格；绝不能读活的 env——会复利衰减）
  let env = 0 // 当前触发包络 0~1
  let side = 1 // peek 侧头方向（±1，触发时随机）
  let autoAt = t0 + randGap(rng)

  function randGap(r) {
    const { minGapMs, maxGapMs } = DEPTH_AUTO
    return minGapMs + r() * (maxGapMs - minGapMs)
  }

  function currentEnv(now) {
    if (mode === 'idle' || phase === 'idle') return 0
    const spec = DEPTH_ACTIONS[mode]
    const el = Math.max(0, now - phaseAt)
    if (phase === 'rise') {
      const k = clamp01(el / spec.riseMs)
      return envStart + (1 - envStart) * EASES[spec.ease](k)
    }
    if (phase === 'hold') return 1
    // fall：从进 fall 时定格的 fallFrom 淡出（读活 env 会每帧复利，衰减越来越快）
    const k = clamp01(el / spec.fallMs)
    return fallFrom * (1 - EASES[spec.ease](k))
  }

  /** 进入 fall：定格起点包络 */
  function enterFall(now) {
    phase = 'fall'
    phaseAt = now
    fallFrom = env
  }

  /**
   * 触发一个动作（或把正在进行的同一个动作重新计时）。
   * 打断不跳变：新动作的淡入从当前包络起跳。
   * @returns {boolean} 是否受理（未知动作名 / 已禁用 → false）
   */
  function trigger(name, now) {
    if (!enabled) return false
    const spec = DEPTH_ACTIONS[name]
    if (!spec) return false
    env = currentEnv(now)
    mode = name
    phase = 'rise'
    phaseAt = now
    envStart = env
    side = rng() < 0.5 ? -1 : 1
    autoAt = now + randGap(rng)
    return true
  }

  function release(now) {
    // 平滑收回：立刻转入 fall（从当前包络淡出到 0）
    if (mode === 'idle') return
    env = currentEnv(now)
    enterFall(now)
  }

  function setEnabled(on, now) {
    const next = !!on
    if (next === enabled) return
    enabled = next
    if (!enabled) release(now)
  }

  function setAmount(v) {
    amount = clampAmount(v)
  }

  function setAmbient(on) {
    ambientOn = !!on
  }

  function setAuto(on) {
    autoOn = !!on
    if (autoOn) autoAt = t0 + randGap(rng)
  }

  /**
   * 推进到 now，返回本帧输出。
   * @returns {{mode:string, phase:string, env:number, ambientEnv:number,
   *   transform:{scale:number,dx:number,dy:number}, params:object}}
   */
  function update(now) {
    const t = Number.isFinite(now) ? now : t0

    // ① 推进触发动作的阶段机。
    //    用循环而不是单次 if：一次 update 可能跨过多段时间（页面挂起后回来、
    //    单测里的大跳转），必须把 rise→hold→fall→idle 一次走完，
    //    否则"跳一大步只前进一个阶段"会让 env 卡在高位（duck 收不回来）。
    if (mode !== 'idle' && phase !== 'idle') {
      let guard = 0
      while (mode !== 'idle' && phase !== 'idle' && guard++ < 16) {
        const spec = DEPTH_ACTIONS[mode]
        const el = t - phaseAt
        if (phase === 'rise' && el >= spec.riseMs) {
          phase = 'hold'
          phaseAt += spec.riseMs
          env = 1
        } else if (phase === 'hold' && el >= spec.holdMs) {
          phase = 'fall'
          phaseAt += spec.holdMs
          env = 1
          fallFrom = 1
        } else if (phase === 'fall' && el >= spec.fallMs) {
          phase = 'idle'
          phaseAt += spec.fallMs
          env = 0
          mode = 'idle'
        } else {
          break
        }
      }
      env = currentEnv(t)
    } else {
      env = 0
    }

    // ② 自动触发（仅常态、且没有任何触发动作在跑时）
    if (enabled && autoOn && mode === 'idle' && t >= autoAt) {
      const r = rng()
      let acc = 0
      let pick = 'leanIn'
      for (const [k, p] of Object.entries(DEPTH_AUTO.pick)) {
        acc += p
        if (r < acc) {
          pick = k
          break
        }
      }
      trigger(pick, t)
      env = currentEnv(t)
    }

    // ③ 触发动作期间，常态摆动让位（duck 到 20%），免得两个意图打架
    const duck = 1 - 0.8 * env
    const ambientEnv = ambientOn && enabled ? duck : 0

    // ④ 常态复合摆动：左右转身（yaw）+ 歪头（roll）+ 前后（scale/dy）。
    //    前后分量与 yaw 差 π/2 相位 —— 转身掠过正面时最近、侧到极致时最远，
    //    读起来才是"一边转身一边前后"，而不是整体一起胀缩。
    const ph = ((t - t0) / DEPTH_AMBIENT.periodMs) * Math.PI * 2
    const aYaw = Math.sin(ph)
    const aRoll = Math.sin(ph + 1.0)
    const aDepth = Math.sin(ph + Math.PI / 2)

    // ⑤ 合成
    const scale = 1 + (DEPTH_AMBIENT.scale * aDepth * ambientEnv + (mode === 'idle' ? 0 : (DEPTH_ACTIONS[mode].scale - 1) * env)) * amount
    const dy = (DEPTH_AMBIENT.dy * aDepth * ambientEnv + (mode === 'idle' ? 0 : DEPTH_ACTIONS[mode].dy * env)) * amount

    const params = {}
    const push = (id, v) => {
      if (!Number.isFinite(v) || v === 0) return
      params[id] = (params[id] || 0) + v
    }
    // 常态（角度参数同样受 amount 与 duck 控制）
    push('ParamBodyAngleY', DEPTH_AMBIENT.yaw * aYaw * ambientEnv * amount)
    push('ParamAngleZ', DEPTH_AMBIENT.roll * aRoll * ambientEnv * amount)
    // 触发动作
    if (mode !== 'idle' && env > 0) {
      const spec = DEPTH_ACTIONS[mode]
      for (const [id, v] of Object.entries(spec.params)) {
        // peek 的侧头方向每次随机（±4°），其余参数两侧对称
        push(id, (id === 'ParamAngleY' ? v * side : v) * env * amount)
      }
    }

    return { mode, phase, env, ambientEnv, transform: { scale, dx: 0, dy }, params }
  }

  function state() {
    return { mode, phase, env, enabled, amount, ambient: ambientOn, auto: autoOn, autoAt }
  }

  return { trigger, release, update, state, setEnabled, setAmount, setAmbient, setAuto }
}
