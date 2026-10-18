// src/core/emotion/resolve.js
// B5（情绪裁决统一）：把「长期心境」和「本句语气」合成一份可发布的 resolved 快照。
//
// 为什么需要这一层：
//   以前渲染层在 DONE 时用这一句的情绪标签**满强度**重设表情，于是"她此刻整体在低落"
//   会被"这一句恰好是玩笑"当场抹平——长期状态被一句语气静默覆盖。
//   契约（CONTRACTS §8 D5 不变量）要求："句子语气不得静默覆盖长期 mood"。
//
// 这里只做**字段分层**，不做取值策略：
//   - longMood / intensity / expr：主进程情绪状态机给的长期心境（唯一权威）
//   - tone / toneSource：本句语气，由编排层在表达那一刻固定
// 渲染层只消费，不得反写。

const CALM_FALLBACK = Object.freeze({ mood: 'calm', intensity: 0, expr: 'calm', label: '平静' })

/**
 * @param {{mood:string,intensity:number,expr:string,label:string}} base 状态机快照
 * @param {{tone?:string|null, toneSource?:string|null, now?:()=>number}} [opts]
 * @returns {{mood:string,intensity:number,expr:string,label:string,
 *            longMood:string,tone:string|null,toneSource:string|null,
 *            source:string|null,userInteraction:boolean,capturedAt:number}}
 */
export function resolveMoodSnapshot(base, { tone = null, toneSource = null, now = Date.now } = {}) {
  const b = base && typeof base === 'object' ? base : CALM_FALLBACK
  const longMood = typeof b.mood === 'string' ? b.mood : 'calm'
  const t = typeof tone === 'string' && tone.trim() ? tone.trim() : null
  return {
    mood: longMood,
    intensity: Number.isFinite(b.intensity) ? b.intensity : 0,
    expr: typeof b.expr === 'string' ? b.expr : 'calm',
    label: typeof b.label === 'string' ? b.label : '平静',
    // 长期心境：显式给一份，渲染层与日志都按这个名字读，不再猜 `mood` 是哪一个
    longMood,
    // 本句语气：只在"这一句"有效，不允许写回长期状态
    tone: t,
    toneSource: t ? (toneSource || 'reply') : null,
    source: typeof b.source === 'string' ? b.source : null,
    userInteraction: b.userInteraction === true,
    capturedAt: now()
  }
}
