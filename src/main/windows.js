// src/main/windows.js
// 桌宠窗 / 工作台窗的创建、定位与形态切换。
// 两个窗口加载同一 index.html，用 ?mode=pet|workbench 区分布局。

import { BrowserWindow, screen, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MODE, EVT } from '../shared/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env.ELECTRON_RENDERER_URL

let petWindow = null
let workbenchWindow = null
let currentMode = MODE.PET

const rendererPreload = () => join(__dirname, '../preload/index.mjs')

function loadRenderer(win, mode) {
  // 自测钩子：工作台发一条消息验证对话链路；桌宠轮换情绪验证表情映射
  const testKey = process.env.NAGI_SELFTEST ? (mode === MODE.WORKBENCH ? 'selftest' : 'pettest') : null
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
  const w = 320
  const h = 480
  const margin = 12
  return {
    x: Math.round(workArea.x + workArea.width - w - margin),
    y: Math.round(workArea.y + workArea.height - h - margin),
    width: w,
    height: h
  }
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

/** 切换形态：显示目标窗、隐藏另一个 */
export function switchMode(mode) {
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
  broadcast(EVT.SETTINGS_CHANGED, { mode: currentMode })
  return currentMode
}

export function getMode() {
  return currentMode
}

/** 向所有存活窗口广播事件 */
export function broadcast(channel, payload) {
  for (const win of [petWindow, workbenchWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
