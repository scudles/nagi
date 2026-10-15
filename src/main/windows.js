// src/main/windows.js
// 桌宠窗 / 工作台窗的创建、定位与形态切换。
// 两个窗口加载同一 index.html，用 ?mode=pet|workbench 区分布局。

import { BrowserWindow, screen, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MODE, EVT, DEFAULT_SETTINGS } from '../shared/protocol.js'
import { VOICE_EVT } from '../shared/voice-protocol.js'
import { pickVoiceOwner } from '../core/voice/owner.js'
import { getSettings, saveSettings } from './settings-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env.ELECTRON_RENDERER_URL

let petWindow = null
let workbenchWindow = null
let diaryWindow = null
let currentMode = MODE.PET

const rendererPreload = () => join(__dirname, '../preload/index.mjs')

function loadRenderer(win, mode) {
  // 自测钩子：工作台发一条消息验证对话链路；桌宠轮换情绪验证表情映射；日记窗验证日记渲染
  const selftestKey =
    mode === MODE.WORKBENCH ? 'selftest' : mode === 'diary' ? 'selftest' : 'pettest'
  const testKey = process.env.NAGI_SELFTEST ? selftestKey : null
  // NAGI_SELFTEST_MSG 可覆盖自测消息内容（验证特定链路用，如触发工具调用）
  const testMsg = process.env.NAGI_SELFTEST_MSG || ''
  // 把渲染层 console 转发到主进程 stdout，便于无头排查（两个窗都转发）
  if (process.env.NAGI_SELFTEST) {
    win.webContents.on('console-message', (...args) => {
      const msg = typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2] }
      console.log(`[renderer:${mode}]`, msg.message ?? msg)
    })
  }
  if (isDev) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?mode=${mode}${testKey ? `&${testKey}=1` : ''}${testMsg ? `&testmsg=${encodeURIComponent(testMsg)}` : ''}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { mode, ...(testKey ? { [testKey]: '1' } : {}), ...(testMsg ? { testmsg: testMsg } : {}) }
    })
  }
}

function petBounds() {
  const { workArea } = screen.getPrimaryDisplay()
  const cfg = getSettings()?.live2d || {}
  const w = clampPetSize(cfg.petWidth, DEFAULT_SETTINGS.live2d.petWidth, PET_MIN.w, PET_MAX.w)
  const h = clampPetSize(cfg.petHeight, DEFAULT_SETTINGS.live2d.petHeight, PET_MIN.h, PET_MAX.h)
  const margin = 12
  return {
    x: Math.round(workArea.x + workArea.width - w - margin),
    y: Math.round(workArea.y + workArea.height - h - margin),
    width: w,
    height: h
  }
}

/* ---------------- 桌宠尺寸（用户可自由调节） ---------------- */
export const PET_MIN = { w: 200, h: 300 }
export const PET_MAX = { w: 900, h: 1300 }

function clampPetSize(v, fallback, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.round(Math.min(max, Math.max(min, n)))
}

/**
 * 调整桌宠窗口尺寸。锚定右下角（桌宠通常蹲在屏幕右下，缩放时不应位移）。
 * 同时把尺寸写回 settings.live2d，重启后保持一致。
 * @param {{width?:number,height?:number,persist?:boolean}} size
 */
export function resizePetWindow(size = {}) {
  const cfg = getSettings()?.live2d || {}
  const win = petWindow && !petWindow.isDestroyed() ? petWindow : null
  const cur = win ? win.getBounds() : null
  const w = clampPetSize(size.width ?? cur?.width, cfg.petWidth || DEFAULT_SETTINGS.live2d.petWidth, PET_MIN.w, PET_MAX.w)
  const h = clampPetSize(size.height ?? cur?.height, cfg.petHeight || DEFAULT_SETTINGS.live2d.petHeight, PET_MIN.h, PET_MAX.h)
  if (win) {
    const right = cur.x + cur.width
    const bottom = cur.y + cur.height
    win.setBounds({ x: Math.round(right - w), y: Math.round(bottom - h), width: w, height: h })
  }
  if (size.persist !== false) {
    try {
      saveSettings({ live2d: { petWidth: w, petHeight: h } })
    } catch {
      /* 设置写失败不影响本次缩放 */
    }
  }
  return { width: w, height: h }
}

/* ---------------- 桌宠拖动（渲染层原生 pointer 事件驱动） ---------------- */

/** 移动桌宠窗到指定坐标（DIP） */
export function movePetWindow(x, y) {
  const win = getPetWindow()
  if (!win) return null
  const nx = Math.round(Number(x))
  const ny = Math.round(Number(y))
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
  win.setPosition(nx, ny, false)
  return { x: nx, y: ny }
}

