// src/core/frame.js
// 取景（framing）：决定"模型哪一段、以多大比例、落在画布的什么位置"。
//
// 产品的既定规则（2026-10-15 用户拍板）：**只显示胸像（上半身），不再显示全身**。
// 于是取景不再等于"把整张画布塞进窗口"，而是：
//   1) 先在模型上框出一个"取景带"（band）——横向取中间一段、纵向取顶部一段；
//   2) 再把这个带**完整装进**画布（contain，绝不越界），底部对齐、水平居中；
//   3) 留出安全边距，避免贴边、也避免压到画布内的 UI（如桌宠右侧工具条、底部状态行）。
//
// 这里的计算全是纯函数，方便单测把"不越界"这条硬约束钉死。

/**
 * 取景模式：值都是「声明 moc 画布」的归一化坐标（0~1，左上角为原点）。
 *
 * ⚠ 为什么横向要取到 0.11~0.95（而不是"角色核心"的 0.15~0.85）：
 * 该模型的美术**画到了角色核心之外**，而且随待机动作摆动。实测（scripts/probe-art.mjs +
 * verify:frame 的像素统计）：
 *   · 静止姿态：整体范围 fx ∈ [0.131, 0.925]、fy ∈ [0.053, 0.963]；
 *   · 抬手/甩手的动作会把右缘推到 0.977 —— 差不多就是整张画布宽。
 * 也就是说"把每一次动作的手臂都框进来"要靠无限缩小人物才能做到，代价太大；
 * 取景带因此按**静止姿态**留量，保证"看起来她是完整地站在框里的"：
 *   · 左 0.11（比美术左缘 0.131 余 0.021）
 *   · 右 0.95（比静止右缘 0.925 余 0.025）
 *   · 顶 -0.02（头顶在 0.053，往画布上方再留一段）
 *   · 底 0.46（裁到腰，这就是"胸像"）
 * 大幅动作时手臂会短暂伸到画布边缘之外（被画布裁掉）——这是 Live2D 桌宠的常态，
 * 而且**永远不会盖住 UI**：UI 是画在画布之上的 HTML，且画布本身被容器裁切。
 * 左右不对称是故意的 —— 美术本身偏右，取景带跟着偏，形象才会落在画面正中
 * （fitBand 会用 centerOffset 把它摆正）。
 */
export const FRAME_PRESETS = {
  bust: { left: 0.11, right: 0.95, top: -0.02, bottom: 0.46 },
  // 全身（保留能力：个别模型若原本就是半身稿，可用 full 原样显示）
  full: { left: 0, right: 1, top: 0, bottom: 1 }
}

export const DEFAULT_FRAME = 'bust'

/** 取某个取景模式的比例表；未知模式回落到默认 */
export function framePreset(frame) {
  return FRAME_PRESETS[frame] || FRAME_PRESETS[DEFAULT_FRAME]
}

export function isBustFrame(frame) {
  return (frame || DEFAULT_FRAME) !== 'full'
}

/**
 * 在模型坐标系里框出"取景带"。
 * @param {string} frame 取景模式
 * @param {number} baseW 模型原始宽（模型单位）
 * @param {number} baseH 模型原始高（模型单位）
 * @returns {{x:number,y:number,w:number,h:number,anchorY:number}}
 *   anchorY = 取景带底边在"整张模型"里的高度占比，也就是 pixi 的 anchor.y
 */
export function frameBand(frame, baseW, baseH) {
  const p = framePreset(frame)
  const w = baseW * (p.right - p.left)
  const h = baseH * (p.bottom - p.top)
  return {
    x: baseW * p.left,
    y: baseH * p.top, // 可为负：越过画布上边界往上的余量
    w,
    h,
    anchorY: p.bottom,
    // 取景带中心相对"画布中心"的偏移（模型单位）。美术偏右时取景带也偏右，
    // fitBand 靠它把取景带摆到框中央，而不是把画布中心摆到框中央。
    centerOffset: baseW * ((p.left + p.right) / 2 - 0.5)
  }
}

/**
 * 把取景带"完整装进"画布（contain）。
 *
 * 硬约束：scale === 1 时，带子的渲染矩形必须完全落在画布可用区内（>0 的余量），
 * 这样形象永远不可能越界去盖住画布外的 UI。
 *
 * @param {{band:object, boxW:number, boxH:number, scale?:number, pad?:object}} o
 *   pad: {top,right,bottom,left} 安全边距（像素），用来避开画布内的 UI
 * @returns {{scale:number,x:number,y:number,anchorY:number,bandW:number,bandH:number,rendered:object}}
 */
export function fitBand({ band, boxW, boxH, scale = 1, pad = {} }) {
  const pl = num(pad.left)
  const pr = num(pad.right)
  const pt = num(pad.top)
  const pb = num(pad.bottom)

  const availW = Math.max(1, boxW - pl - pr)
  const availH = Math.max(1, boxH - pt - pb)

  // contain：取两个方向里更"紧"的那个 → 带子完整可见，绝不被裁
  const fit = Math.min(availW / band.w, availH / band.h)
  const s = fit * scale

  // 锚点是带子底边中点。x 的算法：
  //   先让"画布中心"落在可用区中心，再减去取景带相对画布中心的偏移 ——
  //   这样摆在框正中的是**取景带**（也就是形象本身），而不是声明的画布。
  //   注意带子是否偏心不影响 rendered（推导后 offset 会约掉），rendered 始终是居中矩形。
  const x = pl + availW / 2 - num(band.centerOffset, true) * s
  const y = boxH - pb
  const rw = band.w * s
  const rh = band.h * s

  return {
    scale: s,
    x,
    y,
    anchorY: band.anchorY,
    bandW: band.w,
    bandH: band.h,
    rendered: { left: pl + (availW - rw) / 2, top: y - rh, width: rw, height: rh }
  }
}

/** 判断渲染矩形是否完全落在画布内（容差 tol 像素） */
export function isInsideBox(rendered, boxW, boxH, tol = 0.5) {
  if (!rendered) return false
  return (
    rendered.left >= -tol &&
    rendered.top >= -tol &&
    rendered.left + rendered.width <= boxW + tol &&
    rendered.top + rendered.height <= boxH + tol
  )
}

/** 数值兜底：非法/未定义 → 0；allowNegative 时允许负值（centerOffset 可为负） */
function num(v, allowNegative = false) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (allowNegative) return n
  return n > 0 ? n : 0
}
