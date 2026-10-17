// src/core/ambient.js
// 待机行为（Ambient）：没人跟她说话的时候，她自己怎么待着。
//
// 三件事，都是纯逻辑（可注入假时钟，见 test/ambient.test.js）：
//   ① 注视 —— 事件驱动的**微注视**，不是持续跟随鼠标。
//      节制版口径：明显移动才触发、距上次 >6s、看 1.6~2.8s 就移开、
//      移开后冷却 4~10s、她说话/播动作时根本不看、长时间不动不看。
//      （2026-10-15 曾彻底取消"跟随鼠标"，因为鼠标停哪儿她盯哪儿很诡异；
//        这里是把注视做成有节制的**高光行为**，静默时仍然归中，不是回退。）
//   ② 小动作 —— 空闲够久 + 到点 + 不静默，才允许她动一下。保守档 5~10 分钟一次。
//   ③ 换装 —— 契机要"合乎情理"：时段、情绪、长空闲、"在听音乐"。
//      一天最多几次、间隔够长，宁可少也不能变成抽风式换装。
//
// 渲染层只管把这里的决定落到模型上，不自己判断该不该做（职责分离）。

/** 活动分类 → 待机基调。来自 core/monitor/tracker.js 的 CATEGORY */
export const TONE = {
  QUIET: 'quiet', // 安静陪着：不主动搭话、少动
  NORMAL: 'normal',
  ATTENTIVE: 'attentive' // 她在看你在看什么：更容易凑近、做反应
}

/**
 * 待机基调：她在"看你做事"这件事上的态度。
 * 工作/浏览器 = 陪你安静的时段；视频/游戏 = 她会更好奇，容易凑过来。
 */
export const CATEGORY_TONE = {
  work: TONE.QUIET,
  browser: TONE.QUIET,
  social: TONE.QUIET,
  video: TONE.ATTENTIVE,
  gaming: TONE.ATTENTIVE,
  other: TONE.NORMAL
}

export function toneForCategory(category) {
  return CATEGORY_TONE[String(category || '').toLowerCase()] || TONE.NORMAL
}

/** 时段 → 她更可能穿成什么样（只作为"契机"，不是硬性规则） */
export const RHYTHM_LOOK_HINTS = {
  morning: 'daily',
  noon: 'going_out',
  afternoon: 'going_out',
  evening: 'home',
  night: 'night'
}

/** 保守 / 中等 / 活泼三档（用户选了保守） */
export const AMBIENT_PRESETS = {
  conservative: {
    gazeMinGapMs: 6000,
    gazeHoldMs: [1600, 2800],
    gazeAvertMs: [4000, 10000],
    motionGapMs: [5 * 60 * 1000, 10 * 60 * 1000],
    idleBeforeActMs: 90 * 1000,
    // 节奏对比（2026-10-17）：均匀地每 5 分钟动一下像节拍器。真人是有簇的——
    // 安静很久 → 连着动两下 → 又安静。这里给"再追加一个"的概率与短间隔。
    burstChance: 0.34,
    burstGapMs: [18 * 1000, 42 * 1000],
    burstMax: 2,
    restyleMaxPerDay: 3,
    restyleMinGapMs: 90 * 60 * 1000,
    restyleIdleMs: 30 * 60 * 1000,
    showpieceMaxPerDay: 1,
    showpieceIdleMs: 30 * 60 * 1000
  },
  medium: {
    gazeMinGapMs: 4500,
    gazeHoldMs: [1400, 2600],
    gazeAvertMs: [3000, 7000],
    motionGapMs: [3 * 60 * 1000, 6 * 60 * 1000],
    idleBeforeActMs: 60 * 1000,
    burstChance: 0.42,
    burstGapMs: [14 * 1000, 34 * 1000],
    burstMax: 2,
    restyleMaxPerDay: 4,
    restyleMinGapMs: 60 * 60 * 1000,
    restyleIdleMs: 20 * 60 * 1000,
    showpieceMaxPerDay: 1,
    showpieceIdleMs: 20 * 60 * 1000
  },
  lively: {
    gazeMinGapMs: 3000,
    gazeHoldMs: [1200, 2200],
    gazeAvertMs: [2000, 5000],
    motionGapMs: [2 * 60 * 1000, 4 * 60 * 1000],
    idleBeforeActMs: 45 * 1000,
    burstChance: 0.52,
    burstGapMs: [12 * 1000, 28 * 1000],
    burstMax: 2,
    restyleMaxPerDay: 6,
    restyleMinGapMs: 40 * 60 * 1000,
    restyleIdleMs: 12 * 60 * 1000,
    showpieceMaxPerDay: 1,
    showpieceIdleMs: 12 * 60 * 1000
  }
}

