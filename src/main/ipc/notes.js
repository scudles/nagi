// src/main/ipc/notes.js
// BLUE-3 便签/留痕/回忆物的可信 IPC（只读 + 清除）。
//
// 边读边界（契约 §6）：渲染层只能看与清，不能伪造/写入；
// 开关一律走既有 settings 通道（presence.notesEnabled / tracesEnabled / anchorsEnabled）。

import { BrowserWindow } from 'electron'
import { trustedHandle } from './trusted.js'
import { broadcast } from '../windows.js'
import { NOTES_IPC, NOTES_EVENT } from '../../shared/notes-protocol.js'
import { listNotes, clearNotes, setNotesChangedListener } from '../presence-notes.js'
import {
  pickExternalDir,
  revokeExternalDir,
  writeNoteFile,
  setNotesReader
} from '../notes-file.js'

function ownerOf(e) {
  return BrowserWindow.fromWebContents(e.sender)
}

export function registerNotesIpc() {
  // 外部写入需要读便签正文；用注入而不是反向 import，避免与 presence-notes 形成环
  setNotesReader(() => listNotes().notes)
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

  // 外部便签写入：选目录 / 撤销 / 写一张（每次都弹确认框）
  trustedHandle(NOTES_IPC.EXTERNAL_PICK, async (e) => {
    const r = await pickExternalDir(ownerOf(e))
    if (r.ok) broadcast(NOTES_EVENT, listNotes())
    return r
  })
  trustedHandle(NOTES_IPC.EXTERNAL_REVOKE, () => {
    const r = revokeExternalDir()
    broadcast(NOTES_EVENT, listNotes())
    return r
  })
  trustedHandle(NOTES_IPC.EXTERNAL_WRITE, async (e, payload = {}) => {
    const r = await writeNoteFile(payload?.noteId, ownerOf(e))
    if (r.ok) broadcast(NOTES_EVENT, listNotes())
    return r
  })
}
