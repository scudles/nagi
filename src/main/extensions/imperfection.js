// src/main/extensions/imperfection.js
// BLUE-4 扩展：不完美机制的主进程侧接线（契约 §5）。
//
// 契约边界（改这个文件前先读）：
//   · 只导出 install(api)（可返回 dispose），不在 import 顶层起后台任务/落盘/联网；
//   · 概率门只作用在**可选表达候选**层：归来开口这类"她想说但说不说都行"的话；
//     提醒（reminders.onDue / 调度）与工具执行**绝不**经过本模块——也不提供可拦截它们的接口；
//   · 默认关闭（forgetProbability 默认 0）：默认行为与原来完全一致，不延迟任何东西；
//   · defer 只是「这次不说」，必须保留决策记录、10 分钟内可恢复，且不能谎称遗忘；
//   · 侧车状态只放在内存里（不落盘），全局关闭即清空、不重放积压。
//
// 归因：归来是「可选主动表达」（契约 §3.2），不是提醒；它被 companion 总预算与
// 归来配额（≤3/天）约束，没有提醒/承诺语义，所以可以作为低风险可选层使用。

import { getSettings } from '../settings-store.js'
import {
  decideOptionalFollowup,
  enterLowPressure,
  tickLowPressure,
  comfort,
  repairCandidate,
  resetImperfectionState,
  normalizeImperfectionState,
  emptyImperfectionState
} from '../../core/presence/imperfection.js'

let state = emptyImperfectionState()
/** 待补救信号（由红线区的用户消息通道写入；本期只保留状态与出口） */
let pendingSignal = null

const cfg = () => getSettings().presence?.imperfection || {}

/** 读配置并跟上开关：全局关闭 → 立刻清缓存（不重放积压） */
function syncConfig(now = Date.now()) {
  const c = cfg()
  if (c.enabled !== true) {
    state = resetImperfectionState(now)
    return null
  }
  state = tickLowPressure(state, now)
  return c
}

/**
 * 可选表达门禁：**真·延迟**返回 true 时调用方应当保持安静。
 * @param {string} id 候选的唯一标识（同一候选只判一次）
 * @param {object} intention 意向（默认按重要处理，见 classifyIntention）
 * @returns {{defer:boolean, reason:string, until:number|null}}
 */
export function deferOptionalExpression(id, intention, now = Date.now()) {
  const c = syncConfig(now)
  if (!c) return { defer: false, reason: 'disabled', until: null }
  const r = decideOptionalFollowup({ id, intention, now, config: c, state })
  state = r.state
  return { defer: r.action === 'defer', reason: r.reason, until: r.until }
}

/** 低气压：尝试进入 / 读取（只影响语气档位，不关闭功能、不变慢工具） */
export function lowPressure({ now = Date.now(), busy = false, crisis = false, rng } = {}) {
  const c = syncConfig(now)
  if (!c) return { active: false, entered: false, reason: 'disabled' }
  const entered = enterLowPressure({ now, rng, state, config: c, busy, crisis })
  state = entered.state
  return { entered: entered.entered, reason: entered.reason, active: !!state.lowPressure }
}

/** 用户明确安慰：最多缩短剩余时间一半，每段一次；不碰互动计时 */
export function comfortLowPressure(sourceMessageId = null, now = Date.now()) {
  if (syncConfig(now) === null) return { reduced: 0, reason: 'disabled' }
  const r = comfort({ state, now, sourceMessageId })
  state = r.state
  return { reduced: r.reduced, reason: r.reason }
}

/**
 * 记录一次停止/负面/越界信号（供补救回路用）。
 * 本期没有用户消息通道接进来（红线区），保留出口；一旦接上即可生效。
 */
export function noteRepairSignal(kind, at = Date.now()) {
  pendingSignal = kind ? { kind, at } : null
  return !!pendingSignal
}

/** 补救候选：立即停止优先，最多一次简短修复，每天 1 次、间隔 6 小时 */
export function takeRepair(now = Date.now()) {
  const c = syncConfig(now)
  const signal = pendingSignal
  pendingSignal = null
  if (!c) return { text: null, reason: 'disabled', stopped: true }
  const r = repairCandidate({ state, now, config: c, signal, privacy: getSettings().privacy || {} })
  state = r.state
  return { text: r.text, reason: r.reason, stopped: r.stopped }
}

export function install(api) {
  // presence 事件只用来做两件事：跨日归零清缓存、开关关闭时清空（不新增 timer）
  const stopEvents = api.subscribePresenceEvents(() => {
    try {
      syncConfig()
    } catch {
      /* 订阅回调不能影响状态机 */
    }
  })
  // 主动内容出口：只有在待补救信号存在、且补救开关开着时才给一句短修复；
  // 其余一律返回 null —— 不抢用户对话、不替归来编固定台词。
  const stopProvider = api.registerProactiveProvider('imperfection-repair', () => {
    try {
      const r = takeRepair()
      return r?.text ? { text: r.text, mood: 'calm' } : null
    } catch {
      return null
    }
  })
  return () => {
    for (const stop of [stopProvider, stopEvents]) {
      try {
        stop()
      } catch {
        /* 卸载失败不阻断退出 */
      }
    }
    // 全局关闭：清掉概率缓存与积压
    state = resetImperfectionState()
    pendingSignal = null
  }
}

/** 测试/诊断用：只读状态快照 */
export function __peekImperfection() {
  return normalizeImperfectionState(state)
}
