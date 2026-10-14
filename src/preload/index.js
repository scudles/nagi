// src/preload/index.js
// 通过 contextBridge 暴露最小、安全的 API 给渲染层。
// 原则：渲染层拿不到 Node / Electron 原始对象，也拿不到任何密钥明文。

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, EVT } from '../shared/protocol.js'

const ALLOWED_EVENTS = new Set([EVT.AGENT, EVT.SETTINGS_CHANGED, EVT.HA_EVENT, EVT.MOOD, EVT.PET])

const api = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch)
  },
  secrets: {
    set: (key, value) => ipcRenderer.invoke(IPC.SECRET_SET, { key, value }),
    status: () => ipcRenderer.invoke(IPC.SECRET_STATUS),
    remove: (key) => ipcRenderer.invoke(IPC.SECRET_DELETE, { key })
  },
  win: {
    setMode: (mode) => ipcRenderer.invoke(IPC.WINDOW_SET_MODE, mode),
    resize: (size) => ipcRenderer.invoke(IPC.WINDOW_RESIZE, size),
    // 拖动窗口：窗口原点由渲染层同步读 window.screenX/screenY，这里只负责写回
    moveTo: (x, y) => ipcRenderer.send(IPC.WINDOW_MOVE, { x, y }),
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    hide: () => ipcRenderer.send(IPC.WINDOW_HIDE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
    openDiary: () => ipcRenderer.invoke(IPC.WINDOW_OPEN_DIARY)
  },
  chat: {
    send: (text) => ipcRenderer.invoke(IPC.CHAT_SEND, { text }),
    abort: () => ipcRenderer.invoke(IPC.CHAT_ABORT),
    confirm: (id, approved) => ipcRenderer.invoke(IPC.TOOL_CONFIRM, { id, approved })
  },
  ha: {
    test: () => ipcRenderer.invoke(IPC.HA_TEST),
    list: () => ipcRenderer.invoke(IPC.HA_LIST)
  },
  pet: {
    poke: () => ipcRenderer.invoke(IPC.PET_POKE)
  },
  mood: {
    get: () => ipcRenderer.invoke(IPC.MOOD_GET)
  },
  diary: {
    list: () => ipcRenderer.invoke(IPC.DIARY_LIST),
    read: (file) => ipcRenderer.invoke(IPC.DIARY_READ, { file })
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.APP_GET_INFO)
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.MODELS_LIST)
  },
  /** 长期记忆（跨会话）与对话历史 */
  memory: {
    list: () => ipcRenderer.invoke(IPC.MEMORY_LIST),
    add: (text) => ipcRenderer.invoke(IPC.MEMORY_ADD, text),
    remove: (payload) => ipcRenderer.invoke(IPC.MEMORY_DELETE, payload),
    clearHistory: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR)
  },
  /** 关系层（S4）：熟悉度 + 情绪时间线 */
  relation: {
    get: () => ipcRenderer.invoke(IPC.RELATION_GET),
    timeline: (opts) => ipcRenderer.invoke(IPC.RELATION_TIMELINE, opts || {})
  },
  /** 日程提醒（M4）：她会记事，到点主动提醒 */
  reminders: {
    list: () => ipcRenderer.invoke(IPC.REMINDER_LIST),
    add: (payload) => ipcRenderer.invoke(IPC.REMINDER_ADD, payload),
    remove: (payload) => ipcRenderer.invoke(IPC.REMINDER_REMOVE, payload),
    done: (id) => ipcRenderer.invoke(IPC.REMINDER_DONE, { id })
  },
  /** 订阅主进程事件；返回取消订阅函数 */
  on: (channel, listener) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error('event not allowed: ' + channel)
    }
    const wrapped = (_e, payload) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('nagi', api)
