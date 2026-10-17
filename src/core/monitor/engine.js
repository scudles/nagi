// src/core/monitor/engine.js
// 凪 · 活动监测编排引擎（M3，纯逻辑 / 全依赖注入）。
// 一次 tick 的链路：
//   采样 → 隐私闸（开关/勿扰/黑名单）→ 统计 → 规则 → 节流 → 开口
//
// 这里不碰 Electron、不碰文件、不碰网络，方便单测：
//   sampler / 时钟 / 规则表 / 台词选择器全部从外部注入。
// 主进程用 main/monitor/index.js 把真实实现（powerMonitor + PowerShell + persona）接上。

import { gateSample, collectionAllowed } from './privacy.js'
import { classify, createTracker } from './tracker.js'
import { createThrottle } from './throttle.js'
import { evaluateRules, RULES } from './rules.js'

/**
 * @param {object} deps
 * @param {{sample: () => Promise<object|null>}} deps.sampler 采集器
 * @param {() => object} deps.getPrivacy 读取隐私配置
 * @param {(payload:{ruleId:string, mood:string, vars:object, text:string, stats:object}) => void} deps.onProactive 触发回调
 * @param {(poolKey:string, vars:object) => string} deps.pickText 台词选择器（反重复由 persona 负责）
 * @param {() => number} [deps.now] 时钟
 * @param {object} [deps.tracker] 统计器（默认自建）
 * @param {object} [deps.throttle] 节流器（默认自建）
 * @param {Array} [deps.rules] 规则表（默认 RULES）
 * @param {(msg:string, ...rest:any[]) => void} [deps.log] 日志
 */
export function createMonitorEngine({
  sampler,
  getPrivacy = () => ({}),
  onProactive = () => {},
  onPresenceSample = () => {},
  pickText = () => '',
  now = () => Date.now(),
  tracker,
  throttle,
  rules = RULES,
  log = () => {}
} = {}) {
  const trk = tracker || createTracker({ now })
  const thr = throttle || createThrottle({ now })
  let last = null

  /**
   * 跑一次采样与判断。
   * @returns {Promise<object>} 结果对象，字段说明见下方各 return 分支
   */
  async function tickOnce() {
    const privacy = getPrivacy() || {}

    // 采集前先过隐私闸：关闭监测 / 勿扰时不采样。
    // 若先采样后过闸，窗口标题仍会被读到（只是结果被丢弃），那不算「停采」。
    if (!collectionAllowed(privacy)) {
      onPresenceSample(null)
      return { skipped: privacy.monitorEnabled === false ? 'disabled'
        : privacy.doNotDisturb === true ? 'dnd' : 'only-presence' }
    }

    let raw = null
    try {
      raw = await (sampler ? sampler.sample() : null)
    } catch (err) {
      log('[monitor] 采样失败：' + (err && err.message ? err.message : err))
      return { error: 'sample' }
    }
    if (!raw) return { skipped: 'no-sample' }

    const gate = gateSample(raw, privacy)
    if (gate.skip) {onPresenceSample(null);return { skipped: gate.reason }}
    // 只输出通过隐私闸的闲置秒数与**活动分类**（6 个枚举之一）。
    // 窗口标题/应用名一律不外传：时间状态机只要空闲秒数，
    // 「她想一下」那层也只需要知道"在工作/看视频/打游戏…"这个级别。
    try {onPresenceSample({ts:raw.ts,idleSec:raw.idleSec,category:classify(raw)})} catch { /* 时间感故障不影响 M3 */ }

    trk.record(raw)
    const stats = trk.stats()

    const hit = evaluateRules(stats, rules)
    if (!hit) return { quiet: true, stats }

    if (!thr.allow(hit.rule)) return { throttled: hit.rule.id, stats }

    let text = ''
    try {
      text = pickText(hit.rule.pool, hit.vars) || ''
    } catch (err) {
      log('[monitor] 选台词失败：' + (err && err.message ? err.message : err))
    }
    if (!text) return { empty: hit.rule.id, stats }

    const candidate = { ruleId: hit.rule.id, mood: hit.rule.mood, vars: hit.vars || {}, text, stats, ts: now() }
    try {
      if (onProactive(candidate) === false) return { suppressed: hit.rule.id, stats }
    } catch (err) {
      log('[monitor] 回调失败：' + (err && err.message ? err.message : err))
      return { error: 'callback', stats }
    }
    thr.note(hit.rule)
    last = candidate
    return last
  }

  /** 最近一次成功开口的记录（无则 null） */
  function snapshot() {
    return last
  }

  return { tickOnce, snapshot, tracker: trk, throttle: thr }
}