export const DEFAULT_AMBIENT = AMBIENT_PRESETS.conservative

export function ambientFromSettings(cfg) {
  const base = AMBIENT_PRESETS[cfg?.level] || DEFAULT_AMBIENT
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    ...base,
    gazeMinGapMs: num(cfg?.gazeMinGapMs, base.gazeMinGapMs),
    motionGapMs: Array.isArray(cfg?.motionGapMs) && cfg.motionGapMs.length === 2 ? cfg.motionGapMs : base.motionGapMs,
    restyleMaxPerDay: num(cfg?.restyleMaxPerDay, base.restyleMaxPerDay),
    restyleMinGapMs: num(cfg?.restyleMinGapMs, base.restyleMinGapMs)
  }
}

const pick = (range, rng) => range[0] + rng() * (range[1] - range[0])

/* ------------------------------------------------------------------ *
 * ① 注视调度
 * ------------------------------------------------------------------ */

/**
 * 微注视调度器。
 * @param {object} [opts]
 * @param {number} [opts.minGapMs] 两次注视之间的最小间隔
 * @param {number[]} [opts.holdMs] 一次注视持续多久 [min,max]
 * @param {number[]} [opts.avertMs] 移开多久之后才可能再看 [min,max]
 * @param {() => number} [opts.rng] 随机源（单测注入）
 */
export function createGazeScheduler(opts = {}) {
  const minGapMs = opts.minGapMs ?? DEFAULT_AMBIENT.gazeMinGapMs
  const holdMs = opts.holdMs ?? DEFAULT_AMBIENT.gazeHoldMs
  const avertMs = opts.avertMs ?? DEFAULT_AMBIENT.gazeAvertMs
  const rng = opts.rng ?? Math.random

  let lastStart = -Infinity
  let mode = 'neutral' // 'neutral' | 'looking' | 'averted'
  let until = 0 // 当前阶段结束时刻
  let dir = { x: 0, y: 0 }

  function reset(now = 0) {
    lastStart = -Infinity
    mode = 'neutral'
    until = now
    dir = { x: 0, y: 0 }
  }

  /**
   * 收到一次"鼠标在动"的观测。是否真的看，取决于节制规则。
   * @param {{x:number,y:number}} d 相对她自己的方向（-1..1，已由主进程算好）
   * @param {number} now
   * @param {{busy?:boolean, silent?:boolean}} [ctx] busy=她在说话/演动作；silent=勿扰/夜间
   * @returns {boolean} 是否因此开始了一次注视
   */
  function onCursorMove(d, now, ctx = {}) {
    if (!d || (!d.x && !d.y)) return false
    if (ctx.busy || ctx.silent) return false
    if (mode === 'looking') return false // 正在看，不追着改目标（避免眼睛抖动）
    if (now - lastStart < minGapMs) return false
    if (now < until) return false // 还在移开期
    lastStart = now
    mode = 'looking'
    until = now + pick(holdMs, rng)
    dir = { x: clamp1(d.x), y: clamp1(d.y) }
    return true
  }

  /**
   * 每帧推进：到点就自动移开（不是"看到你不动为止"）。
   * @returns {{x:number,y:number,mode:string}} 当前应当注视的方向（0,0 = 中立）
   */
  function tick(now, ctx = {}) {
    if (ctx.silent && mode !== 'neutral') {
      mode = 'neutral'
      dir = { x: 0, y: 0 }
      until = now
      return { x: 0, y: 0, mode }
    }
    if (mode === 'looking' && now >= until) {
      mode = 'averted'
      until = now + pick(avertMs, rng)
      dir = { x: 0, y: 0 }
    } else if (mode === 'averted' && now >= until) {
      mode = 'neutral'
    }
    return { x: dir.x, y: dir.y, mode }
  }

  return {
    onCursorMove,
    tick,
    reset,
    snapshot: () => ({ mode, until, lastStart, dir: { ...dir } })
  }
}

function clamp1(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(-1, Math.min(1, n))
}

/* ------------------------------------------------------------------ *
 * ② / ③ 自主动作与自主换装
 * ------------------------------------------------------------------ */

/** 小动作的"由头"。渲染层按这个挑具体动作 */
export const ACT_REASON = {
  STRETCH: 'stretch', // 换个站姿（Idle 组）
  GREET: 'greet', // 打个招呼（Greet 组）
  REACT: 'react', // 对你在做的事有反应（视频/游戏）
  LOOK: 'look', // 左右看看
  GLANCE: 'glance', // 偷偷看你一眼
  // 2026-10-17 新增：闪一个瞬时微表情（星星眼/花花/吐舌…）。
  // 动作用的是模型的动作组（有限），表情资源却有一大堆——让它们也有一条出路。
  EXPR: 'expr'
}

