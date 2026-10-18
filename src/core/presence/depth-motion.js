// src/core/presence/depth-motion.js
// 前后（Z 轴）方向的动作：前倾凑近、探头看你、后仰松弛，以及「左右转身 + 轻微前后」
// 的常态复合摆动。用户拍板（2026-10-17）：现有动作只有左右平移/摆动，要补纵深方向，
// 幅度明显可感知但不夸张，衔接平滑无跳帧。
//
// 本文件是**纯逻辑状态机**：不碰 pixi、不碰 DOM、不读时钟（now 由调用方注入），
// 于是"位移/缩放/旋转的取值范围、过渡时长、有无跳帧"全部可以单测钉死。
// 渲染层（live2d.js）每帧调 update(now)，拿到两样东西分别落到两层：
//   · transform { scale, dx, dy } —— 套在模型外面的那一层容器（pixi Container）。
//     缩放绕**颈肩支点**（DEPTH_PIVOT_FY）进行：支点在颈肩之间，所以放大时
//     "头长大往前探、肩膀基本不动"，而不是整张图一起胀。容器层绝不设 rotation
//     （旋转走模型参数，画面不歪）。
//   · params { ParamBodyAngleY: … } —— 模型参数增量，由渲染层 addParameterValueById 写入
//     （与 pose/rhythm 同款：只在当帧有效，不累积、不覆盖别的层）。
//
// ── 参数语义（2026-10-17 顶点级实测，scripts/probe-body-vertex2.mjs / probe-depth-params.mjs）
// ⚠ 旧注释把 X/Y 说反了，以下以实测为准（数值＝归一化模型单位，全身高约 1.2）：
//   ParamAngleX  ±8  → 只有头横移 0.014，纵移 0        ＝ **左右转头**
//   ParamAngleY  ±30 → 只有头纵移 0.005（很弱）        ＝ **上下点头**，效果太小，本模块不用
//   ParamAngleZ  ±8  → 头横移为主                      ＝ **歪头**
//   ParamBodyAngleX ±10 → 头/躯干**横移** 0.033        ＝ 身体左右摆
//   ParamBodyAngleY ±10 → 头纵移 +0.024 / −0.032、脚几乎不动、整体高矮 ±2%
//                                                       ＝ **身体纵向伸展/蜷缩** ★本模块主力
//   ParamBodyAngleZ ±10 → 头横移 0.046、躯干几乎不动   ＝ 身体倾斜
//   Param84「身体距离」/ Param82·83「身体x」→ 0/547 个部件有位移 ＝ **死参数，美术没绑**
//
// ── 为什么用 ParamBodyAngleY 承担"前倾/后仰"
// Cubism 是 2D 变形系统，**没有骨骼、没有深度轴**：要"真·弯腰前倾"只能靠美术在 moc 里
// 绑变形器，本模型没有（六个标准角度参数里没有一个是前后向的）。但 2D 投影里"身体前倾"
// 的物理特征恰恰是——躯干透视**缩短**、头往**下**探；"后仰"是躯干**伸展**、头往**上**抬。
// ParamBodyAngleY 正好就是这个形变（负=压缩+头下移，正=伸展+头上移），且是**真实几何形变**，
// 不是容器变换。所以用它作主体，容器缩放只做小幅"靠近/远离"的透视加成。
//
// ── 参数预算（值域写死在 moc：ParamBodyAngle* ∈ [−10, 10]，不靠核心静默裁切兜底）
//   ParamBodyAngleY：turn(set) ±6 + idle(add) ±4 + 本模块 ±3 → 最坏 13，仍会饱和。
//   实际 turn 与 idle 互斥（turn 激活时 idle 让位），本模块触发时 ambient 也让位到 20%，
//   常态最坏 = turn 6 + idle 0.8 + 3 = 9.8 ≤ 10 ✓；无 turn 时 = 4 + 3 = 7 ✓。

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
 *   scale —— 容器缩放增量（1.06 = 放大 6%）；dy —— 容器纵向位移（CSS 像素，**正 = 向下**）；
 *   rise/hold/fall —— 过渡时长（ms）：淡入 / 保持 / 淡出；
 *   params —— 模型参数目标值（角度，度）。
 *
 * 2026-10-17 重设计（用户要求：要"向前探头/弯腰"的姿态感，而不是整体前后平移）：
 *   · 姿态主体交给 **ParamBodyAngleY**（真实几何形变：躯干压缩/伸展 + 头上下），
 *     不再把它当"左右转身"用（那是 ParamBodyAngleX 的活，见下方实测注释）。
 *   · 容器缩放从原来的 10% 降到 4.5~6%，并且绕**颈肩支点**缩放（DEPTH_PIVOT_FY），
 *     放大时肩膀几乎不动、只有头在长大 —— 这才是"探头"，原来绕肚脐缩放到 10%
 *     是整个人均匀变大往上飘，读起来就是整体前后移动。
 *   · dy 方向随之反转：前倾**下**移（凑近）、后仰**上**移（退开）。
 *   取值范围：缩放 ≤6%、位移 ≤12px、身体角度 ≤3°（预算见文件头）。
 *
 * 2026-10-18 用户反馈「部分动作开始和结束都太过突兀」—— 过渡时间整体加长、
 * 曲线从 `outCubic`（起步速度最大 = 猛一下）换成 `inOutSine`（两端速度都是 0）：
 *   rise 420~520ms → 680~780ms、fall 420~500ms → 900~980ms。
 * 收尾比进入更长一点，因为"回到原位"比"动起来"更容易被看出突兀。
 */
