// src/main/ipc/notes.js
// BLUE-3 便签/留痕/回忆物的可信 IPC（只读 + 清除）。
//
// 边读边界（契约 §6）：渲染层只能看与清，不能伪造/写入；
// 开关一律走既有 settings 通道（presence.notesEnabled / tracesEnabled / anchorsEnabled）。

import { trustedHandle } from './trusted.js'
import { broadcast } from '../windows.js'
import { NOTES_IPC, NOTES_EVENT } from '../../shared/notes-protocol.js'
import { listNotes, clearNotes, setNotesChangedListener } from '../presence-notes.js'

export function registerNotesIpc() {
  // 变化广播：两窗收到同一份权威列表（与 presence:changed 同一机制）
  setNotesChangedListener(() => {
    try {
      broadcast(NOTES_EVENT, listNotes())
    } catch {
      /* 广播失败不影响记录 */
    }
  })
  trustedHandle(NOTES_IPC.LIST, () => listNotes())
  trustedHandle(NOTES_IPC.CLEAR, () => clearNotes())
}