/** 罕见专场：把模型里那套"完整演出"在合适的时刻放一次（一天最多一次） */
export const SHOWPIECE = {
  SCENE: 'Scene'
}

/** 换装的"由头"，写进日志让她以后能解释"为什么换了" */
export const RESTYLE_REASON = {
  RHYTHM: 'rhythm', // 时段到了（早上/白天/晚上）
  MOOD: 'mood', // 情绪到了
  IDLE: 'idle', // 待久了，整理一下
  MUSIC: 'music', // 在听歌，换身出门感
  USER: 'user' // 用户按的（不占自主配额）
}

/**
 * 自主行为配额器。保守档：小动作 5~10 分钟一次，换装一天最多 3 次、间隔 ≥90 分钟。
 * @param {object} config 见 AMBIENT_PRESETS
 * @param {{now?:()=>number, rng?:()=>number}} [deps]
 */
export function createAmbientPlan(config = DEFAULT_AMBIENT, deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const rng = deps.rng ?? Math.random

  let nextMotionAt = now() + pick(config.motionGapMs, rng)
  let burstLeft = 0 // 当前这一簇里还要再来几次
  let forceLongNext = false // 簇刚结束：下一次必须回到长安静
  let lastBurstAt = -Infinity
  let lastRestyleAt = -Infinity
  let restyleDay = ''
  let restyleCount = 0
  let lastReason = null

  const dayKey = (t) => new Date(t).toISOString().slice(0, 10)

  function rollDay(t) {
    const k = dayKey(t)
    if (k !== restyleDay) {
      restyleDay = k
      restyleCount = 0
    }
  }

  /**
   * 现在能不能自己动一下。
   * @param {{idleMs:number, busy?:boolean, silent?:boolean, tone?:string}} ctx
   */
  function shouldAct(ctx = {}) {
    const t = now()
    if (ctx.busy || ctx.silent) return null
    const idleMs = ctx.idleMs ?? 0
    if (idleMs < config.idleBeforeActMs) return null
    if (t < nextMotionAt) return null
    // 安静很久之后的**第一个**动作幅度大一点（"憋久了伸个懒腰"）；簇里的后续动作就不大了，
    // 否则会变成连续三下大动作，反而吵（这就是节奏对比：少而重 vs 密而轻）。
    const longQuiet = idleMs >= (config.longQuietMs ?? config.idleBeforeActMs * 4)
    return { reason: chooseActReason(ctx.tone, rng), big: burstLeft === 0 && longQuiet }
  }

  /**
   * 记一次动作已经做了（推下一次的时点）。
   * 这里决定"这一下之后是接着来、还是安静很久"——节奏对比就发生在这里。
   * @returns {{burst:boolean, left:number}} 供日志/验证看
   */
  function noteAct() {
    const t = now()
    if (burstLeft > 0) {
      burstLeft--
      // 这一下是簇尾：之后**一定**回到长安静，不能马上又开一个新簇
      // （否则 burstChance 高的时候会变成"一直每 20 秒动一下"，比匀速还糟）
      if (burstLeft === 0) forceLongNext = true
      nextMotionAt = t + pick(config.burstGapMs, rng)
      return { burst: true, left: burstLeft }
    }
    if (forceLongNext) {
      forceLongNext = false
      nextMotionAt = t + pick(config.motionGapMs, rng)
      return { burst: false, left: 0 }
    }
    if (rng() < (config.burstChance ?? 0)) {
      burstLeft = Math.max(0, (config.burstMax ?? 2) - 1)
      lastBurstAt = t
      // burstMax=1 等于"不开簇"，退回长间隔，别留下一个空簇
      if (burstLeft === 0) {
        nextMotionAt = t + pick(config.motionGapMs, rng)
        return { burst: false, left: 0 }
      }
      nextMotionAt = t + pick(config.burstGapMs, rng)
      return { burst: true, left: burstLeft }
    }
    burstLeft = 0
    nextMotionAt = t + pick(config.motionGapMs, rng)
    return { burst: false, left: 0 }
  }

  /**
   * 现在能不能自己换一下装束。
   * @param {{idleMs:number, busy?:boolean, silent?:boolean, rhythm?:string, mood?:string, musicPlaying?:boolean, restylingToday?:number}} ctx
   */
  function shouldRestyle(ctx = {}) {
    const t = now()
    if (ctx.busy || ctx.silent) return null
    rollDay(t)
    if (restyleCount >= config.restyleMaxPerDay) return null
    if (t - lastRestyleAt < config.restyleMinGapMs) return null

    // 契机：按"有多说得通"排序，取第一个成立的
    if (ctx.rhythm && RHYTHM_LOOK_HINTS[ctx.rhythm]) {
      return { reason: RESTYLE_REASON.RHYTHM, lookId: RHYTHM_LOOK_HINTS[ctx.rhythm] }
    }
    if (ctx.mood === 'joy') return { reason: RESTYLE_REASON.MOOD, lookId: null }
    if (ctx.musicPlaying) return { reason: RESTYLE_REASON.MUSIC, lookId: null }
    if ((ctx.idleMs ?? 0) >= config.restyleIdleMs) return { reason: RESTYLE_REASON.IDLE, lookId: null }
    return null
  }

  /** 记一次自主换装已经发生 */
  function noteRestyle(reason = null) {
    const t = now()
    rollDay(t)
    lastRestyleAt = t
    restyleCount++
    lastReason = reason
  }

  /* --- 罕见专场：一天最多演一次 ---------------
   * 模型里那套 28 参数的完整演出（Scene）在待机时永远不会被播到，
   * 但它是这个模型最"有戏"的一段资源。做成**稀有事件**：长空闲 + 心情好 +
   * 一天一次，这样既不打扰，看到了又是个惊喜。
   */
  let showpieceDay = ''
  let showpieceCount = 0
  let lastShowpieceAt = -Infinity

  function rollShowpiece(t) {
    const k = dayKey(t)
    if (k !== showpieceDay) {
      showpieceDay = k
      showpieceCount = 0
    }
  }

  /**
   * 现在能不能演一段专场。
   * @param {{idleMs:number, busy?:boolean, silent?:boolean, tone?:string, mood?:string}} ctx
   */
  function shouldShowpiece(ctx = {}) {
    const t = now()
    if (ctx.busy || ctx.silent) return null
    rollShowpiece(t)
    if (showpieceCount >= (config.showpieceMaxPerDay ?? 1)) return null
    if ((ctx.idleMs ?? 0) < (config.showpieceIdleMs ?? 30 * 60 * 1000)) return null
    // 只在"她本来就有点兴致"的时候演：心情好，或者正陪着你看东西
    const eager = ctx.mood === 'joy' || ctx.tone === TONE.ATTENTIVE || ctx.tone === TONE.NORMAL
    if (!eager) return null
    return {
      group: SHOWPIECE.SCENE,
      why: ctx.mood === 'joy' ? '心情不错，自己演了一段' : '闲着也是闲着，演一段给你看'
    }
  }

  function noteShowpiece() {
    const t = now()
    rollShowpiece(t)
    showpieceCount++
    lastShowpieceAt = t
  }

  return {
    shouldAct,
    noteAct,
    shouldRestyle,
    noteRestyle,
    shouldShowpiece,
    noteShowpiece,
    stats: () => ({
      nextMotionAt,
      burstLeft,
      lastBurstAt,
      lastRestyleAt,
      restyleCount,
      restyleDay,
      lastReason,
      restyleMaxPerDay: config.restyleMaxPerDay,
      showpieceCount,
      showpieceDay,
      lastShowpieceAt,
      showpieceMaxPerDay: config.showpieceMaxPerDay ?? 1
    })
  }
}

