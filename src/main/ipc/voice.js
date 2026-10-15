// src/main/ipc/voice.js
// 语音链路 IPC：把 main/voice 的能力暴露给渲染层。
//
// 两个约定：
//   ① 音频一律以 Uint8Array 过 IPC。Electron 的 IPC 用结构化克隆，二进制能原样传，
//      不需要 base64（省掉 33% 体积和一次编解码）。但 Node Buffer 过去会变成
//      Uint8Array 子类，语义含糊 —— 所以这里显式统一成 Uint8Array。
//   ② 合成音频走「按句拉取」而不是一次性返回整段：渲染层拿到第一句就能开播，
//      首响 = 首句合成时间；也天然支持「念到一半被打断」。

import { ipcMain, BrowserWindow } from 'electron'
import { VOICE_IPC, VOICE_EVT } from '../../shared/voice-protocol.js'
import { getVoiceOwner, findWindowByWebContents } from '../windows.js'
import {
  voiceStatus,
  startSpeech,
  pullUtterance,
  dropSpeech,
  synthesizeOnce,
  recognizeAudio,
  downloadSherpa,
  sherpaStatus,
  stopSherpaServer
} from '../voice/index.js'

/** 广播给所有窗口（桌宠窗 + 工作台窗） */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload)
      } catch {
        /* 窗口正在销毁，忽略 */
      }
    }
  }
}

/** 统一把 Buffer / Uint8Array 归一成 Uint8Array（Buffer 是 Uint8Array 子类，但要防止拿到裸 ArrayBuffer） */
function toBytes(v) {
  if (!v) return null
  if (v instanceof Uint8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  return null
}

export function registerVoiceIpc() {
  /* ---------------- 状态 ---------------- */

  ipcMain.handle(VOICE_IPC.STATUS, async () => voiceStatus())

  /* ---------------- 语音输出 ---------------- */

  ipcMain.handle(VOICE_IPC.SPEAK, (e, payload = {}) => {
    // V01 修复：一次回复只允许一个窗口朗读（当前形态所在窗口）。
    // 桌宠窗与工作台窗都订阅 AGENT DONE，没有这道闸门就会各自合成、重叠发声，
    // 隐藏的桌宠窗也会在用户看不见的地方出声。
    const owner = getVoiceOwner()
    const caller = findWindowByWebContents(e.sender)
    if (owner && caller !== owner) return { ok: false, reason: 'not-owner' }
    const r = startSpeech(payload.text, { mood: payload.mood, engine: payload.engine })
    return r
  })

  ipcMain.handle(VOICE_IPC.PULL, async (_e, payload = {}) => {
    const r = await pullUtterance(payload.sessionId, payload.index)
    if (!r.ok || r.done || !r.bytes) return r
    return { ...r, bytes: toBytes(r.bytes) }
  })

  ipcMain.handle(VOICE_IPC.STOP, (_e, sessionId) => ({
    ok: true,
    cleared: dropSpeech(sessionId || undefined)
  }))

  ipcMain.handle(VOICE_IPC.PREVIEW, async (_e, payload = {}) => {
    const r = await synthesizeOnce(payload.text, payload)
    if (!r.ok) return r
    return { ...r, bytes: toBytes(r.bytes) }
  })

  /* ---------------- 语音输入 ---------------- */

  ipcMain.handle(VOICE_IPC.LISTEN, async (_e, payload = {}) => {
    const wav = toBytes(payload.wav)
    if (!wav || !wav.length) return { ok: false, error: '没有收到录音数据' }
    return recognizeAudio(wav, { engine: payload.engine, culture: payload.culture })
  })

  /* ---------------- 离线模型 ---------------- */

  ipcMain.handle(VOICE_IPC.MODEL_STATUS, () => sherpaStatus())

  ipcMain.handle(VOICE_IPC.MODEL_DOWNLOAD, async (_e, payload = {}) => {
    // 下载约 98MB，耗时长：进度通过广播推给设置页，避免 UI 干等
    const cli = await downloadSherpa({
      log: (s) => console.log(s),
      onProgress: (p) => broadcast(VOICE_EVT.PROGRESS, { kind: 'download', ...p })
    })
    broadcast(VOICE_EVT.PROGRESS, { kind: 'download', done: true, ok: cli.ok, error: cli.error || '' })
    return { ...cli, status: sherpaStatus() }
  })

  ipcMain.handle(VOICE_IPC.SERVER_STOP, () => ({ ok: true, stopped: stopSherpaServer() }))
}
