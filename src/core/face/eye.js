/**
 * 眼球自主游走（2026-10-17）
 *
 * 用户反馈："她的视线完全由头部方向决定，眼球好像不会动。"
 * 这是因为之前眼球只有三个来源，全都在"跟着别的东西走"：
 *   ① 框架的 focus（鼠标动就朝那边看）；
 *   ② 转向层（头转多少，眼珠按 0.45 跟过去）；
 *   ③ 待机头部摆动（眼珠按 0.35 跟着摆）。
 * 再加上微扫视只有 ±0.045，等于**眼球从来没有自己的意志**。
 *
 * 真人不是这样：头基本不动的时候，眼球一直在小范围地换注视点
 * （看屏幕左边、回来、瞟一眼键盘、看远处…），这叫 saccade（扫视），
 * 每次移动只要 70~140ms，然后**完全静止**地停一会儿。
 *
 * 这一层就是那个"自己的意志"。它是**让位型**的：
 *   · 转向激活时不写（那边在管朝向）；
 *   · 鼠标刚动过（focus 活跃）时不写（她在看你）。
 * 只有在"没人管她"的时候，眼珠才自己游走。
 */

export const DEFAULT_EYE_WANDER = {
  amp: 0.62, // 最大偏移（值域 ±1 ≈ ±30°）
  glideMs: [70, 140], // 单次扫视用时：真人眼球转得很快
  holdMs: [480, 1500], // 到达后完全静止的停留
  smallChance: 0.55, // 小幅度（±0.42×amp）—— 看屏幕上的字
  midChance: 0.3, // 中幅度（±0.78×amp）
  centerChance: 0.45, // 这么多次里有一次是"回到中间"
  verticalScale: 0.55 // 眼球上下动的范围比左右小
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const easeOutCubic = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3)

/**
 * @param {object} [cfg]
 * @param {{now?:()=>number, rng?:()=>number}} [deps]
 */
export function createEyeWander(cfg = {}, deps = {}) {
  const c = { ...DEFAULT_EYE_WANDER, ...(cfg || {}) }
  const now = deps.now ?? (() => Date.now())
  const rng = deps.rng ?? Math.random

  let cur = { x: 0, y: 0 }
  let from = { x: 0, y: 0 }
  let to = { x: 0, y: 0 }
  let startAt = now()
  let glideMs = c.glideMs[0]
  let arriveAt = startAt + glideMs
  let nextAt = arriveAt + c.holdMs[0]
  let moves = 0

  function pickTarget() {
    const r = rng()
    const scale = r < c.smallChance ? 0.42 : r < c.smallChance + c.midChance ? 0.78 : 1
    const amp = c.amp * scale
    // 有一定概率回中间：真人也常常"看着屏幕正中"
    const k = rng() < c.centerChance ? 0.25 : 1
    return {
      x: (rng() * 2 - 1) * amp * k,
      y: (rng() * 2 - 1) * amp * k * c.verticalScale
    }
  }

  /** 推进到 t，返回当前眼球位置（-1..1） */
  function tick(t = now()) {
    if (t >= nextAt) {
      from = { ...cur }
      to = pickTarget()
      startAt = t
      glideMs = c.glideMs[0] + rng() * Math.max(0, c.glideMs[1] - c.glideMs[0])
      arriveAt = t + glideMs
      nextAt = arriveAt + c.holdMs[0] + rng() * Math.max(0, c.holdMs[1] - c.holdMs[0])
      moves++
    }
    if (t < arriveAt) {
      const e = easeOutCubic((t - startAt) / Math.max(1, glideMs))
      cur = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }
    } else {
      cur = { ...to }
    }
    return cur
  }

  function stats() {
    return { x: cur.x, y: cur.y, targetX: to.x, targetY: to.y, moves, nextAt, config: c }
  }

  function reset(t = now()) {
    cur = { x: 0, y: 0 }
    from = { ...cur }
    to = { ...cur }
    startAt = t
    arriveAt = t + c.glideMs[0]
    nextAt = arriveAt + c.holdMs[0]
    moves = 0
  }

  return { tick, stats, reset }
}
