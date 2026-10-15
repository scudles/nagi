// src/preload/index.js
// 通过 contextBridge 暴露最小、安全的 API 给渲染层。
// 原则：渲染层拿不到 Node / Electron 原始对象，也拿不到任何密钥明文。

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, EVT } from '../shared/protocol.js'
import { VOICE_IPC, VOICE_EVT } from '../shared/voice-protocol.js'
import { RAG_IPC, RAG_EVT } from '../shared/rag-protocol.js'

const ALLOWED_EVENTS = new Set([
  EVT.AGENT,
  EVT.SETTINGS_CHANGED,
  EVT.HA_EVENT,
  EVT.MOOD,
  EVT.PET,
  VOICE_EVT.PROGRESS,
  VOICE_EVT.NOTICE,
  VOICE_EVT.OWNER_LOST,
  RAG_EVT.PROGRESS
])

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
  /** 语音链路（M5）：她既能开口，也能听见 */
  voice: {
    /** 能力快照：各引擎可用性 + 本机语音清单 + 离线模型状态 */
    status: () => ipcRenderer.invoke(VOICE_IPC.STATUS),
    /** 开一次朗读会话 → 返回 { sessionId, total, engine, sentences } */
    speak: (payload) => ipcRenderer.invoke(VOICE_IPC.SPEAK, payload || {}),
    /** 取第 index 句的音频（按句取用，首响 = 首句合成时间） */
    pull: (sessionId, index) => ipcRenderer.invoke(VOICE_IPC.PULL, { sessionId, index }),
    /** 打断：丢弃这个朗读会话（不传则全部丢弃） */
    stop: (sessionId) => ipcRenderer.invoke(VOICE_IPC.STOP, sessionId),
    /** 试听（设置页用，不切句、可临时指定音色/语速） */
    preview: (payload) => ipcRenderer.invoke(VOICE_IPC.PREVIEW, payload || {}),
    /** 把录好的 WAV（16-bit PCM）送去识别 → { text, engine } */
    listen: (payload) => ipcRenderer.invoke(VOICE_IPC.LISTEN, payload || {}),
    /** 离线识别安装状态 */
    modelStatus: () => ipcRenderer.invoke(VOICE_IPC.MODEL_STATUS),
    /** 下载离线识别程序 + 模型（约 98MB，进度走 VOICE_EVT.PROGRESS） */
    downloadModel: () => ipcRenderer.invoke(VOICE_IPC.MODEL_DOWNLOAD),
    /** 停掉常驻的离线识别服务，把内存还回去 */
    stopServer: () => ipcRenderer.invoke(VOICE_IPC.SERVER_STOP)
  },
  /** 长期记忆档案（RAG）：无限容量的语义检索记忆 */
  rag: {
    /** 状态快照：开关/引擎/条数/待嵌/磁盘占用/本地模型 */
    status: () => ipcRenderer.invoke(RAG_IPC.STATUS),
    /** 召回自测：输入一句话，看她能从档案里想起什么 */
    recallTest: (query) => ipcRenderer.invoke(RAG_IPC.RECALL_TEST, { query }),
    /** 重建索引（换引擎或索引损坏后；文本全保留，重新嵌入） */
    rebuild: () => ipcRenderer.invoke(RAG_IPC.REBUILD),
    /** 清空档案 */
    clear: () => ipcRenderer.invoke(RAG_IPC.CLEAR),
    /** 本地嵌入模型安装状态 */
    modelStatus: () => ipcRenderer.invoke(RAG_IPC.MODEL_STATUS),
    /** 下载本地嵌入模型（约 25MB，进度走 RAG_EVT.PROGRESS） */
    downloadModel: () => ipcRenderer.invoke(RAG_IPC.MODEL_DOWNLOAD)
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
