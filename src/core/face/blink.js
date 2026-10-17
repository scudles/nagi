/**
 * 自动眨眼（2026-10-17）
 *
 * 为什么自己实现：框架（pixi-live2d-display 的 Cubism4InternalModel.update）里
 * 眨眼是这样的——
 *
 *     const motionUpdated = this.motionManager.update(...)
 *     ...
 *     if (!motionUpdated) { this.eyeBlink?.updateParameters(model, dt) }
 *
 * 也就是**动作正在播的时候完全跳过眨眼**。而她的 Idle 动作是常驻循环的
 * （nagi_idle，9 秒一轮，loop 默认 true），于是 motionUpdated 永远是 true，
 * 她**一次都不会眨眼**。这在真机上非常明显（用户 2026-10-17 直接指出"没看到眨眼"）。
 *
 * 所以这里自己排眨眼：不依赖动作是否在播，并且能做得比默认更像人——
 * 间隔随机、闭得快开得慢、偶尔连眨两下（真人约 10~15% 的眨眼是双眨）。
 *
 * 纯逻辑，时间由外部传入，方便单测。
 */

export const DEFAULT_BLINK = {
  minGapMs: 2200, // 两次眨眼的最小间隔
  maxGapMs: 5600, // 最大间隔（平均约 4 秒，接近真人的 3~5 秒）
  closeMs: 85, // 闭合（比睁开快，真实眼睑就是这么动的）
  holdMs: 35, // 完全闭住的停顿（很短，太长会像卡住）
  openMs: 155, // 睁开
  doubleChance: 0.12, // 双眨概率
  doubleGapMs: [170, 320], // 双眨里两次之间的间隔
  // 闭到底时留的那条缝。**别想当然地认为"必须 > 0"**：这里曾写着
  // "全 0 会让眼线消失，看着像坏了"，2026-10-17 拿缅因实测截图证伪——
  // ParamEyeLOpen=0 时睫毛线照旧在（与 0.02 视觉几乎无差）。
  // 仍然保留 0.02 作代码默认，是因为换模型（尤其描线淡的）可能真的不剩线；
  // 想闭到底的模型在自己的配置里显式写 0（nagi-face.json 的 blink.minClose）。
  minClose: 0.02
}

const easeInOut = (p) => {
  const x = Math.max(0, Math.min(1, p))
  return x * x * (3 - 2 * x)
}

/**
 * @param {object} [cfg] 覆盖 DEFAULT_BLINK 的字段
 * @param {{now?:()=>number, rng?:()=>number}} [deps]
 */
export function createBlinkScheduler(cfg = {}, deps = {}) {
  const c = { ...DEFAULT_BLINK, ...(cfg || {}) }
  const now = deps.now ?? (() => Date.now())
  const rng = deps.rng ?? Math.random

  const gap = () => c.minGapMs + rng() * Math.max(0, c.maxGapMs - c.minGapMs)

  let phase = 'open' // open | closing | closed | opening
  let phaseAt = now()
  let nextAt = phaseAt + gap()
  let count = 0
  let lastBlinkAt = -Infinity
  // 见过的最小眼开系数（reset 归零）。验收「真的闭到底了吗」不能靠采样碰运气：
  // 闭合段只有 closeMs(85)+holdMs(35)=120ms，100ms 一轮的采样很可能整段错过，
  // 于是"闭到 0.17"和"闭到 0"读起来一样。让调度器自己记住最小值。
  let minF = 1

  const enter = (p, t) => {
    phase = p
    phaseAt = t
  }

  /**
   * 推进到 t，返回当前"眼开系数"：1 = 完全睁开，接近 0 = 闭住。
   * 调用方应当拿它去乘当前的眼开参数（乘性叠加，能保留表情造成的半闭）。
   * @param {number} [t]
   */
  function tick(t = now()) {
    // 到点就该闭了
    if (phase === 'open' && t >= nextAt) {
      enter('closing', t)
      lastBlinkAt = t
    }
    if (phase === 'closing' && t - phaseAt >= c.closeMs) enter('closed', phaseAt + c.closeMs)
    if (phase === 'closed' && t - phaseAt >= c.holdMs) enter('opening', phaseAt + c.holdMs)
    if (phase === 'opening' && t - phaseAt >= c.openMs) {
      enter('open', phaseAt + c.openMs)
      count++
      // 双眨：睁眼后隔很短再来一次；否则按概率排一次
      nextAt = t + (rng() < c.doubleChance ? c.doubleGapMs[0] + rng() * (c.doubleGapMs[1] - c.doubleGapMs[0]) : gap())
      minF = Math.min(minF, 1)
      return 1
    }

    if (phase === 'closing') {
      const f = 1 - (1 - c.minClose) * easeInOut((t - phaseAt) / Math.max(1, c.closeMs))
      minF = Math.min(minF, f)
      return f
    }
    if (phase === 'closed') {
      minF = Math.min(minF, c.minClose)
      return c.minClose
    }
    if (phase === 'opening') {
      const f = c.minClose + (1 - c.minClose) * easeInOut((t - phaseAt) / Math.max(1, c.openMs))
      minF = Math.min(minF, f)
      return f
    }
    return 1
  }

  function stats() {
    return { phase, count, lastBlinkAt, nextAt, config: c, minF }
  }

  function reset(t = now()) {
    enter('open', t)
    nextAt = t + gap()
    count = 0
    lastBlinkAt = -Infinity
    minF = 1
  }

  return { tick, stats, reset }
}
