// src/core/clock.js
// B7 时钟注入的唯一入口（core 内部）。
//
// 为什么不是 `now = Date.now()` 默认值：默认值看起来无害，实际是把"core 不读全局时钟"
// 这条纪律变成了**可选的**——忘了传的调用点不会报错，只会在某个分支上悄悄变成
// 非确定性，测试从此再也没法用固定时间断言。缺依赖就当场抛，问题在第一次跑到时就暴露，
// 而不是等某天发现"同一输入两次输出不一样"。
//
// 什么时候该用：core 里的纯函数/纯逻辑需要一个"现在"才能算结果时。
// 什么时候不该用：确定性纯计算（例如把毫秒格式化成字符串的内部实现）——
// 那类地方用行内 `/* B7:allow:globalClock — 理由 */` 豁免并写清理由。

/**
 * 校验调用方注入的 now。
 * @param {unknown} now 调用方传入的时间戳（毫秒）
 * @param {string} site 报错里要出现的位置，便于一眼定位忘记传的调用点
 * @returns {number}
 */
export function requireNow(now, site) {
  if (!Number.isFinite(now)) {
    throw new TypeError(`${site} 缺少注入依赖：now（core 不得读取全局时钟）`)
  }
  return now
}
