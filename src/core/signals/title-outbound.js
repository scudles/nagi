// src/core/signals/title-outbound.js
// C4（CONTRACTS §6.3）：窗口标题**出站前**的撤销重验。
//
// 为什么要在出站那一刻再验一次：
//   采样发生在几百毫秒之前（有时更久）。这段时间里用户完全可能已经关掉监测、
//   切了勿扰、或者刚把「标题进上下文」关掉。采样时合法不等于发出时合法——
//   把"当时有授权"当成"现在也有"，就是隐私实现里最常见的那种漂移。
//
// 本模块是纯函数：不读盘、不读全局、不抛错。epoch 由调用方从 presence 快照取。
//
// 返回值里带 reason，方便日志与验收断言说清"为什么没发"，而不是一句静默的空。

/** 允许出站的原因 / 拒绝出站的原因（全部可枚举，便于对账） */
export const TITLE_OUTBOUND_REASON = Object.freeze({
  OK: 'ok',
  SWITCH_OFF: 'switch-off',
  MONITOR_OFF: 'monitor-off',
  DND: 'dnd',
  ONLY_PRESENCE: 'only-presence',
  EPOCH_CHANGED: 'epoch-changed',
  NO_SAMPLE: 'no-sample'
})

/**
 * @param {object} opts
 * @param {object} opts.settings        当前设置（读 privacy）
 * @param {number} opts.beforeEpoch     采样开始时的 epoch
 * @param {number} opts.afterEpoch      出站前的 epoch
 * @param {boolean} [opts.hasSample]    这次是否真的采到了标题候选
 * @returns {{send:boolean, reason:string}}
 */
export function titleOutboundAllowed({ settings, beforeEpoch, afterEpoch, hasSample = true } = {}) {
  if (!hasSample) return { send: false, reason: TITLE_OUTBOUND_REASON.NO_SAMPLE }
  const privacy = (settings && settings.privacy) || {}
  // 顺序按契约 §6.2：三护栏（黑名单/勿扰/只陪着）优先于标题开关；
  // 黑名单在采样侧已经整条丢弃，这里只补"临时状态"与开关。
  if (privacy.doNotDisturb === true) return { send: false, reason: TITLE_OUTBOUND_REASON.DND }
  if (privacy.onlyPresence === true) return { send: false, reason: TITLE_OUTBOUND_REASON.ONLY_PRESENCE }
  if (privacy.monitorEnabled === false) return { send: false, reason: TITLE_OUTBOUND_REASON.MONITOR_OFF }
  // 独立开关：只看标题出站，不随其他开关联动（默认开启 = D63）
  if (privacy.titleOutbound === false) return { send: false, reason: TITLE_OUTBOUND_REASON.SWITCH_OFF }
  const before = Number(beforeEpoch)
  const after = Number(afterEpoch)
  if (Number.isFinite(before) && Number.isFinite(after) && before !== after) {
    return { send: false, reason: TITLE_OUTBOUND_REASON.EPOCH_CHANGED }
  }
  return { send: true, reason: TITLE_OUTBOUND_REASON.OK }
}
