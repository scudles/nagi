// src/renderer/js/ambient.js
// 待机行为的渲染层接线：把 core/ambient.js 的决定落到模型上，并遵守隐私与静默边界。
//
// 分工（和 presence.js 一样，"不得产生权威状态"）：
//   · 该不该看、该不该动、能不能换装 → 全部由 core/ambient.js 决定（纯逻辑、可单测）；
//   · 本文件只做三件事：订阅主进程的注视提示、按节拍推进、把决定交给 live2d。
//   · 本文件不写设置、不改时钟、不猜事实；换装结果通过回调交回 main.js 落盘。
//
// 静默边界（这里必须硬守）：
//   · privacy.doNotDisturb 或 ambient.enabled=false → 全部停止，注视强制归中；
//   · 她在说话 / 生成回复 / 夜间抑制 → 不注视、不主动动作；
//   · 一切都要"你不动她也不动"：没有鼠标移动事件就不会有注视。
import { EVT } from '../../shared/protocol.js'
import {
  ACT_REASON,
  DEFAULT_AMBIENT,
  ambientFromSettings,
  createAmbientPlan,
  createGazeScheduler,
  describeRestyleReason,
  RESTYLE_REASON,
  toneForCategory
} from '../../core/ambient.js'
import { pickMicroExpr } from '../../core/microexpr.js'
import * as l2d from './live2d.js'
import * as presence from './presence.js'

const TICK_MS = 500

let cfg = DEFAULT_AMBIENT
let enabled = true
let gazeOn = true
let autoOn = true
let privacy = {}
let getConfig = () => ({})

const gaze = createGazeScheduler()
let plan = createAmbientPlan(cfg)
let lastActivityAt = Date.now()
let tone = 'normal'
let tickTimer = null
let offEvent = null
let appliedGaze = { x: 0, y: 0 }
let lastRestyle = null
let autoActSuppressed = false // 临时禁止"自己动/自己换装"（验证与"别吵"场景用）
let lastMicro = null // 最近一次闪过的微表情
let lastMicroId = null
let lastShowpiece = null // 最近一次"专场演出"
let onRestyleCb = null

const now = () => Date.now()

/** 重新按配置造调度器与配额器（设置变更后即时生效，不必重启） */
function rebuild() {
  cfg = ambientFromSettings(getConfig())
  plan = createAmbientPlan(cfg)
  gaze.reset(0)
  appliedGaze = { x: 0, y: 0 }
}

/** 现在是否处于"完全静默"（勿扰 / 关了待机行为 / 夜间抑制） */
function isSilent() {
  if (!enabled) return true
  if (privacy.doNotDisturb) return true
  try {
    if (presence.randomMotionSuppressed()) return true
  } catch {
    /* presence 没起来时不算静默 */
  }
  return false
}

/** 她此刻是不是"忙着"（说话中/正在生成回复） → 不注视、不主动动作 */
function isBusy() {
  try {
    if (l2d.isTalking()) return true
  } catch {
    /* ignore */
  }
  try {
    const pose = l2d.getPose?.()
    if (pose === 'thinking') return true
  } catch {
    /* ignore */
  }
  return false
}

