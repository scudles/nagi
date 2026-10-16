// src/main/index.js
// 主进程入口：初始化、建窗口、注册协议与 IPC。

import { app, BrowserWindow } from 'electron'
import { registerScheme, registerHandler } from './local-protocol.js'
import { modelsDir } from './paths.js'
import { createPetWindow, createWorkbenchWindow, switchMode, getMode, getPetWindow, openDiaryWindow, rendererSandbox } from './windows.js'
import { createTray } from './tray.js'
import { registerSettingsIpc } from './ipc/settings.js'
import { registerChatIpc } from './ipc/chat.js'
import { registerHomeAssistantIpc } from './ipc/homeassistant.js'
import { registerPetIpc } from './ipc/pet.js'
import { registerRelationIpc } from './ipc/relation.js'
import { registerReminderIpc } from './ipc/reminders.js'
import { registerVoiceIpc } from './ipc/voice.js'
import { registerRagIpc } from './ipc/rag.js'
import { registerLedgerIpc } from './ipc/ledger.js'
import { registerYearbookIpc } from './ipc/yearbook.js'
import { registerCompanionIpc } from './ipc/companion.js'
import { registerCalendarIpc } from './ipc/calendar.js'
import { registerMusicIpc } from './ipc/music.js'
import { startMusicMonitor, stopMusicMonitor } from './signals/music.js'
import { refreshHaSignals } from './signals/ha.js'
import { initRag } from './rag/index.js'
import { migrateLegacyLedger } from './ledger.js'
import { loadSettings, saveSettings } from './settings-store.js'
import { disposeAgent, startMoodEngine, startActivityMonitor, startReminders, restoreState } from './agent.js'
import { prewarmVoice, disposeVoice } from './voice/index.js'
import { MODE } from '../shared/protocol.js'

// ---- 运行环境开关 ----
// 某些受限/虚拟化环境里 GPU 进程会崩溃（0xC0000005）。默认强制软件渲染（SwiftShader）保证可跑；
// 需要真硬件加速时设 NAGI_SOFTWARE_GL=0 启动。
const softwareGl = process.env.NAGI_SOFTWARE_GL !== '0'
if (softwareGl) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('use-gl', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
if (!rendererSandbox) app.commandLine.appendSwitch('no-sandbox')

// 必须在 app ready 之前注册特权协议
registerScheme()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMode() === MODE.WORKBENCH ? BrowserWindow.getAllWindows()[0] : getPetWindow()
    if (win) win.show()
  })

  app.whenReady().then(() => {
    // 协议处理器
    registerHandler(modelsDir)

    // IPC
    registerSettingsIpc()
    registerChatIpc()
    registerHomeAssistantIpc()
    registerPetIpc()
    registerRelationIpc()
    registerReminderIpc()
    registerVoiceIpc()
    registerRagIpc()
    registerLedgerIpc()
    registerYearbookIpc()
    registerCompanionIpc()
    registerCalendarIpc()
    registerMusicIpc()

    // 读取设置 + 迁移：M3 之前 settings.json 里 privacy.monitorEnabled 的旧默认是 false。
    // 只要用户还没走过「首次告知」流程，就按新默认（开）初始化，最终由告知弹窗决定去留。
    // 必须在 startActivityMonitor 之前执行，否则首次升级那一次会话会读到旧值而不采集。
    const settings = loadSettings()
    if (!settings.privacy?.noticeShown && settings.privacy?.monitorEnabled === false) {
      saveSettings({ privacy: { monitorEnabled: true } })
    }

    // 旧数据只建立来源索引，不把模型推测升级为事实，也不把旧日记重新灌入 RAG。
    try {
      const migration = migrateLegacyLedger()
      if (migration.migrated) console.log(`[ledger] 旧数据已建索引：${migration.count} 条`)
    } catch (err) {
      console.warn('[ledger] 迁移待下次重试：', err?.message)
    }

    // 恢复上次的情绪（按离线时长自然衰减）与关系统计，并清理过期时间线
    restoreState()

    // 长期记忆档案（RAG）：载库 + 8 秒后后台预热嵌入模型、补齐待嵌队列。
    // 模型没装时这里只是静默不就绪，对话行为一帧不变。
    initRag()

    // 情绪引擎：心跳 + 独白日史（双窗广播，退出时随 disposeAgent 停止）
    startMoodEngine()

    // 活动监测：看你在用什么程序，适时主动开口（M3，受 settings.privacy 控制）
    startActivityMonitor()
    startMusicMonitor()
    refreshHaSignals()

    // 日程提醒：她替你记着的事，到点主动开口（M4）
    startReminders()

    // 窗口（NAGI_MODE=workbench 可覆盖初始形态，便于无头验证）
    const envMode = process.env.NAGI_MODE === MODE.WORKBENCH ? MODE.WORKBENCH : null
    createPetWindow()
    createWorkbenchWindow()
    switchMode(envMode || (settings.mode === MODE.WORKBENCH ? MODE.WORKBENCH : MODE.PET))

    // 托盘
    createTray()

    // 无头自测：额外拉起日记查看器，验证日记读取链路
    if (process.env.NAGI_SELFTEST && process.env.NAGI_SELFTEST_DIARY === '1') {
      setTimeout(() => openDiaryWindow(), 1200)
    }

    // 语音预热：离线识别服务要 4.3–4.8s 加载模型，等服务就绪后才开始，
    // 把这段等待从「用户按住说话的那一刻」挪到「应用刚起来、用户还没开口」的时候。
    // 没装离线模型 / 用户选了别的识别引擎时它会立刻返回，不做无谓的事。
    prewarmVoice({}).then((r) => {
      if (r.prewarmed) console.log('[voice] 离线识别已预热')
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })

  // 托盘常驻：关掉窗口不退出应用
  app.on('window-all-closed', () => {
    // no-op：交给托盘菜单里的"退出"来控制
  })

  // 退出前清理（浏览器连接 / HA 事件订阅）
  app.on('will-quit', (e) => {
    stopMusicMonitor()
    if (!disposeAgent.__done) {
      disposeAgent.__done = true
      e.preventDefault()
      disposeAgent().finally(() => app.quit())
    }
  })
}