export function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow
  petWindow = new BrowserWindow({
    ...petBounds(),
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(petWindow, MODE.PET)
  petWindow.once('ready-to-show', () => {
    if (currentMode === MODE.PET) petWindow.showInactive()
  })
  petWindow.on('closed', () => {
    petWindow = null
  })
  // 站外链接用系统浏览器打开
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return petWindow
}

export function createWorkbenchWindow() {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) return workbenchWindow
  workbenchWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  loadRenderer(workbenchWindow, MODE.WORKBENCH)
  workbenchWindow.once('ready-to-show', () => {
    if (currentMode === MODE.WORKBENCH) workbenchWindow.show()
  })
  workbenchWindow.on('closed', () => {
    workbenchWindow = null
  })
  workbenchWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return workbenchWindow
}

export function getPetWindow() {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null
}
export function getWorkbenchWindow() {
  return workbenchWindow && !workbenchWindow.isDestroyed() ? workbenchWindow : null
}

/**
 * 语音播放归属者（V01 修复）：当前形态所在窗口，且唯一。
 * 主进程侧权威判定，ipc/voice.js 据此放行/拒绝 speak 请求——
 * 双窗都订阅了 AGENT DONE，没有这道闸门就会各自合成、重叠发声。
 */
export function getVoiceOwner() {
  const which = pickVoiceOwner(currentMode, {
    pet: !!(petWindow && !petWindow.isDestroyed()),
    workbench: !!(workbenchWindow && !workbenchWindow.isDestroyed())
  })
  if (which === 'workbench') return getWorkbenchWindow()
  if (which === 'pet') return getPetWindow()
  return null
}

/** 按 webContents 反查窗口（IPC 层判定调用方身份用；找不到返回 null） */
export function findWindowByWebContents(wc) {
  for (const win of [petWindow, workbenchWindow, diaryWindow]) {
    if (win && !win.isDestroyed() && win.webContents === wc) return win
  }
  return null
}

/* ---------------- 内心独白日史查看器（D2：按需打开的独立小窗） ---------------- */
export function createDiaryWindow() {
  if (diaryWindow && !diaryWindow.isDestroyed()) return diaryWindow
  diaryWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 380,
    minHeight: 420,
    frame: false,
    show: false,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: rendererPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  loadRenderer(diaryWindow, 'diary')
  diaryWindow.once('ready-to-show', () => diaryWindow.show())
  diaryWindow.on('closed', () => {
    diaryWindow = null
  })
  diaryWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return diaryWindow
}

/** 打开（或聚拢）日记查看器 */
export function openDiaryWindow() {
  const win = createDiaryWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/** 切换形态：显示目标窗、隐藏另一个 */
export function switchMode(mode) {
  const prevMode = currentMode
  currentMode = mode === MODE.WORKBENCH ? MODE.WORKBENCH : MODE.PET
  if (currentMode === MODE.WORKBENCH) {
    createWorkbenchWindow()
    workbenchWindow.show()
    workbenchWindow.focus()
    if (petWindow && !petWindow.isDestroyed()) petWindow.hide()
  } else {
    createPetWindow()
    petWindow.showInactive()
    if (workbenchWindow && !workbenchWindow.isDestroyed()) workbenchWindow.hide()
  }
  if (prevMode !== currentMode) {
    // V01：形态切换后，让失去归属的旧窗停止朗读——隐藏的窗不该继续发声，
    // 否则它的残留音频会和新归属者的朗读重叠
    const stale = prevMode === MODE.WORKBENCH ? workbenchWindow : petWindow
    if (stale && !stale.isDestroyed()) {
      try {
        stale.webContents.send(VOICE_EVT.OWNER_LOST)
      } catch {
        /* 窗口正在销毁，忽略 */
      }
    }
  }
  broadcast(EVT.SETTINGS_CHANGED, { mode: currentMode })
  return currentMode
}

export function getMode() {
  return currentMode
}

/** 向所有存活窗口广播事件（frame 已销毁/正在导航时静默跳过，避免定时器抛错） */
export function broadcast(channel, payload) {
  for (const win of [petWindow, workbenchWindow, diaryWindow]) {
    if (!win || win.isDestroyed()) continue
    const wc = win.webContents
    if (!wc || wc.isDestroyed() || wc.isCrashed()) continue
    try {
      wc.send(channel, payload)
    } catch {
      /* 渲染帧已销毁（导航/崩溃竞态）：丢弃这一帧即可，不影响主进程 */
    }
  }
}
