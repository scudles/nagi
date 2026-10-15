// 本地大脑状态查询独立通道；普通聊天仍使用 shared/protocol.js 的 Agent 事件。
export const LLM_IPC = {
  LOCAL_STATUS: 'llm:local-status'
}
