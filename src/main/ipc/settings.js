// src/main/ipc/settings.js
// 设置 / 密钥 / 应用信息 / 窗口控制 / 模型列表 的 IPC 注册。

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, EVT, SECRET_KEYS, MODE } from '../../shared/protocol.js'
import { getSettings, saveSettings, settingsPath } from '../settings-store.js'
import { setSecret, hasSecret, deleteSecret } from '../keystore.js'
import { broadcast, switchMode, getMode, getPetWindow, getWorkbenchWindow, openDiaryWindow, resizePetWindow, movePetWindow } from '../windows.js'
import { memoryList, memoryAdd, memoryRemove, historyClear } from '../agent.js'
import { modelsDir, projectRoot } from '../paths.js'

const ALL_SECRET_KEYS = Object.values(SECRET_KEYS)

/** 递归扫描 models/ 下的 *.model3.json */
function listModels() {
  const out = []
  if (!existsSync(modelsDir)) return out
  const walk = (dir, depth = 0) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (name.toLowerCase().endsWith('.model3.json')) {
        out.push(full.slice(modelsDir.length + 1).replace(/\\/g, '/'))
      }
    }
  }
  walk(modelsDir)
  return out
}

export function registerSettingsIpc() {
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())

  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch) => {
    const next = saveSettings(patch || {})
    broadcast(EVT.SETTINGS_CHANGED, next)
    if (patch && (patch.mode === MODE.PET || patch.mode === MODE.WORKBENCH)) {
      switchMode(patch.mode)
    }
    return next
  })

  ipcMain.handle(IPC.SECRET_SET, (_e, { key, value }) => {
    if (!ALL_SECRET_KEYS.includes(key)) return { ok: false, error: 'unknown key' }
    return setSecret(key, value)
  })

  ipcMain.handle(IPC.SECRET_STATUS, () => {
    const out = {}
    for (const k of ALL_SECRET_KEYS) out[k] = hasSecret(k)
    return out
  })

  ipcMain.handle(IPC.SECRET_DELETE, (_e, { key }) => {
    if (!ALL_SECRET_KEYS.includes(key)) return { ok: false, error: 'unknown key' }
    return deleteSecret(key)
  })

  ipcMain.handle(IPC.APP_GET_INFO, () => ({
    version: app.getVersion(),
    name: app.getName(),
    mode: getMode(),
    projectRoot,
    modelsDir,
    settingsPath: settingsPath(),
    userData: app.getPath('userData')
  }))

  ipcMain.handle(IPC.MODELS_LIST, () => ({ dir: modelsDir, models: listModels() }))

  // 桌宠尺寸（右下角手柄 / Ctrl+滚轮 / 设置页滑杆都走这里）
  ipcMain.handle(IPC.WINDOW_RESIZE, (_e, size) => resizePetWindow(size || {}))

  // 桌宠拖动（渲染层原生 pointer 事件驱动窗口移动）
  ipcMain.on(IPC.WINDOW_MOVE, (_e, { x, y } = {}) => movePetWindow(x, y))

  // 长期记忆 / 对话历史
  ipcMain.handle(IPC.MEMORY_LIST, () => memoryList())
  ipcMain.handle(IPC.MEMORY_ADD, (_e, text) => memoryAdd(text))
  ipcMain.handle(IPC.MEMORY_DELETE, (_e, payload) => memoryRemove(payload || {}))
  ipcMain.handle(IPC.HISTORY_CLEAR, () => historyClear())

  ipcMain.handle(IPC.WINDOW_SET_MODE, (_e, mode) => switchMode(mode))

  ipcMain.handle(IPC.WINDOW_OPEN_DIARY, () => {
    openDiaryWindow()
    return { ok: true }
  })

  ipcMain.on(IPC.WINDOW_MINIMIZE, (e) => {
    const win = requireWin(e)
    if (win) win.minimize()
  })
  ipcMain.on(IPC.WINDOW_HIDE, (e) => {
    const win = requireWin(e)
    if (win) win.hide()
  })
  ipcMain.on(IPC.WINDOW_CLOSE, (e) => {
    const win = requireWin(e)
    if (win) {
      // 桌宠窗关掉 = 隐藏；工作台窗关掉 = 回到桌宠
      if (win === getPetWindow()) {
        win.hide()
      } else if (win === getWorkbenchWindow()) {
        switchMode(MODE.PET)
      } else {
        win.close()
      }
    }
  })

  // 供以后选目录用
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
}

function requireWin(e) {
  return BrowserWindow.fromWebContents(e.sender)
}
