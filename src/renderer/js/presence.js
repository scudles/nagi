// src/renderer/js/presence.js
// 实感渲染层接线（BLUE-2）：把主进程广播的 presence 快照落到表现层。
//
// 职责（契约：推荐值映射到实际模型参数；**不得产生权威状态**）：
//   1. 时段表现：rhythm → l2d.applyRhythmPose（参数叠加，平滑不硬切）；
//      面容归情绪状态机（mood.applyRhythm），本文件不夺脸；
//   2. 归来检测：away/suspended → present 且离开够久 → 弹「她留了张便签」入口
//      （便签数据走 BLUE-3，本期只有入口，不伪造内容）；
//   3. 双窗同步：presence:changed 是主进程向所有窗口广播的同一份快照，
//      两个渲染进程各自订阅各自渲染，天然同步（与情绪广播同一机制）。
//
// 所有事实来自快照；本文件不改时钟、不写设置、不起定时器。

import { PRESENCE_EVENT } from '../../shared/presence-protocol.js'
import { reunionPrompt, rhythmSuppressesRandomMotion } from '../../core/presence/rhythm-pose.js'
import * as l2d from './live2d.js'

let current = null // 最新快照
let prev = null // 上一份快照（归来检测要用「上一态」）
let onReunion = null
let getConfig = () => ({}) // settings.presence 的取值器（设置变更后即时生效）

/** 当前快照（只读副本语义：调用方不得改） */
export function getPresence() {
  return current
}

/** 当前 rhythm（可能为 null：presence 服务未启动/快照未就绪） */
export function getRhythm() {
  return current?.rhythm || null
}

/** 此时段是否该抑制随机待机动作（night 的 motion 建议 'quiet' 的落地） */
export function randomMotionSuppressed() {
  return rhythmSuppressesRandomMotion(getRhythm())
}

/** 模型刚就绪 / 快照刚到时调用：把当前 rhythm 落到模型上 */
export function applyCurrentRhythm() {
  if (!l2d.isReady()) return false
  return l2d.applyRhythmPose(getRhythm())
}

function handle(snap) {
  prev = current
  current = snap || null
  if (!snap) return
  applyCurrentRhythm()
  const { prompt, durationMs } = reunionPrompt(prev, snap, getConfig())
  if (prompt && onReunion) {
    try {
      onReunion({ durationMs, at: snap.rhythm?.at || Date.now() })
    } catch {
      /* 入口 UI 失败不能影响表现层 */
    }
  }
}

/**
 * 订阅实感快照。
 * @param {{onReunion?:(e:{durationMs:number,at:number})=>void, getConfig?:()=>object}} [opts]
 * @returns {()=>void} 取消订阅
 */
export function initPresence(opts = {}) {
  onReunion = opts.onReunion || null
  getConfig = opts.getConfig || getConfig
  const offEvent = window.nagi.on(PRESENCE_EVENT, handle)
  // 初始快照：不必等第一次广播（心跳 15s 一次），先拉一次让时段表现立刻到位
  window.nagi.presence.status().then(handle).catch(() => { /* 旧主进程无该通道时静默 */ })
  return () => {
    offEvent()
    onReunion = null
  }
}
