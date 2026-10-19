// src/main/index.js
// 主进程入口：初始化、建窗口、注册协议与 IPC。

import { app, BrowserWindow, powerMonitor } from 'electron'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerScheme, registerHandler } from './local-protocol.js'
import { modelsDir } from './paths.js'
import { createPetWindow, createWorkbenchWindow, switchMode, getMode, getPetWindow, getWorkbenchWindow, openDiaryWindow, rendererSandbox, broadcast } from './windows.js'
import { createTray } from './tray.js'
import { startGaze, stopGaze } from './gaze.js'
import { unregisterShortcuts } from './shortcuts.js'
import { syncAmbientHost } from './ambient-host.js'
import { registerOutfitIpc } from './ipc/outfit.js'
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
import { registerExportIpc } from './ipc/export.js'
import { registerCompanionIpc } from './ipc/companion.js'
import { registerCalendarIpc } from './ipc/calendar.js'
import { registerMusicIpc } from './ipc/music.js'
import { startMusicMonitor, stopMusicMonitor } from './signals/music.js'
import { registerGeoIpc } from './ipc/geo.js'
import { startGeoMonitor, stopGeoMonitor } from './signals/geo.js'
import { refreshHaSignals } from './signals/ha.js'
import { initRag } from './rag/index.js'
import { migrateLegacyLedger } from './ledger.js'
import { consumePersistWarnings } from './persist.js'
import { loadSettings, saveSettings } from './settings-store.js'
import { disposeAgent, startMoodEngine, startActivityMonitor, startReactionEngine, startReminders, restoreState } from './agent.js'
import { prewarmVoice, disposeVoice } from './voice/index.js'
import { EVT, MODE } from '../shared/protocol.js'
import { registerPresenceIpc } from './ipc/presence.js'
import { registerNotesIpc } from './ipc/notes.js'
import { registerMaintenanceIpc } from './ipc/maintenance.js'
import { registerRendererHealthIpc } from './ipc/renderer-health.js'
import { presenceInput } from './presence.js'
import { installPresenceExtensions } from './presence-extensions.js'
import { runPresenceSelftest } from './presence-selftest.js'

