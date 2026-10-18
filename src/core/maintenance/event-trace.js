// src/core/maintenance/event-trace.js
// B8（P2-04）：**有界、脱敏、可删**的事件轨迹。
//
// 三条硬约束（照契约写死）：
//   · 有界：环形缓冲，条数封顶，绝不无限长（否则日志本身就是新故障源）；
//   · 脱敏：不存正文、不存绝对路径；消息截断，Windows 盘符路径被打码；
//   · 可删：clear() 一键清空，内存里不留副本。
//
// 纯逻辑、无 IO、无 Electron。

const DEFAULT_LIMIT = 200
const MESSAGE_MAX = 120

/** 脱敏：截断 + 打掉绝对路径（用户目录/盘符路径最容易带出隐私） */
export function redactMessage(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // Windows 盘符路径 / 用户目录 / 常见 home 路径一律打码，只留最后一段的文件名形态
  s = s.replace(/\b[A-Za-z]:\\[^\s'"]*/g, '[path]').replace(/\/Users\/[^\s'"]*/g, '[path]').replace(/\/home\/[^\s'"]*/g, '[path]')
  return s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX) + '…' : s
}

/**
 * @param {{limit?:number, now?:() => number}} [opts]
 */
export function createEventTrace({ limit = DEFAULT_LIMIT, now = Date.now } = {}) {
  const cap = Math.max(1, Math.trunc(Number(limit) || DEFAULT_LIMIT))
  let items = []
  let dropped = 0

  return {
    push(event) {
      if (!event || typeof event !== 'object') return null
      const entry = {
        at: Number.isFinite(event.at) ? event.at : now(),
        site: String(event.site || 'unknown').slice(0, 80),
        cls: String(event.cls || 'degrade').slice(0, 24),
        code: event.code ? String(event.code).slice(0, 40) : null,
        message: redactMessage(event.message)
      }
      items.push(entry)
      // 环形：超过上限就丢最旧的，并记一次总丢弃数（不额外存事件）
      while (items.length > cap) {
        items.shift()
        dropped++
      }
      return entry
    },
    /** 最近 n 条（默认全部），按时间正序 */
    list(n) {
      const k = Number.isFinite(n) && n > 0 ? Math.trunc(n) : items.length
      return items.slice(Math.max(0, items.length - k)).map((x) => ({ ...x }))
    },
    size() {
      return items.length
    },
    dropped() {
      return dropped
    },
    /** 可删：清空，不留副本 */
    clear() {
      items = []
      dropped = 0
    }
  }
}
