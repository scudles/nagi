// src/core/face/turn.js
// 「转头 / 转身」：事件驱动的朝向控制（2026-10-17）。
//
// 为什么单独一层：原来的朝向只有"注视"一条路（鼠标在动就朝那边看），
// 而且**待机时头部是 0**——那 ±30° 的空间一直空着。这一层负责"因为发生了什么，
// 她朝你转过来 / 转开"这种有由头的朝向变化。
//
// 物理边界（实测，代码改不了）：
//   ParamAngleX/Y/Z   ∈ [-30, 30]   头部
//   ParamBodyAngleX/Y/Z ∈ [-10, 10] 身体（只有头部的 1/3）
// 所以这里的 x/y/body 都是 -1..1 的"归一化意图"，渲染层再映射到各自的值域。
//
// 与注视的关系：**同一时间只有一个东西在控制朝向**。
// turn 激活期间渲染层会接管角度（覆盖 focus 的贡献），结束再交还给注视，
// 否则两边都 add 会顶到上限被裁（看起来就是"转不过去"）。

/** 由头（决定幅度、方向与持续时间） */
export const TURN_KIND = {
  POKE: 'poke', // 你戳她
  APPROACH: 'approach', // 鼠标靠近她的窗口
  SCENE: 'scene', // 你换了在做的事
  RETURN: 'return', // 你离开一会儿又回来
  TYPING: 'typing', // 你在打字，她低头看
  AWAY: 'away' // 闹别扭：故意别过头
}

/**
 * 每个由头的幅度与节奏（归一化，-1..1）。
 * inMs/outMs 是"转过去"和"转回来"的时间 —— 一定要有 outMs，
 * 而且是慢慢转回来，否则像机器人。
 */
export const TURN_PRESETS = {
  // 被戳：最短的延迟、最明确的朝向（她得让你知道你戳到了）
  poke: { x: 0.92, y: 0.26, body: 0.9, inMs: 360, holdMs: 2000, outMs: 1100 },
  // 鼠标靠近：抬头看，身体几乎不动（只是注意到）
  approach: { x: 0.55, y: 0.38, body: 0.3, inMs: 300, holdMs: 1300, outMs: 900 },
  // 你换了在做的事：朝屏幕方向转一下上半身
  scene: { x: 0.72, y: 0.12, body: 0.8, inMs: 450, holdMs: 1500, outMs: 1000 },
  // 你回来了：转身迎接，幅度最大、持续最久
  return: { x: 0.86, y: 0.22, body: 1, inMs: 520, holdMs: 2300, outMs: 1200 },
  // 你在打字：她低头看"你在敲什么"
  typing: { x: 0.28, y: -0.58, body: 0.26, inMs: 420, holdMs: 1900, outMs: 900 },
  // 闹别扭：别过头去（反方向），两三秒后自己转回来
  away: { x: -0.88, y: 0.08, body: -0.85, inMs: 520, holdMs: 2400, outMs: 1300 }
}

/** 同一个由头的最小间隔（poke 不限：你戳几下她就该反应几下） */
const SAME_KIND_GAP_MS = {
  [TURN_KIND.POKE]: 0,
  [TURN_KIND.APPROACH]: 25 * 1000,
  [TURN_KIND.SCENE]: 60 * 1000,
  [TURN_KIND.RETURN]: 5 * 60 * 1000,
  [TURN_KIND.TYPING]: 90 * 1000,
  [TURN_KIND.AWAY]: 3 * 60 * 1000
}

/** 两次转向之间的最小间隔（避免一直转） */
const MIN_GAP_MS = 1200

const easeOut = (k) => 1 - (1 - k) * (1 - k)
const easeIn = (k) => k * k

/**
 * 转向控制器。
 * @param {{now?:()=>number, rng?:()=>number}} [deps]
 */
