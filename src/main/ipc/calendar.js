import { dialog, BrowserWindow } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { getCalendarSnapshot } from '../signals/calendar.js'

const MAX_BYTES = 2 * 1024 * 1024

export function registerCalendarIpc() {
  trustedHandle(IPC.CALENDAR_STATUS, () => getCalendarSnapshot().status())
  trustedHandle(IPC.CALENDAR_IMPORT, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const opts = { title: '授权凪读取一份日历快照', properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics'] }] }
    const picked = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    const path = picked.filePaths[0]
    if (statSync(path).size > MAX_BYTES) return { ok: false, error: '日历文件超过 2MB' }
    try {
      const result = getCalendarSnapshot().importText(readFileSync(path, 'utf8'), basename(path))
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: err.message } }
  })
  trustedHandle(IPC.CALENDAR_REVOKE, () => ({ ok: true, ...getCalendarSnapshot().revoke() }))
}