export const DEPTH_ACTIONS = {
  /** 身体前倾：躯干略压缩 + 头下探 + 微微放大（对话开始） */
  leanIn: {
    label: '前倾凑近',
    scale: 1.045,
    dy: 7,
    riseMs: 680,
    holdMs: 600,
    fallMs: 900,
    ease: 'inOutSine',
    params: { ParamBodyAngleY: -2 }
  },
  /** 探头看你：压缩最多、头探得最低、放大最多，侧头方向每次随机（归来） */
  peek: {
    label: '探头看你',
    scale: 1.06,
    dy: 12,
    riseMs: 780,
    holdMs: 900,
    fallMs: 980,
    ease: 'inOutSine',
    params: { ParamBodyAngleY: -3, ParamAngleZ: 3 }
  },
  /** 身体后仰：躯干伸展 + 头上抬 + 略缩小（说完一句靠回去） */
  leanBack: {
    label: '后仰松弛',
    scale: 0.965,
    dy: -5,
    riseMs: 700,
    holdMs: 700,
    fallMs: 900,
    ease: 'inOutSine',
    params: { ParamBodyAngleY: 2.5 }
  }
}

/**
 * 容器缩放的**支点**（模型归一化纵向坐标 fy，0 = 画布顶、1 = 画布底）。
 * 实测（scripts/probe-framing-landmarks.mjs，按取景带渲染后逐行量剪影）：
 * 头顶 fy≈0.005、脸/下颌 0.17~0.21、**颈肩过渡 0.21~0.24**、肩 0.24~0.30、取景带底（肚脐）0.48。
 * 取 0.23 = 颈肩之间：放大时头往上长（离支点最远）、肩膀几乎不动 —— 读作"探头"；
 * 若取带底 0.48（旧行为）则是整片均匀放大，读作"整体前后移动"，已改掉。
 */
export const DEPTH_PIVOT_FY = 0.23

/**
 * 常态复合摆动（左右 + 前后）：永续循环，无人触发时也有"活着"的纵深呼吸。
 *
 * 2026-10-18 用户反馈「日常待机 Z 轴前后移动太夸张，大幅减小幅度和频率，
 * 只在特定动作可以让 Z 轴大幅移动」—— 降幅降频：
 *   · periodMs 2400 → **15000**：原来 2.4 秒一个来回（0.42Hz，肉眼就是"来回晃"），
 *     现在 15 秒一个来回（0.067Hz），只有长时间盯着才察觉得到"在呼吸"。
 *   · scale 0.025 → **0.0035**（±0.35%，几乎是呼吸级的尺度变化）
 *   · dy 3 → **0.5px**（亚像素级）
 *   · yaw 5 → 3、roll 3 → 2：左右摆与歪头属于同一套"待机摆动"，
 *     用户说"夸张"时它们也在贡献动感，一并收一档。
 * 大幅前后（scale 1.045~1.06 / dy 7~12px）只保留在 **DEPTH_ACTIONS 的触发动作**里。
 */
export const DEPTH_AMBIENT = {
  label: '常态纵深摆动',
  periodMs: 15000, // 一个完整来回（原来 2400，太快）
  yaw: 3, // ParamBodyAngleX 幅度（身体左右摆；实测它才是横移的那个，见文件头）
  roll: 2, // ParamAngleZ 幅度（头歪）
  scale: 0.0035, // 容器缩放幅度（转身时略微远近）
  dy: 0.5 // 容器纵向位移幅度（px）
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
    // 左右摆用 ParamBodyAngleX —— 实测它才是横移的那个（±10 → 头/躯干横移 0.033），
    // 旧代码写成 ParamBodyAngleY，而 Y 是纵向，等于"左右转身"根本没转身。
    push('ParamBodyAngleX', DEPTH_AMBIENT.yaw * aYaw * ambientEnv * amount)
    push('ParamAngleZ', DEPTH_AMBIENT.roll * aRoll * ambientEnv * amount)
    // 触发动作
    if (mode !== 'idle' && env > 0) {
      const spec = DEPTH_ACTIONS[mode]
      for (const [id, v] of Object.entries(spec.params)) {
        // peek 的歪头方向每次随机（±3°），其余参数两侧对称
        push(id, (id === 'ParamAngleZ' ? v * side : v) * env * amount)
      }
    }

    return { mode, phase, env, ambientEnv, transform: { scale, dx: 0, dy }, params }
  }

  function state() {
    return { mode, phase, env, enabled, amount, ambient: ambientOn, auto: autoOn, autoAt }
  }

  return { trigger, release, update, state, setEnabled, setAmount, setAmbient, setAuto }
}