/** 每隔一拍推进一次：先管目光，再看要不要自己动/自己换装 */
function tick() {
  if (!l2d.isReady()) return
  const t = now()
  const silent = isSilent()
  const busy = isBusy()

  // ① 目光
  if (!gazeOn || !enabled) {
    if (appliedGaze.x || appliedGaze.y) {
      appliedGaze = { x: 0, y: 0 }
      l2d.setGaze(0, 0)
    }
  } else {
    const g = gaze.tick(t, { silent })
    if (g.x !== appliedGaze.x || g.y !== appliedGaze.y) {
      appliedGaze = { x: g.x, y: g.y }
      l2d.setGaze(g.x, g.y)
    }
  }

  if (!autoOn || silent || autoActSuppressed) return

  const idleMs = t - lastActivityAt
  const ctx = { idleMs, busy, silent, tone }
  const mood = moodName()

  // ①.5 罕见专场（一天最多一次）：长空闲 + 心情好时，把模型那套完整演出放一遍
  const show = plan.shouldShowpiece({ ...ctx, mood })
  if (show) {
    try {
      l2d.playMotion(show.group)
      plan.noteShowpiece()
      lastShowpiece = { at: t, group: show.group, why: show.why }
      return // 专场期间不做别的
    } catch {
      /* 模型没有这个动作组就算了，继续往下走普通行为 */
    }
  }

  // ② 自己动一下
  const act = plan.shouldAct(ctx)
  if (act) {
    // noteAct 会决定"这一下之后是接着再来、还是安静很久"（节奏对比就发生在这一步）
    const burst = plan.noteAct()
    doAct(act.reason, { big: !!act.big, burst })
    return // 一次只做一件事，别在同一拍里又动又换
  }

  // ③ 自己换一下装束
  const restyle = plan.shouldRestyle({ ...ctx, rhythm: presence.getRhythm()?.name, mood: moodName() })
  if (restyle) {
    const shifted = restyle.lookId ? l2d.setOutfitLook(restyle.lookId, {}) : l2d.shiftOutfitSlot({})
    if (shifted) {
      plan.noteRestyle(restyle.reason)
      lastRestyle = { at: t, reason: restyle.reason, text: describeRestyleReason(restyle.reason) }
      try {
        onRestyleCb?.(lastRestyle)
      } catch {
        /* 记账失败不影响表现 */
      }
    }
  }
}

function moodName() {
  try {
    return window.__nagiMood?.()?.mood || ''
  } catch {
    return ''
  }
}

/** 把"由头"落成具体表现：模型没有那个组就退到 Idle，绝不凭空造动作 */
function doAct(reason, opts = {}) {
  // 微表情：从模型目录的池子里按当前基调挑一个（星星眼/花花/吐舌/炸毛…）
  if (reason === ACT_REASON.EXPR) {
    const hit = pickMicroExpr(l2d.microExprConfig?.(), { tone, avoid: lastMicroId })
    if (hit && l2d.playMicroExpr(hit.params, hit.holdMs)) {
      lastMicroId = hit.id
      lastMicro = { at: now(), name: hit.name, why: hit.why }
      // 高兴类的微表情顺带抖一下耳朵（只有 star/heart/flower 这种"兴奋"的才抖）
      if (['star', 'heart', 'flower'].includes(hit.id) && Math.random() < 0.55) l2d.wiggleEars?.(0.9, 560)
      return
    }
    // 没池子/没受理：退回换个站姿，别让这一拍白过
  }
  const groups = l2d.motionCatalog?.() || {}
  const has = (g) => Object.prototype.hasOwnProperty.call(groups, g)
  const pick = () => {
    // 安静很久之后的第一个动作要"明显"——挥手/欢呼，而不是换个站姿。
    // 这就是节奏对比里那个"突然一个明显动作"。
    if (opts.big && has('Greet')) return Math.random() < 0.6 ? 'Greet' : has('Happy') ? 'Happy' : 'Greet'
    if (opts.big && has('Happy')) return 'Happy'
    if (reason === ACT_REASON.GREET && has('Greet')) return 'Greet'
    if (reason === ACT_REASON.REACT && has('Happy')) return 'Happy'
    // 待机时也让她把那几个小动作演一遍（以前只有你戳她才会播）
    if ((reason === ACT_REASON.STRETCH || reason === ACT_REASON.LOOK) && has('TapBody') && Math.random() < 0.25) {
      return 'TapBody'
    }
    if (has('Idle')) return 'Idle'
    return Object.keys(groups)[0] || null
  }
  const g = pick()
  if (!g) return
  const r = l2d.playMotion(g)
  // 只在工作台/日志里留一行，便于看清节奏（用户看不到也不影响）
  try {
    const b = opts.burst || {}
    console.log(`[ambient] act ${g}${opts.big ? '（安静很久，幅度加大）' : ''}${b.burst ? '（簇发，下一个 ' + Math.round((b.left + 1) * 1) + ' 拍后）' : ''}`)
  } catch {
    /* 日志失败不影响表现 */
  }
  return r
}

/** 用户/她自己在动 → 刷新"最近有互动"的时刻（自主行为据此判断闲不闲） */
export function noteActivity() {
  lastActivityAt = now()
}

