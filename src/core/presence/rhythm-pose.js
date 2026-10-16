// src/core/presence/rhythm-pose.js
// 昼夜时段 → Live2D 表现目标（BLUE-2）：把 rhythm 快照翻成「轻微参数叠加」。
//
// 分层（与既有架构对齐）：
//   · 表情/面容 —— 归情绪状态机（mood.applyRhythm 每时段推一次温和基线，RED-2 已接线），
//     本模块**不夺面容**，避免深夜自动愁眉苦脸与真实情绪打架；
//   · 参数叠加 —— 本模块：night 安静（垂目/低头/慢呼吸/微阖眼）、afternoon 慵懒
//     （半眯眼/微张口/低头/慢呼吸）。全部是「叠加在模型自身呼吸/待机动作之上」的
//     轻微倾向，进入退出都走平滑（core/pose.js 的指数缓动），不硬切；
//   · 动作组   —— 模型没有「哈欠/安静」专用组（Lisette 动作组：Idle/TapBody/Greet/
//     Happy/Sad/Angry/Frenzy/Special），午后打哈欠**不做假动作**，用参数近似慵懒；
//     night 的 motion 建议 'quiet' 由接线层解读为「抑制随机待机动作」。
//
// 禁止映射不存在的参数：目标表先按 availableIds（模型实际参数清单）过滤，
// 过滤后为空则返回 null（接线层视为「本模型无对应表现，不施加」）。
//
// 纯逻辑，无 Electron / Node 依赖，可 node --test。

import { isSubtlePose } from '../pose.js'

/**
 * 时段表现预设。值为 Live2D 参数（角度单位度，眼/嘴/呼吸是 0~1 归一）。
 *
 * 数值刻意保守——她常驻桌面上，夸张了就像动画片而不是她；
 * 与「思考姿态」同一口径（test/pose-guard.test.js：角度 ≤10°、眼珠 ≤0.6）。
 *
 * 依据（2026-10-17 对 Lisette 模型 cdi3.json 321 个参数的实扫）：
 *   ParamEyeBallY / ParamAngleX / ParamBodyAngleX / ParamBreath /
 *   ParamEyeLOpen / ParamEyeROpen / ParamMouthOpenY 均存在于该模型。
 */
export const RHYTHM_POSE_PRESETS = {
  // 深夜安静：目光微垂、头微低、呼吸放慢、眼微阖
  night: {
    ParamEyeBallY: -0.15,
    ParamAngleX: -2.5,
    ParamBodyAngleX: -1,
    ParamBreath: -0.2,
    ParamEyeLOpen: -0.06,
    ParamEyeROpen: -0.06
  },
  // 午后慵懒（模型无哈欠动作组，用参数近似）：半眯眼、微张口、低头、呼吸放缓
  afternoon: {
    ParamEyeLOpen: -0.2,
    ParamEyeROpen: -0.2,
    ParamEyeBallY: -0.12,
    ParamAngleX: -3,
    ParamMouthOpenY: 0.08,
    ParamBreath: -0.15
  }
  // morning / noon / evening：无预设（返回 null，不施加叠加）
}

/** 时段表现进入/退出的平滑速率（每秒收敛比例，与思考姿态同量级） */
export const RHYTHM_POSE_EASE_RATE = 3

/**
 * rhythm 快照 → 时段表现参数目标。
 *
 * @param {object|null} rhythm presence 快照里的 rhythm（{enabled, period, ...}）
 * @param {Iterable<string>} [availableIds] 模型实际拥有的参数 ID；传入时过滤掉
 *        模型没有的参数（「禁止映射不存在的参数」）；不传则不过滤（调用方自担）
 * @returns {{name:string, params:Record<string,number>}|null}
 *         null = 不施加（开关关闭 / 无预设 / 过滤后为空 / 入参非法）
 */
export function rhythmPoseTargets(rhythm, availableIds) {
  if (!rhythm || typeof rhythm !== 'object') return null
  if (rhythm.enabled !== true) return null // 昼夜节律开关关闭：不表现
  const preset = RHYTHM_POSE_PRESETS[rhythm.period]
  if (!preset) return null
  let params = { ...preset }
  if (availableIds) {
    const have = new Set(availableIds)
    params = Object.fromEntries(Object.entries(params).filter(([id]) => have.has(id)))
    if (!Object.keys(params).length) return null
  }
  if (!isSubtlePose(params)) return null // 口径兜底：预设写飘了也不许夸张
  return { name: rhythm.period, params }
}

/**
 * 该时段是否应抑制「随机待机动作」（night 的 motion 建议 'quiet' 的落地解读）。
 * @param {object|null} rhythm
 * @returns {boolean}
 */
export function rhythmSuppressesRandomMotion(rhythm) {
  return !!(rhythm && typeof rhythm === 'object' && rhythm.enabled === true && rhythm.period === 'night')
}

/* ---------------- 归来便签提示门（BLUE-2 入口 UI 用） ----------------
 *
 * 契约 §4：便签候选来自「有效 reunion 候选」等事件，每天最多 3 条、间隔 ≥30 分钟、
 * 勿扰不展示。配额与持久化属 BLUE-3；本门只做纯状态转换判断（无配额、无状态），
 * BLUE-3 落地配额时在同文件补计数门。
 */

/**
 * 是否该弹「她留了张便签」入口。
 *
 * 归来时长从**上一份快照**的 away.since 算到新快照时间（next.rhythm.at）——
 * away.returnNow() 会把 since 置 null，新快照里已经取不到离开起点。
 *
 * @param {{away?:{state?:string,since?:number},rhythm?:{at?:number}}|null} prev 上一份快照
 * @param {{away?:{state?:string,since?:number},rhythm?:{at?:number}}|null} next 新快照
 * @param {{reunionMinMs?:number}} [config] settings.presence（未净化值亦可）
 * @returns {{prompt:boolean, durationMs:number}}
 */
export function reunionPrompt(prev, next, config = {}) {
  const min = Number.isFinite(config?.reunionMinMs) ? Math.max(0, config.reunionMinMs) : 300000
  const from = prev?.away?.state, to = next?.away?.state
  if (from !== 'away' && from !== 'suspended') return { prompt: false, durationMs: 0 }
  if (to !== 'present') return { prompt: false, durationMs: 0 }
  const since = Number(prev?.away?.since) || 0
  const now = Number(next?.rhythm?.at) || 0
  const durationMs = since > 0 && now > since ? now - since : 0
  return { prompt: durationMs >= min, durationMs }
}
