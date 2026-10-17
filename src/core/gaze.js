// src/core/gaze.js
// 注视方向的纯计算（放在 core 里是为了可单测：main/gaze.js 要 import electron，测不了）。
//
// 隐私设计：这里**只把屏幕坐标化成方向**（-1..1），调用方拿到方向后立刻丢掉坐标。
// 方向本身泄露不了"鼠标在第几像素"，而渲染层只需要方向就够用了。

/** 位移小于这个像素数算"没动"（手抖、光标漂移不该触发注视） */
export const MOVE_PX = 6

/** 采样间隔：最长 2.5 条提示/秒，渲染层那边还有 6 秒的最小注视间隔兜底 */
export const POLL_MS = 400

/**
 * 把屏幕坐标化成"相对她自己的方向"。
 * 分母用屏幕半宽/半高：鼠标在屏幕最左边 → x=-1（她往自己左边看），最右边 → x=1。
 * @param {{x:number,y:number}} point 光标屏幕坐标
 * @param {{x:number,y:number}} center 她的窗口中心（屏幕坐标）
 * @param {{width:number,height:number}} view 屏幕工作区尺寸
 * @returns {{x:number,y:number}} 两个分量都在 [-1,1]
 */
export function toGazeDir(point, center, view) {
  const halfW = Math.max(1, (view?.width || 1920) / 2)
  const halfH = Math.max(1, (view?.height || 1080) / 2)
  const clamp = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    return Math.max(-1, Math.min(1, n))
  }
  const px = Number(point?.x)
  const py = Number(point?.y)
  const cx = Number(center?.x)
  const cy = Number(center?.y)
  if (![px, py, cx, cy].every(Number.isFinite)) return { x: 0, y: 0 }
  return { x: clamp((px - cx) / halfW), y: clamp((py - cy) / halfH) }
}

/** 这次采样算不算"在动"（不动的采样不该产生任何提示） */
export function moved(prev, next, threshold = MOVE_PX) {
  if (!prev || !next) return true // 第一帧：当作开始观测
  const dx = Math.abs(Number(next.x) - Number(prev.x))
  const dy = Math.abs(Number(next.y) - Number(prev.y))
  return dx + dy >= threshold
}
