// src/main/index.js
// 主进程入口：初始化、建窗口、注册协议与 IPC。

import { app, BrowserWindow } from 'electron'
import { registerScheme, registerHandler } from './local-protocol.js'
import { modelsDir } from './paths.js'
import { createPetWindow, createWorkbenchWindow, switchMode, getMode, getPetWindow, openDiaryWindow } from './windows.js'
import { createTray } from './tray.js'
import { registerSettingsIpc } from './ipc/settings.js'
import { registerChatIpc } from './ipc/chat.js'
import { registerHomeAssistantIpc } from './ipc/homeassistant.js'
import { registerPetIpc } from './ipc/pet.js'
import { loadSettings, saveSettings } from './settings-store.js'
import { disposeAgent, startMoodEngine, startActivityMonitor } from './agent.js'
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
app.commandLine.appendSwitch('no-sandbox')

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

    // 情绪引擎：心跳 + 独白日史（双窗广播，退出时随 disposeAgent 停止）
    startMoodEngine()

    // 活动监测：看你在用什么程序，适时主动开口（M3，受 settings.privacy 控制）
    startActivityMonitor()

    // 窗口（NAGI_MODE=workbench 可覆盖初始形态，便于无头验证）
    const settings = loadSettings()
    // 迁移：M3 之前 settings.json 里 privacy.monitorEnabled 的旧默认是 false。
    // 只要用户还没走过「首次告知」流程，就按新默认（开）初始化，最终由告知弹窗决定去留。
    if (!settings.privacy?.noticeShown && settings.privacy?.monitorEnabled === false) {
      saveSettings({ privacy: { monitorEnabled: true } })
    }
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
    if (!disposeAgent.__done) {
      disposeAgent.__done = true
      e.preventDefault()
      disposeAgent().finally(() => app.quit())
    }
  })
}
