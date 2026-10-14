// src/main/ipc/reminders.js
// 日程提醒 IPC（M4）：列表 / 新增 / 删除 / 标记完成（工作台「她的日程」面板用）。

import { ipcMain } from 'electron'
import { IPC } from '../../shared/protocol.js'
import { reminderList, reminderAdd, reminderRemove, reminderDone } from '../agent.js'

export function registerReminderIpc() {
  ipcMain.handle(IPC.REMINDER_LIST, () => ({ ok: true, items: reminderList() }))
  ipcMain.handle(IPC.REMINDER_ADD, (_e, payload) => reminderAdd(payload))
  ipcMain.handle(IPC.REMINDER_REMOVE, (_e, payload) => reminderRemove(payload))
  ipcMain.handle(IPC.REMINDER_DONE, (_e, { id } = {}) => reminderDone(id))
}