/** 活动分类变化（工作/视频/游戏…）→ 改变待机基调 */
export function setCategory(category) {
  tone = toneForCategory(category)
}

/**
 * 订阅与启动。
 * @param {object} opts
 * @param {() => object} [opts.getConfig] 取 settings.ambient / privacy（设置变更后即时生效）
 * @param {(e:{at:number,reason:string,text:string}) => void} [opts.onRestyle] 自主换装回调（落盘/日志）
 */
export function initAmbient(opts = {}) {
  getConfig = opts.getConfig || getConfig
  onRestyleCb = opts.onRestyle || null
  privacy = opts.getPrivacy?.() || {}

  const g = getConfig() || {}
  enabled = g.enabled !== false
  gazeOn = g.gaze !== false
  autoOn = g.autonomous !== false
  rebuild()

  offEvent = window.nagi.on(EVT.GAZE, (hint) => {
    if (!enabled || !gazeOn || !hint) return
    const silent = isSilent()
    const started = gaze.onCursorMove(hint, now(), { busy: isBusy(), silent })
    if (started && l2d.isReady()) {
      l2d.setGaze(hint.x, hint.y)
      appliedGaze = { x: hint.x, y: hint.y }
    }
  })

  if (!tickTimer) {
    tickTimer = setInterval(tick, TICK_MS)
    tickTimer.unref?.()
  }
  return () => stopAmbient()
}

export function stopAmbient() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  offEvent?.()
  offEvent = null
  onRestyleCb = null
}

let lastConfigKey = ''

/**
 * 设置变更后调用：开关与档位即时生效。
 * 只有配置**真的变了**才重建配额器——否则每保存一次设置都会把
 * "下一次动作时间"重置，等于不断把她的自主动作往后推。
 */
export function refreshAmbient({ config, privacy: p } = {}) {
  if (config) {
    enabled = config.enabled !== false
    gazeOn = config.gaze !== false
    autoOn = config.autonomous !== false
    const key = JSON.stringify(config)
    if (key !== lastConfigKey) {
      lastConfigKey = key
      rebuild()
    }
  }
  if (p) privacy = p
  if ((!enabled || !gazeOn) && l2d.isReady()) {
    appliedGaze = { x: 0, y: 0 }
    l2d.setGaze(0, 0)
  }
}

/**
 * 临时禁止"自己动一下/自己换装"（注视不受影响）。
 * 用途：① 验证脚本要在不受打扰的状态下抓帧；② 以后可以接到"开会/专注模式"。
 */
export function suppressAutoAct(on) {
  autoActSuppressed = !!on
  return autoActSuppressed
}

/**
 * 手动闪一个微表情（托盘/热键/设置页都能用）。
 * @param {string} [preferredId] 指定池里的 id；不指定就按当前基调挑一个
 */
export function flashMicroExpr(preferredId = null) {
  const cfg = l2d.microExprConfig?.()
  const pool = cfg?.pool || []
  const hit = preferredId
    ? pool.find((e) => e.id === preferredId) || null
    : pickMicroExpr(cfg, { tone, avoid: lastMicroId })
  if (!hit) return null
  if (!l2d.playMicroExpr(hit.params, hit.holdMs || cfg.holdMs?.[0] || 1600)) return null
  lastMicroId = hit.id
  lastMicro = { at: now(), name: hit.name, why: hit.why }
  return hit
}

/** 当前注视方向（-1..1）。转向层要"朝你转"时用它当方向来源。 */
export function gazeNow() {
  return { ...appliedGaze }
}

/** 调试/验证用 */
export function ambientState() {
  return {
    enabled,
    gaze: gazeOn,
    autonomous: autoOn,
    autoActSuppressed,
    tone,
    idleMs: now() - lastActivityAt,
    appliedGaze: { ...appliedGaze },
    gazeState: gaze.snapshot(),
    plan: plan.stats(),
    lastRestyle,
    lastMicro,
    lastMicroLive: l2d.microExprState?.() || null,
    lastShowpiece,
    microPool: (l2d.microExprConfig?.()?.pool || []).map((e) => e.id)
  }
}