// ---- 运行环境开关 ----
// 某些受限/虚拟化环境里 GPU 进程会崩溃（0xC0000005）。默认强制软件渲染（SwiftShader）保证可跑；
// 需要真硬件加速时设 NAGI_SOFTWARE_GL=0 启动。
const softwareGl = process.env.NAGI_SOFTWARE_GL !== '0'
let stopPresenceBindings = () => {}
if (softwareGl) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('use-gl', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
if (!rendererSandbox) app.commandLine.appendSwitch('no-sandbox')

/**
 * 启动标记（排障用）：把「本实例加载的是哪个构建」落盘到 userData/boot.json。
 *
 * 起因（2026-10-17）：改了主进程代码、`npm run build` 也重新构建了，但应用没有退出重启——
 * 跑着的还是旧 main 进程（模块已在内存里），而 `requestSingleInstanceLock()` 让「再点一次启动」
 * 只会唤起旧窗口。表现就是「修复完全无效」，且从外部极难判断。有了这个标记，
 * 对照 out/main/index.js 的修改时间就能一眼确认实例是不是陈旧的。
 */
function writeBootStamp() {
  try {
    let build = null
    try { build = statSync(join(app.getAppPath(), 'out', 'main', 'index.js')).mtimeMs } catch{ /* B8:degrade — 打包态路径不同属预期 */ }
    const stamp = { version: app.getVersion(), pid: process.pid, startedAt: Date.now(), packaged: app.isPackaged, build }
    writeFileSync(join(app.getPath('userData'), 'boot.json'), JSON.stringify(stamp), 'utf8')
    console.log('[boot] 实例已启动 pid=' + stamp.pid + ' 构建时间=' + (build ? new Date(build).toLocaleString('zh-CN') : '未知（打包态）'))
  } catch (err) {
    console.warn('[boot] 启动标记写入失败：', err?.message)
  }
}

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
    // 启动标记：先落盘，后面任何一步出问题都还能判断跑的是哪个构建
    writeBootStamp()

    // B01：上次退出时有文件没写成功的话，如实说出来（一次一提示，读完即清）。
    // 沉默的写失败比写失败本身更糟——用户会以为"她已经记住了"。
    for (const ev of consumePersistWarnings()) {
      console.error('[persist] 上次退出时写入未完全成功', JSON.stringify(ev.failed))
    }

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
    registerExportIpc()
    registerCompanionIpc()
    registerCalendarIpc()
    registerMusicIpc()
    registerGeoIpc()
    registerPresenceIpc()
    registerNotesIpc()
    registerMaintenanceIpc()
    registerRendererHealthIpc()
    registerOutfitIpc()

    // 读取设置 + 迁移：M3 之前 settings.json 里 privacy.monitorEnabled 的旧默认是 false。
    // 只要用户还没走过「首次告知」流程，就按新默认（开）初始化，最终由告知弹窗决定去留。
    // 必须在 startActivityMonitor 之前执行，否则首次升级那一次会话会读到旧值而不采集。
    // G3：这一步落盘失败**不静默也不崩启动**——settings-store 已单点按 MUST_PERSIST 上报；
    // 这里兜住是因为这个分支幂等（下次启动 noticeShown 仍为 false，会自然再试一次），
    // 为一次写盘失败让整个应用起不来是不成比例的。
    const settings = loadSettings()
    if (!settings.privacy?.noticeShown && settings.privacy?.monitorEnabled === false) {
      try {
        saveSettings({ privacy: { monitorEnabled: true } })
      } catch (err) {
        /* B8:must-persist — 已由 settings.saveSettings 上报；此处不崩启动是因为
           这个分支幂等（noticeShown 仍为 false，下次启动自然再试），
           为一次写盘失败让整个应用起不来是不成比例的。 */
        console.warn('[boot] 监测默认值初始化未落盘（下次启动重试）：', err.message)
      }
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
    const stopExtensions = installPresenceExtensions()
    const powerEvents = [['lock-screen','lock'],['unlock-screen','unlock'],['suspend','suspend'],['resume','resume']]
      .map(([name,kind])=>[name,()=>presenceInput({kind})])
    for (const [name,fn] of powerEvents) powerMonitor.on(name,fn)
    const focused = (_event,win) => {
      if (win===getPetWindow() || win===getWorkbenchWindow()) presenceInput({kind:'focus'})
    }
    app.on('browser-window-focus',focused)
    stopPresenceBindings = () => {
      stopExtensions()
      for (const [name,fn] of powerEvents) powerMonitor.removeListener(name,fn)
      app.removeListener('browser-window-focus',focused)
    }

    // 长期记忆档案（RAG）：载库 + 8 秒后后台预热嵌入模型、补齐待嵌队列。
    // 模型没装时这里只是静默不就绪，对话行为一帧不变。
    initRag()

    // 情绪引擎：心跳 + 独白日史（双窗广播，退出时随 disposeAgent 停止）
    startMoodEngine()

    // 「她想一下再表现」：在监测与规则之间插一次常识推理（只喂活动分类，24 小时后自动静默）
    startReactionEngine()

    // 活动监测：看你在用什么程序，适时主动开口（M3，受 settings.privacy 控制）
    startActivityMonitor()
    startMusicMonitor()
    startGeoMonitor()
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

    // 待机行为的感知输入（2026-10-17）：鼠标在动就告诉她"往哪边看"。
    // 只广播方向（-1..1），绝不广播绝对坐标；勿扰/关了活动监测时不采样。
    // 她是否真的"看"由渲染层的节流调度决定（看一眼就移开，不是盯着鼠标）。
    startGaze({
      getWindow: getPetWindow,
      getPrivacy: () => loadSettings().privacy,
      getBounds: () => {
        try {
          return getPetWindow()?.getBounds() || null
        } catch {
          return null
        }
      },
      onHint: (hint) => broadcast(EVT.GAZE, hint)
    })

    // 全局热键：桌宠不抢焦点，收不到普通键盘事件，只能在系统层注册
    //（本地触发，不是 Agent 工具调用，因此不走安全门确认）
    syncAmbientHost(loadSettings())

    if (process.env.NAGI_SELFTEST === '1' && process.env.NAGI_SELFTEST_PRESENCE === '1') {
      setTimeout(async () => {
        try {
          const result = await runPresenceSelftest(app.getPath('userData'))
          console.log('[presence:selftest] '+JSON.stringify(result))
          app.exit(result.ok ? 0 : 1)
        } catch (err) {console.error('[presence:selftest] '+JSON.stringify({ok:false,error:err.message}));app.exit(1)}
      },3000)
    }

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
    stopPresenceBindings()
    stopMusicMonitor()
    stopGeoMonitor()
    stopGaze()
    unregisterShortcuts()
    if (!disposeAgent.__done) {
      disposeAgent.__done = true
      e.preventDefault()
      disposeAgent().finally(() => app.quit())
    }
  })
}
