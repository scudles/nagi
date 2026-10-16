// src/main/ipc/chat.js
// 对话 / Agent 事件的 IPC 入口。真正的编排在 main/agent.js（LLM + 工具 + 安全门 + 确认回路）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { handleChatSend, resolveConfirm, abortChat } from '../agent.js'

export function registerChatIpc() {
  trustedHandle(IPC.CHAT_SEND, (_e, { text }) => handleChatSend(text))
  trustedHandle(IPC.CHAT_ABORT, () => abortChat())
  trustedHandle(IPC.TOOL_CONFIRM, (_e, { id, approved }) => resolveConfirm(id, approved))
}
