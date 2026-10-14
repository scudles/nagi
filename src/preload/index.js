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
