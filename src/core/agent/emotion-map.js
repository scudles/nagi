// src/core/agent/emotion-map.js
// 把"工具 / 阶段状态"映射成情绪，用于给桌宠套皮（表情 + 语气）。

import { AGENT_STATE } from '../../shared/protocol.js'

/** 阶段 → 情绪 */
const STATE_EMOTION = {
  [AGENT_STATE.IDLE]: 'calm',
  [AGENT_STATE.THINKING]: 'puzzled',
  [AGENT_STATE.ACTING]: 'calm',
  [AGENT_STATE.WAITING]: 'worry'
}

/** 工具 → 情绪（优先级高于阶段） */
const TOOL_EMOTION = {
  browser_open: 'calm',
  browser_act: 'calm',
  browser_scrape: 'puzzled',
  file_read: 'calm',
  file_write: 'smile',
  file_list: 'calm',
  run_command: 'worry',
  open_app: 'calm',
  screenshot: 'calm',
  web_search: 'puzzled',
  home_get: 'calm',
  home_set: 'smile',
  home_scene: 'smile',
  notify: 'smile'
}

export function emotionForState(state) {
  return STATE_EMOTION[state] || 'calm'
}

export function emotionForTool(name) {
  return TOOL_EMOTION[name] || 'calm'
}

/** 工具结果 → 情绪（成功微开心 / 失败担心） */
export function emotionForToolResult(name, ok) {
  if (!ok) return 'worry'
  return TOOL_EMOTION[name] || 'smile'
}
