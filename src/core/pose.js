// src/core/pose.js
// 「思考姿态」的纯逻辑：参数目标值 + 指数平滑。
//
// 为什么抽成纯模块：live2d.js 里剩下的只是"把值写进 coreModel"的管道，
// 而"思考时该歪多少度、收回得多快"是产品判断，必须可单测、可复盘。
//
// 背景（2026-10-15 需求）：立绘动作改由对话状态驱动——
//   · 生成回复期间（思考中）→ 思考姿态：目光从人身上移开、微微下垂，头低一点、侧一点；
//   · 回复返回后 → 按回答内容的情绪翻脸 + 轻微动作（情绪判断不出 → 中立）；
//   · 空闲 → 模型自身的呼吸/眨眼/待机动作（本模块不参与，全部归零即交还）。
// 原来的"目光与身体跟随鼠标"已取消：focusController 每帧都会把鼠标最后停留的
// 位置写进 ParamAngle*/ParamEyeBall*，光撤监听不够，必须在加载时把它瞬间归中。

/**
 * 姿态预设。值为 Live2D 参数（角度单位是度，眼珠是 -1~1）。
 *
 * 全部刻意保持"轻微"——她常驻在桌面上，夸张动作会像动画片而不是她。
 * 锁定口径（test/pose-guard.test.js）：角度 ≤10°、眼珠 ≤0.6。
 */
export const POSE_PRESETS = {
  thinking: {
    ParamEyeBallX: 0.35, // 目光移开（不盯着人看）
    ParamEyeBallY: -0.45, // 视线微微下垂
    ParamAngleX: -4, // 头微微低
    ParamAngleZ: 5, // 侧头（想事情时歪头）
    ParamBodyAngleX: -2 // 身体跟着一点点，别只有头在动
  }
}

/** 中立姿态名：全部归零 = 交还给模型自身的呼吸/动作 */
export const POSE_NEUTRAL = 'neutral'

/** 思考姿态的平滑速率（每秒收敛比例，越大越快） */
export const POSE_EASE_RATE = 6

/**
 * 取某姿态的参数目标表；中立 / 未知姿态 → 空表（调用方视为"全部归零"）。
 * @param {string} [name]
 * @returns {Record<string, number>}
 */
export function poseTargets(name) {
  const p = name && POSE_PRESETS[name]
  return p ? { ...p } : {}
}

/**
 * 指数平滑：与帧率无关（dt 是秒）。rate 越大收敛越快。
 * 用于姿态的进入/退出，避免参数跳变。
 */
export function easePose(cur, target, dt, rate = POSE_EASE_RATE) {
  const k = 1 - Math.exp(-rate * Math.max(0, Number(dt) || 0))
  return cur + (target - cur) * k
}

/** 是否还在平滑路上（离目标还远） */
export function poseSettled(cur, target, eps = 1e-4) {
  return Math.abs(cur - target) <= eps
}

/** 「轻微」口径：角度参数 ≤10°、眼珠参数 ≤0.6（防手滑写成夸张动画） */
export function isSubtlePose(values) {
  for (const [id, v] of Object.entries(values || {})) {
    if (!Number.isFinite(v)) return false
    const limit = /^ParamEyeBall/i.test(id) ? 0.6 : 10
    if (Math.abs(v) > limit) return false
  }
  return true
}