function chooseActReason(tone, rng) {
  const r = rng()
  // 大约 1/3 的自主动作改成"闪一个微表情"——比单纯换个站姿更像是"她对你有点反应"
  if (tone === TONE.ATTENTIVE) {
    if (r < 0.32) return ACT_REASON.REACT
    if (r < 0.62) return ACT_REASON.EXPR
    if (r < 0.84) return ACT_REASON.GLANCE
    return ACT_REASON.STRETCH
  }
  if (tone === TONE.QUIET) {
    if (r < 0.48) return ACT_REASON.STRETCH
    if (r < 0.78) return ACT_REASON.EXPR
    return ACT_REASON.LOOK
  }
  if (r < 0.28) return ACT_REASON.STRETCH
  if (r < 0.56) return ACT_REASON.EXPR
  if (r < 0.8) return ACT_REASON.GLANCE
  return ACT_REASON.GREET
}

/** 给日志/UI 的中文说法（她以后能解释自己为什么换了装束） */
export function describeRestyleReason(reason) {
  return (
    {
      [RESTYLE_REASON.RHYTHM]: '到了这个时段，换了身合适的',
      [RESTYLE_REASON.MOOD]: '心情不错，换了个样子',
      [RESTYLE_REASON.IDLE]: '待了挺久，自己整理了一下',
      [RESTYLE_REASON.MUSIC]: '你在听歌，跟着换了身',
      [RESTYLE_REASON.USER]: '你让她换的'
    }[reason] || '换了一身'
  )
}
