// src/renderer/js/chat.js
// 订阅主进程 Agent 事件、驱动 UI，并处理输入。

import { EVT, AGENT_EVENT } from '../../shared/protocol.js'
import * as ui from './ui.js'

let current = null // 进行中的凪消息节点
let streamed = false // 本轮是否已经流式输出过
let hooks = { onEmotion: () => {}, onStatus: () => {}, onMonologue: () => {}, onTextDelta: () => {}, onDone: () => {} }
let busy = false

export function initChat(customHooks = {}) {
  hooks = { ...hooks, ...customHooks }

  window.nagi.on(EVT.AGENT, onAgentEvent)

  ui.els.btnSend.addEventListener('click', send)
  ui.els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })
  ui.els.input.addEventListener('input', autoGrow)
}

function autoGrow() {
  const el = ui.els.input
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

async function send() {
  const text = ui.els.input.value.trim()
  if (!text || busy) return
  ui.els.input.value = ''
  autoGrow()
  ui.addMessage('user', text)
  // 开启新一轮时重置流式状态（不要放在 finally：DONE 事件可能晚于 invoke 返回到达）
  current = null
  streamed = false
  busy = true
  ui.els.btnSend.disabled = true
  try {
    await window.nagi.chat.send(text)
  } catch (err) {
    ui.addMessage('error', String(err && err.message ? err.message : err))
  } finally {
    busy = false
    ui.els.btnSend.disabled = false
  }
}

function onAgentEvent(evt) {
  if (!evt || !evt.type) return
  console.log('[agent]', evt.type, JSON.stringify(evt).slice(0, 120))
  switch (evt.type) {
    case AGENT_EVENT.TEXT_DELTA:
      if (!current) current = ui.addMessage('nagi', '')
      current.append(evt.text || '')
      streamed = true
      ui.appendBubble(evt.text || '')
      hooks.onTextDelta(evt.text || '') // 驱动口型：她在说话，嘴要动
      break

    case AGENT_EVENT.EMOTION:
      ui.setMood(evt.emotion)
      hooks.onEmotion(evt.emotion, evt.intensity)
      break

    case AGENT_EVENT.STATUS:
      ui.setStatus(evt.state, evt.detail)
      hooks.onStatus(evt.state, evt.detail)
      break

    case AGENT_EVENT.TOOL_CALL:
      ui.addToolCard({ id: evt.id, phase: 'call', name: evt.name, args: evt.args, risk: evt.risk })
      break

    case AGENT_EVENT.TOOL_RESULT:
      ui.addToolCard({ id: evt.id, phase: 'result', name: evt.name, ok: evt.ok, ms: evt.ms, summary: evt.summary })
      break

    case AGENT_EVENT.CONFIRM:
      handleConfirm(evt)
      break

    case AGENT_EVENT.DONE:
      // 若全程没有流式输出（如模型直接返回整段），才补一条完整消息
      if (!streamed && evt.text) ui.addMessage('nagi', evt.text)
      ui.setStatus('idle')
      ui.hideBubble()
      hooks.onDone()
      break

    case AGENT_EVENT.ERROR:
      ui.addMessage('error', evt.message || '未知错误')
      ui.setStatus('idle')
      current = null
      streamed = false
      hooks.onDone()
      break
  }
}

async function handleConfirm(evt) {
  const approved = await ui.showConfirm({ name: evt.name, description: evt.description, risk: evt.risk })
  ui.addToolLog(`${approved ? '允许' : '拒绝'}：${evt.name}`)
  await window.nagi.chat.confirm(evt.id, approved)
}

/** 从桌宠/工作台外部触发一次发送（备用） */
export function sendText(text) {
  ui.els.input.value = text
  send()
}
