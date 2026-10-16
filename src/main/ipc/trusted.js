import { ipcMain } from 'electron'
import { isTrustedIpcSource } from '../../core/safety/ipc-origin.js'
import { findWindowByWebContents, rendererEntryUrl } from '../windows.js'

function allowed(event) {
  return isTrustedIpcSource(event, {
    findWindow: findWindowByWebContents,
    rendererEntry: rendererEntryUrl()
  })
}

export function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!allowed(event)) throw new Error('IPC 来源未授权')
    return handler(event, ...args)
  })
}

export function trustedOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!allowed(event)) return
    handler(event, ...args)
  })
}
