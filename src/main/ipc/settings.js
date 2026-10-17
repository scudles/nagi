// src/main/ipc/settings.js
// 设置 / 密钥 / 应用信息 / 窗口控制 / 模型列表 的 IPC 注册。

import { app, dialog, BrowserWindow } from 'electron'
import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, EVT, SECRET_KEYS, MODE } from '../../shared/protocol.js'
import { trustedHandle, trustedOn } from './trusted.js'
import { LLM_IPC } from '../../shared/llm-protocol.js'
import { checkOllama } from '../../core/llm/ollama.js'
import { getSettings, saveSettings, settingsPath } from '../settings-store.js'
import { setSecret, hasSecret, deleteSecret } from '../keystore.js'
import { broadcast, switchMode, getMode, getPetWindow, getWorkbenchWindow, openDiaryWindow, resizePetWindow, movePetWindow } from '../windows.js'
import { memoryList, memoryAdd, historyClear, abortChat } from '../agent.js'
import { getLedger } from '../ledger.js'
import { forgetExperience } from '../ledger-actions.js'
import { modelsDir, projectRoot } from '../paths.js'
import { refreshMonitorPrivacy } from '../monitor/index.js'
import { refreshHaSignals } from '../signals/ha.js'
import { refreshPresence } from '../presence.js'
import { syncAmbientHost } from '../ambient-host.js'

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
  trustedHandle(IPC.SETTINGS_GET, () => getSettings())
  trustedHandle(LLM_IPC.LOCAL_STATUS, (_e, payload) => checkOllama(payload || {}))

  trustedHandle(IPC.SETTINGS_SET, (_e, patch) => {
    if (patch?.tools && Object.hasOwn(patch.tools, 'fileRoot') &&
        String(patch.tools.fileRoot || '') !== String(getSettings().tools?.fileRoot || '')) {
      throw new Error('文件授权目录只能通过系统选择窗口修改')
    }
    const next = saveSettings(patch || {})
    // 待机行为：热键的开关要立刻生效（不然用户关了热键发现还能按，以为坏了）
    if (patch?.ambient) syncAmbientHost(next)
    if (patch?.presence || patch?.privacy) refreshPresence()
    if (patch?.privacy) refreshMonitorPrivacy()
    if (patch?.privacy || patch?.homeassistant) refreshHaSignals()
    broadcast(EVT.SETTINGS_CHANGED, next)
    if (patch && (patch.mode === MODE.PET || patch.mode === MODE.WORKBENCH)) {
      switchMode(patch.mode)
    }
    return next
  })

  trustedHandle(IPC.SECRET_SET, (_e, { key, value }) => {
    if (!ALL_SECRET_KEYS.includes(key)) return { ok: false, error: 'unknown key' }
    const result = setSecret(key, value)
    if (key === SECRET_KEYS.HA_TOKEN) refreshHaSignals()
    return result
  })

  trustedHandle(IPC.SECRET_STATUS, () => {
    const out = {}
    for (const k of ALL_SECRET_KEYS) out[k] = hasSecret(k)
    return out
  })

  trustedHandle(IPC.SECRET_DELETE, (_e, { key }) => {
    if (!ALL_SECRET_KEYS.includes(key)) return { ok: false, error: 'unknown key' }
    const result = deleteSecret(key)
    if (key === SECRET_KEYS.HA_TOKEN) refreshHaSignals()
    return result
  })

  trustedHandle(IPC.APP_GET_INFO, () => ({
    version: app.getVersion(),
    name: app.getName(),
    mode: getMode(),
    projectRoot,
    modelsDir,
    settingsPath: settingsPath(),
    userData: app.getPath('userData')
  }))

  trustedHandle(IPC.MODELS_LIST, () => ({ dir: modelsDir, models: listModels() }))

  // 桌宠尺寸（右下角手柄 / Ctrl+滚轮 / 设置页滑杆都走这里）
  trustedHandle(IPC.WINDOW_RESIZE, (_e, size) => resizePetWindow(size || {}))

  // 桌宠拖动（渲染层原生 pointer 事件驱动窗口移动）
  trustedOn(IPC.WINDOW_MOVE, (_e, { x, y } = {}) => movePetWindow(x, y))

  // 长期记忆 / 对话历史
  trustedHandle(IPC.MEMORY_LIST, () => memoryList())
  trustedHandle(IPC.MEMORY_ADD, (_e, text) => memoryAdd(text))
  trustedHandle(IPC.MEMORY_DELETE, async (event, payload = {}) => {
    const item = memoryList().find((memory) => payload.id ? memory.id === payload.id : memory.text === payload.text)
    if (!item) return memoryList()
    const entry = getLedger().list().find((row) =>
      ['memory', 'memory-manual', 'memory-model', 'correction'].includes(row.source.type) &&
      (row.source.ref === item.id || row.text === item.text))
    if (!entry) throw new Error('这条记忆缺少来源，不能确认已从检索中清除')
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'warning', title: '忘记这条记忆',
      message: '让凪忘记这条记忆？', detail: '会同时清除提示词、待嵌队列和已嵌入检索内容。',
      buttons: ['取消', '忘记'], defaultId: 0, cancelId: 0, noLink: true }
    const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (answer.response !== 1) return memoryList()
    const result = forgetExperience(entry.id)
    if (!result.ok) throw new Error(result.error)
    return memoryList()
  })
  trustedHandle(IPC.HISTORY_CLEAR, () => historyClear())

  trustedHandle(IPC.WINDOW_SET_MODE, (_e, mode) => switchMode(mode))

  trustedHandle(IPC.WINDOW_OPEN_DIARY, () => {
    openDiaryWindow()
    return { ok: true }
  })

  trustedOn(IPC.WINDOW_MINIMIZE, (e) => {
    const win = requireWin(e)
    if (win) win.minimize()
  })
  trustedOn(IPC.WINDOW_HIDE, (e) => {
    const win = requireWin(e)
    if (win) win.hide()
  })
  trustedOn(IPC.WINDOW_CLOSE, (e) => {
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

  trustedHandle(IPC.TOOLS_PICK_ROOT, async (event) => {
    const owner = requireWin(event)
    const r = await dialog.showOpenDialog(owner, {
      title: '选择凪可读取和写入的文件目录',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    const root = realpathSync(r.filePaths[0])
    if (!statSync(root).isDirectory()) return { ok: false, error: '请选择目录' }
    abortChat() // 新授权不能复用旧回合的待确认操作。
    const next = saveSettings({ tools: { fileRoot: root } })
    broadcast(EVT.SETTINGS_CHANGED, next)
    return { ok: true, fileRoot: root }
  })

  trustedHandle(IPC.TOOLS_REVOKE_ROOT, () => {
    abortChat() // 撤销立即终止待确认及尚未开始的工具调用。
    const next = saveSettings({ tools: { fileRoot: '' } })
    broadcast(EVT.SETTINGS_CHANGED, next)
    return { ok: true }
  })
}

function requireWin(e) {
  return BrowserWindow.fromWebContents(e.sender)
}
