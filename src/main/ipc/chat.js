// src/main/ipc/chat.js
// 对话 / Agent 事件的 IPC 入口。真正的编排在 main/agent.js（LLM + 工具 + 安全门 + 确认回路）。

import { ipcMain } from 'electron'
import { IPC } from '../../shared/protocol.js'
import { handleChatSend, resolveConfirm, abortChat } from '../agent.js'

export function registerChatIpc() {
  ipcMain.handle(IPC.CHAT_SEND, (_e, { text }) => handleChatSend(text))
  ipcMain.handle(IPC.CHAT_ABORT, () => abortChat())
  ipcMain.handle(IPC.TOOL_CONFIRM, (_e, { id, approved }) => resolveConfirm(id, approved))
}