export function createTurnController(deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const rng = deps.rng ?? Math.random

  let active = null // { kind, preset, startedAt, x, y, body }
  let lastAt = 0
  let lastByKind = {}
  let history = [] // 最近几次（调试/验证用）

  /**
   * 发起一次转向。
   * @param {string} kind TURN_KIND 之一
   * @param {{x?:number, y?:number, body?:number, holdMs?:number, force?:boolean}} [opts]
   *        可以覆盖方向（比如朝鼠标实际方向）
   * @returns {{ok:boolean, reason?:string}}
   */
  function turn(kind, opts = {}) {
    const t = now()
    const preset = TURN_PRESETS[kind]
    if (!preset) return { ok: false, reason: 'unknown-kind' }
    if (!opts.force) {
      const gap = SAME_KIND_GAP_MS[kind] ?? 0
      if (gap && t - (lastByKind[kind] || -Infinity) < gap) return { ok: false, reason: 'kind-gap' }
      if (active && t - active.startedAt < MIN_GAP_MS) return { ok: false, reason: 'busy' }
      if (!active && t - lastAt < MIN_GAP_MS) return { ok: false, reason: 'gap' }
    }
    const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(-1, Math.min(1, Number(v))) : d)
    active = {
      kind,
      preset,
      startedAt: t,
      x: num(opts.x, preset.x),
      y: num(opts.y, preset.y),
      body: num(opts.body, preset.body),
      holdMs: Number.isFinite(Number(opts.holdMs)) ? Math.max(200, Number(opts.holdMs)) : preset.holdMs
    }
    lastAt = t
    lastByKind[kind] = t
    history.push({ at: t, kind, x: active.x, y: active.y, body: active.body })
    if (history.length > 20) history.shift()
    return { ok: true }
  }

  /**
   * 每帧取当前的转向量。
   * @returns {{kind:string, x:number, y:number, body:number, weight:number}|null}
   *          weight 是包络（0..1），已经乘进 x/y/body
   */
  function tick(t = now()) {
    if (!active) return null
    const el = t - active.startedAt
    const { inMs, outMs } = active.preset
    const total = inMs + active.holdMs + outMs
    if (el >= total) {
      active = null
      return null
    }
    let w
    if (el < inMs) w = easeOut(el / Math.max(1, inMs))
    else if (el < inMs + active.holdMs) w = 1
    else w = 1 - easeIn((el - inMs - active.holdMs) / Math.max(1, outMs))
    return {
      kind: active.kind,
      x: active.x * w,
      y: active.y * w,
      body: active.body * w,
      weight: w,
      // 头部转到接近极限时，头上再带一点侧倾会更像"真的在转"
      tilt: active.x * w * 0.28
    }
  }

  const isActive = () => !!active

  function stats() {
    return { active: active ? { kind: active.kind, startedAt: active.startedAt, x: active.x, y: active.y } : null, history, lastAt }
  }

  function reset() {
    active = null
    lastAt = 0
    lastByKind = {}
    history = []
  }

  return { turn, tick, isActive, stats, reset }
}

/**
 * 从鼠标方向（-1..1）推一个"朝你"的方向。
 * 鼠标离得远就用它的方向；离得很近（或没有数据）就给一个默认的"略偏上"。
 */
export function directionFrom(gaze, fallback = { x: 0.9, y: 0.2 }) {
  if (!gaze) return { ...fallback }
  const x = Number(gaze.x)
  const y = Number(gaze.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ...fallback }
  const len = Math.hypot(x, y)
  if (len < 0.15) return { ...fallback }
  return { x: x / len, y: y / len }
}

/** 给日志/调试用的中文说法 */
export function describeTurn(kind) {
  return (
    {
      [TURN_KIND.POKE]: '被你戳了，转头看你',
      [TURN_KIND.APPROACH]: '注意到你靠近了，抬头',
      [TURN_KIND.SCENE]: '你换了在做的事，朝那边转',
      [TURN_KIND.RETURN]: '你回来了，转身',
      [TURN_KIND.TYPING]: '你在打字，低头看',
      [TURN_KIND.AWAY]: '闹别扭，别过头去'
    }[kind] || kind
  )
}
