// src/main/tray.js
// 系统托盘：打开工作台 / 回到桌宠 / 退出；单击切换形态。

import { Tray, Menu, nativeImage, app } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MODE, EVT } from '../shared/protocol.js'
import { switchMode, getMode, getPetWindow, getWorkbenchWindow, openDiaryWindow, broadcast } from './windows.js'
import { outfitCatalog, sendOutfitCommand } from './outfit-state.js'
import { DEFAULT_SHORTCUTS, prettyAccelerator } from './shortcuts.js'
import { getSettings, saveSettings } from './settings-store.js'
import { refreshPresence } from './presence.js'
import { refreshMonitorPrivacy } from './monitor/index.js'
import { refreshHaSignals } from './signals/ha.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let tray = null

function iconPath() {
  // dev: 源码目录；prod: 打包后 resources/ 同级的 resources
  const candidates = [
    join(__dirname, '../../resources/tray.png'),
    join(process.resourcesPath || '', 'resources/tray.png'),
    join(process.resourcesPath || '', 'tray.png')
  ]
  return candidates.find((p) => p && existsSync(p)) || null
}

function buildMenu() {
  const mode = getMode()
  return Menu.buildFromTemplate([
    {
      label: '打开工作台',
      type: 'radio',
      checked: mode === MODE.WORKBENCH,
      click: () => switchMode(MODE.WORKBENCH)
    },
    {
      label: '回到桌宠',
      type: 'radio',
      checked: mode === MODE.PET,
      click: () => switchMode(MODE.PET)
    },
    { type: 'separator' },
    ...quietMenuItems(),
    { type: 'separator' },
    {
      label: '显示 / 隐藏桌宠',
      click: () => {
        const win = getPetWindow()
        if (!win) return switchMode(MODE.PET)
        if (win.isVisible()) win.hide()
        else win.showInactive()
      }
    },
    {
      label: '显示工作台',
      click: () => {
        const win = getWorkbenchWindow()
        if (win) {
          win.show()
          win.focus()
        } else {
          switchMode(MODE.WORKBENCH)
        }
      }
    },
    { label: '看看她的日记', click: () => openDiaryWindow() },
    { type: 'separator' },
    outfitMenuItems(),
    {
      label: '让她动一下',
      accelerator: prettyAccelerator(DEFAULT_SHORTCUTS.act),
      click: () => sendOutfitCommand('act')
    },
    {
      label: '让她做个表情',
      click: () => sendOutfitCommand('expr')
    },
    {
      label: '演一段（完整动作）',
      click: () => sendOutfitCommand('showpiece')
    },
    { type: 'separator' },
    { label: '退出凪', click: () => app.quit() }
  ])
}

/**
 * 打扰控制（D51）：勿扰与只陪着是**临时状态**，不该埋在设置页最底部 ——
 * 用的时候往往就是要立刻静下来，右键托盘一下就够了。
 * 设置页里这两项收进了「陪伴 → 高级」，留作备用入口（万一托盘图标被系统折叠了）。
 */
function quietMenuItems() {
  const p = getSettings()?.privacy || {}
  return [
    {
      label: '勿扰模式',
      type: 'checkbox',
      checked: p.doNotDisturb === true,
      click: (item) => setPrivacy('doNotDisturb', item.checked)
    },
    {
      label: '只陪着',
      type: 'checkbox',
      checked: p.onlyPresence === true,
      click: (item) => setPrivacy('onlyPresence', item.checked)
    }
  ]
}

/**
 * 从托盘翻隐私开关。后置动作必须与设置页保存**完全一致**
 * （见 ipc/settings.js 的 SETTINGS_SET），否则会出现「菜单勾了、行为没变」
 * 这种最难查的不一致。
 *
 * G3：落盘失败时**不广播 SETTINGS_CHANGED**——那会让 renderer 把开关刷成新值，
 * 而磁盘根本没写（隐私"假关闭"）。菜单也刷新回旧勾选状态，让用户看到"没翻过去"。
 * 上报由 settings-store 单点完成（站点 settings.saveSettings），这里只做控制流。
 */
function setPrivacy(key, value) {
  try {
    const next = saveSettings({ privacy: { [key]: value === true } })
    refreshPresence()
    refreshMonitorPrivacy()
    refreshHaSignals()
    broadcast(EVT.SETTINGS_CHANGED, next)
  } catch (err) {
    /* B8:must-persist — 落盘失败已由 settings.saveSettings 单点上报进健康状态；
       这里只做控制流：不广播 SETTINGS_CHANGED（否则 renderer 会把隐私开关刷成新值，
       而磁盘根本没写＝隐私假关闭），菜单刷新回旧勾选。 */
    console.warn('[tray] 隐私开关保存失败，菜单保持原状态：', err.message)
  }
  refreshTrayMenu()
}

/**
 * 装束子菜单：清单来自渲染层上报（模型目录的 nagi-outfit.json），
 * 没上报之前只给一个"下一个"，不让菜单空着。
 */
function outfitMenuItems() {
  const cat = outfitCatalog()
  const looks = cat.looks || []
  if (!looks.length) {
    return {
      label: '装束',
      submenu: [{ label: '（模型还没就绪）', enabled: false }]
    }
  }
  return {
    label: `装束${cat.name ? `：${cat.name}` : ''}`,
    submenu: [
      ...looks.map((l) => ({
        label: l.desc ? `${l.name} —— ${l.desc}` : l.name,
        type: 'radio',
        checked: cat.current === l.id,
        click: () => sendOutfitCommand('set', l.id)
      })),
      { type: 'separator' },
      {
        label: '下一个',
        accelerator: prettyAccelerator(DEFAULT_SHORTCUTS.next),
        click: () => sendOutfitCommand('next')
      },
      {
        label: '上一个',
        accelerator: prettyAccelerator(DEFAULT_SHORTCUTS.prev),
        click: () => sendOutfitCommand('prev')
      },
      { label: '随便换一身', click: () => sendOutfitCommand('random') }
    ]
  }
}

export function createTray() {
  const p = iconPath()
  const image = p ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
  if (p) image.setTemplateImage(false)
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('凪 Nagi')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => {
    switchMode(getMode() === MODE.PET ? MODE.WORKBENCH : MODE.PET)
    tray.setContextMenu(buildMenu())
  })
  return tray
}

export function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildMenu())
}
