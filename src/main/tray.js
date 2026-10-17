// src/main/tray.js
// 系统托盘：打开工作台 / 回到桌宠 / 退出；单击切换形态。

import { Tray, Menu, nativeImage, app } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MODE } from '../shared/protocol.js'
import { switchMode, getMode, getPetWindow, getWorkbenchWindow, openDiaryWindow } from './windows.js'
import { outfitCatalog, sendOutfitCommand } from './outfit-state.js'
import { DEFAULT_SHORTCUTS, prettyAccelerator } from './shortcuts.js'

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
