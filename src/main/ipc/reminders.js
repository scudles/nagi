// src/main/ipc/reminders.js
// 日程提醒 IPC（M4）：列表 / 新增 / 删除 / 标记完成（工作台「她的日程」面板用）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { reminderList, reminderAdd, reminderRemove, reminderDone } from '../agent.js'
import { getPromiseBook, cancelLinkedPromise, removePromise } from '../promises.js'

export function registerReminderIpc() {
  trustedHandle(IPC.REMINDER_LIST, () => ({ ok: true, items: reminderList() }))
  trustedHandle(IPC.REMINDER_ADD, (_e, payload) => reminderAdd(payload))
  trustedHandle(IPC.REMINDER_REMOVE, (_e, payload) => reminderRemove(payload))
  trustedHandle(IPC.REMINDER_DONE, (_e, { id } = {}) => reminderDone(id))
  trustedHandle(IPC.PROMISE_LIST, () => ({ ok: true, items: getPromiseBook().list().slice(0, 100) }))
  // 取消仍在提醒链路里的关联提醒：清正文 + 级联取消提醒本体，不做任何重放
  trustedHandle(IPC.PROMISE_CANCEL_LINKED, (_e, { id } = {}) =>
    cancelLinkedPromise(id, { cancelReminder: (p) => reminderRemove(p) }))
  // 已结束记录的删除入口
  trustedHandle(IPC.PROMISE_REMOVE, (_e, { id } = {}) => removePromise(id))
}
