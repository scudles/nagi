// src/core/maintenance/catch-audit.js
// B8（P2-04）：空 catch 的**后果分类**与统一上报。
//
// 为什么需要分类：项目里 200+ 处空 catch 不是同一种东西。
//   · 读一个可选缓存失败 → 真的可以静默（degrade）
//   · 读存储失败却当成"没有数据" → 看起来像用户数据丢了（must-persist）
//   · 提醒调度失败 → 需要健康状态 + 重试（promise）
// 全都吞掉，等于把"数据丢了"和"缓存没命中"混成一种现象。
//
// 本模块只做两件事：给出五个类、把一次失败按类上报（轨迹 + 是否出声）。
// 不碰 IO、不碰 Electron，可纯单测。

/** 五种后果分类（契约：可降级 / 需可见状态 / 不可静默持久化 / 承诺失败 / 语义失败） */
export const CATCH_CLASS = Object.freeze({
  /** 可降级：失败只影响锦上添花的东西（缓存、可选探针） */
  DEGRADE: 'degrade',
  /** 需可见状态：用户应看到"这一步没成功"，但不能阻断主流程 */
  VISIBLE: 'visible',
  /** 不可静默持久化：写盘 / 读存储失败，静默会伪装成"数据本来就没有" */
  MUST_PERSIST: 'must-persist',
  /** 承诺失败：答应过的事（提醒、承诺簿）没成，必须可重试 + 有健康状态 */
  PROMISE: 'promise',
  /** 语义失败：模型输出不合规 / 解析不了，属于内容层而非 IO */
  SEMANTIC: 'semantic'
})

const CLASSES = Object.freeze(Object.values(CATCH_CLASS))

export function isCatchClass(cls) {
  return CLASSES.includes(cls)
}

/** 该类是否必须"出声"（日志/轨迹之外还应有可见或可重试的处理） */
export function mustSurface(cls) {
  return cls !== CATCH_CLASS.DEGRADE
}

/**
 * 建一个上报器：把一次失败按类写进轨迹，并决定要不要出声。
 * @param {object} o
 * @param {{push:Function}} o.trace 事件轨迹（createEventTrace 的返回）
 * @param {(msg:string)=>void} [o.warn] 出声通道（默认 console.warn）
 * @param {() => number} [o.now]
 */
export function createCatchReporter({ trace, warn = (m) => console.warn(m), now = Date.now } = {}) {
  if (!trace || typeof trace.push !== 'function') throw new TypeError('createCatchReporter 需要 trace')

  /**
   * @param {string} site  出事的调用点（稳定的短名，如 'rag.store-io.readText'）
   * @param {string} cls   CATCH_CLASS 之一
   * @param {unknown} err
   * @returns {{cls:string, surfaced:boolean}}
   */
  return function reportCatch(site, cls, err) {
    const kind = isCatchClass(cls) ? cls : CATCH_CLASS.DEGRADE
    const message = err && err.message ? String(err.message) : String(err || '')
    const surfaced = mustSurface(kind)
    trace.push({
      at: now(),
      site: String(site || 'unknown'),
      cls: kind,
      code: err && err.code ? String(err.code) : null,
      message
    })
    if (surfaced) warn(`[catch:${kind}] ${site} 失败：${message.slice(0, 120)}`)
    return { cls: kind, surfaced }
  }
}
