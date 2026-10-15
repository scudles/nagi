// src/core/voice/enum-cache.js
// 「本机能力枚举」（系统语音清单 / 识别引擎清单）的进程内缓存策略。
//
// 为什么单独抽一个纯模块：sapi.js 依赖 electron，单测引不进来；而这条策略踩过坑，
// 必须有测试锁住。
//
// 坑（2026-10-16 实测）：枚举靠 spawn PowerShell，冷启动加载 .NET + System.Speech
// 要几秒，应用启动期主线程繁忙时还会排队 —— 于是失败过一次。旧代码把**空清单也永久缓存**，
// 结果一次偶发超时就把「本机语音 / 本机识别」判死一整场：设置页永远显示 sapi 不可用、
// 识别器清单永远是空的，用户怎么点都没用。
//
// 现在的规则：
//   · 非空结果 = 真实能力，永久缓存（系统装了什么不会变）；
//   · 空结果 = 可能是失败，只缓存 EMPTY_TTL_MS 那么久，过期就允许重试。

/** 空结果（疑似失败）的缓存时长：过期即可重试 */
export const EMPTY_TTL_MS = 30 * 1000

/**
 * 缓存是否还能用。
 * @param {{list:Array, at:number}|null} entry 缓存项
 * @param {number} [now] 当前时间戳（注入时钟，便于测试）
 * @param {number} [ttlMs] 空结果的缓存时长
 * @returns {Array|null} 命中返回清单，未命中返回 null
 */
export function cacheHit(entry, now = Date.now(), ttlMs = EMPTY_TTL_MS) {
  if (!entry || !Array.isArray(entry.list)) return null
  if (entry.list.length > 0) return entry.list
  const at = Number(entry.at) || 0
  return now - at < ttlMs ? entry.list : null
}

/** 造一个缓存项 */
export function cacheEntry(list, now = Date.now()) {
  return { list: Array.isArray(list) ? list : [], at: now }
}
