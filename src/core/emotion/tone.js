// src/core/emotion/tone.js
// 「本句语气」的生命周期（B5 打回项）。
//
// 打回原文：`lastTone` 赋值后从不清除，上一轮语气残留到下一轮。
// 为什么必须清：tone 是**这一句**的表达语气，不是长期状态。它挂在 MOOD 快照上广播，
// 若不清，下一轮生成期间的心跳广播会继续带着上一句的 tone——
// 于是"脸已经是新的、快照里还是旧语气"，语音/日志都会跟着错。
//
// 生命周期只有三步，写死在这里免得再散回 agent.js：
//   beginTurn()  新一轮开始 → 清空
//   settle(tone) 这一句说完（DONE）→ 固定
//   current()    发布快照时读 → 只读，不改
const DEFAULT_SOURCE = 'reply'

export function createToneState() {
  let tone = null
  let source = null

  return {
    /** 新一轮开始：上一句的语气立即失效 */
    beginTurn() {
      tone = null
      source = null
    },
    /** 这一句说完：固定语气（只在这一句有效，不写回长期心境） */
    settle(nextTone, nextSource = DEFAULT_SOURCE) {
      const t = typeof nextTone === 'string' && nextTone.trim() ? nextTone.trim() : null
      tone = t
      source = t ? (nextSource || DEFAULT_SOURCE) : null
    },
    /** 发布用：返回当前语气与来源（不可变对象） */
    current() {
      return { tone, toneSource: source }
    }
  }
}
