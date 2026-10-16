// IPC 权限边界：只接受本应用注册窗口的顶层渲染帧。
// 不依赖 Electron，方便用伪造 sender/frame 验证导航与 iframe 攻击。
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function sameRendererEntry(actual, expected) {
  try {
    const a = new URL(actual)
    const b = new URL(expected)
    if (a.protocol !== b.protocol) return false
    if (a.protocol === 'file:') {
      return resolve(fileURLToPath(a)).toLowerCase() === resolve(fileURLToPath(b)).toLowerCase()
    }
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

export function isTrustedIpcSource(event, { findWindow, rendererEntry }) {
  const sender = event?.sender
  const frame = event?.senderFrame
  if (!sender || !frame || frame !== sender.mainFrame) return false
  const win = findWindow(sender)
  if (!win || win.isDestroyed?.()) return false
  return sameRendererEntry(frame.url, rendererEntry)
}
