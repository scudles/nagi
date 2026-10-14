// src/main/tray.js
// 系统托盘：打开工作台 / 回到桌宠 / 退出；单击切换形态。

import { Tray, Menu, nativeImage, app } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MODE } from '../shared/protocol.js'
import { switchMode, getMode, getPetWindow, getWorkbenchWindow } from './windows.js'

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
    { type: 'separator' },
    { label: '退出凪', click: () => app.quit() }
  ])
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
