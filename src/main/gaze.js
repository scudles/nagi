// src/main/gaze.js
// 待机行为的感知输入：鼠标在动的时候，告诉她"往哪边看"。
//
// 隐私边界（重要）：
//   · **只广播方向**，不广播绝对坐标。这里算完 (x,y)∈[-1,1] 之后立刻丢掉光标坐标，
//     渲染层拿到的是一个方向而不是"你的鼠标在第几像素"，既够用也存不下敏感信息；
//   · 不落盘、不进记忆、不给模型看；
//   · 受 privacy 约束：勿扰 / 关掉活动监测时不采样；
//   · 鼠标不动就不发（渲染层的注视是事件驱动的，静默不该产生任何提示）。
//
// 频率：每 400ms 采一次，位移超过阈值才算"在动"，所以最长也是 2.5 条/秒。
import { screen } from 'electron'
import { EVT } from '../shared/protocol.js'
import { POLL_MS, moved, toGazeDir } from '../core/gaze.js'

let timer = null
let last = null

export { toGazeDir }

export function createGazeTracker({ getWindow, getPrivacy, getBounds, intervalMs = POLL_MS, onHint } = {}) {
  const stopped = () => {
    if (typeof getPrivacy === 'function') {
      const p = getPrivacy() || {}
      if (p.doNotDisturb) return true
      if (p.monitorEnabled === false) return true
    }
    const win = typeof getWindow === 'function' ? getWindow() : null
    if (!win || win.isDestroyed?.() || !win.isVisible?.()) return true
    return false
  }

  function poll() {
    if (stopped()) {
      last = null
      return
    }
    let point
    try {
      point = screen.getCursorScreenPoint()
    } catch {
      return
    }
    if (!point) return
    // 没动 → 不发提示（渲染层的注视是事件驱动的，静默不该产生任何注视）
    if (!moved(last, point)) return
    last = { x: point.x, y: point.y }

    let bounds = null
    try {
      bounds = typeof getBounds === 'function' ? getBounds() : null
    } catch {
      bounds = null
    }
    const center = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : { x: (screen.getPrimaryDisplay()?.workAreaSize?.width || 1920) / 2, y: (screen.getPrimaryDisplay()?.workAreaSize?.height || 1080) / 2 }
    const view = screen.getPrimaryDisplay()?.workAreaSize || { width: 1920, height: 1080 }
    const dir = toGazeDir(point, center, view)
    try {
      onHint?.({ ...dir, at: Date.now() })
    } catch{ /* B8:degrade — 广播失败不影响轮询 */ }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(poll, intervalMs)
      // 别让这个定时器把 Electron 事件循环钉住（退出时要能走）
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      last = null
    },
    isRunning: () => !!timer
  }
}

let tracker = null

/** 主进程启动时挂上；broadcast 由调用方注入，便于测试与复用 */
export function startGaze(opts) {
  if (tracker) return tracker
  tracker = createGazeTracker(opts)
  tracker.start()
  return tracker
}

export function stopGaze() {
  tracker?.stop()
  tracker = null
}

export const GAZE_EVENT = EVT.GAZE
