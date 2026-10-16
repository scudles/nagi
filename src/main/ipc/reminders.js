// src/main/ipc/reminders.js
// 日程提醒 IPC（M4）：列表 / 新增 / 删除 / 标记完成（工作台「她的日程」面板用）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { reminderList, reminderAdd, reminderRemove, reminderDone } from '../agent.js'
import { getPromiseBook } from '../promises.js'

export function registerReminderIpc() {
  trustedHandle(IPC.REMINDER_LIST, () => ({ ok: true, items: reminderList() }))
  trustedHandle(IPC.REMINDER_ADD, (_e, payload) => reminderAdd(payload))
  trustedHandle(IPC.REMINDER_REMOVE, (_e, payload) => reminderRemove(payload))
  trustedHandle(IPC.REMINDER_DONE, (_e, { id } = {}) => reminderDone(id))
  trustedHandle(IPC.PROMISE_LIST, () => ({ ok: true, items: getPromiseBook().list().slice(0, 100) }))
}
