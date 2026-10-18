// src/core/memory/forget-guard.js
// C5-BG-02：防"旧来源迟回复活"。
//
// 场景（EVAL 明确要求）：主对话的异步记忆抽取已经拿到旧轮输入、模型还没返回，
// 这期间用户把那条经历忘了；等模型结果回来，如果直接写进 memory/RAG，
// 用户就会看到"我明明删了，它又回来了"。
//
// 做法：遗忘发生时把**可识别片段**记进一个进程内有界表；抽取结果回来时，
// 命中片段的新增项一律丢弃（无关的新内容照常写入）。
// 为什么不靠"轮次是否被删"：用户忘的可能是更早的一条记忆，而不是这一轮流水。
//
// 纯逻辑、无 IO、无 Electron；片段归一化与 notes 的匹配口径保持一致。
const MIN_FRAGMENT = 4

/** 把一段正文切成可识别片段（整句 + 按标点切开的子句），太短的丢弃 */
export function normalizeFragments(texts) {
  const out = new Set()
  for (const raw of Array.isArray(texts) ? texts : []) {
    const s = String(raw || '').trim()
    if (!s) continue
    out.add(s)
    for (const piece of s.split(/[，,。.；;！!？?\s]+/)) {
      const t = piece.trim()
      if (t) out.add(t)
    }
  }
  return [...out].filter((s) => s.length >= MIN_FRAGMENT)
}

/**
 * @param {{maxFragments?:number}} [opts]
 */
export function createForgetGuard({ maxFragments = 300 } = {}) {
  let fragments = []
  let epoch = 0

  return {
    /** 遗忘发生时调用：记片段 + 代数 +1（代数只用于诊断/日志） */
    noteForget(texts) {
      const next = normalizeFragments(texts)
      if (!next.length) return epoch
      const merged = [...next, ...fragments.filter((f) => !next.includes(f))]
      fragments = merged.slice(0, Math.max(1, maxFragments))
      epoch++
      return epoch
    },
    epoch() {
      return epoch
    },
    fragments() {
      return [...fragments]
    },
    /** 这段文本是否包含已遗忘内容 */
    hitsForgotten(text) {
      const s = String(text || '')
      if (!s) return false
      return fragments.some((f) => s.includes(f))
    },
    /** 过滤抽取结果的新增项：命中的丢掉，其余保留（无关新内容仍可写） */
    filterAdds(texts) {
      if (!Array.isArray(texts)) return []
      return texts.filter((t) => !this.hitsForgotten(t))
    },
    /** 仅测试/重启用 */
    reset() {
      fragments = []
      epoch = 0
    }
  }
}
