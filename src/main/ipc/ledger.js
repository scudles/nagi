import { app, BrowserWindow, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../shared/protocol.js'
import { trustedHandle } from './trusted.js'
import { getLedger } from '../ledger.js'
import { correctExperience, forgetExperience } from '../ledger-actions.js'

async function confirm(event, message, detail) {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options = {
    type: 'warning', title: '确认记忆操作', message, detail,
    buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true
  }
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

export function registerLedgerIpc() {
  trustedHandle(IPC.LEDGER_LIST, (_event, opts = {}) => {
    const all = getLedger().list({ includeDeleted: opts.includeDeleted === true })
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
    const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 100)))
    return { ok: true, total: all.length, entries: all.slice(offset, offset + limit) }
  })
  trustedHandle(IPC.LEDGER_GET, (_event, { id } = {}) => ({ ok: true, entry: getLedger().get(id) }))
  trustedHandle(IPC.LEDGER_FORGET, async (event, { id } = {}) => {
    const entry = getLedger().get(id)
    if (!entry || entry.deletedAt) return { ok: false, error: '没有这条记录' }
    if (!await confirm(event, '忘记这条记录？', '原文会从账本、对应日记或对话来源及记忆检索中删除。')) {
      return { ok: false, cancelled: true }
    }
    return forgetExperience(id)
  })
  trustedHandle(IPC.LEDGER_CORRECT, async (event, { id, text } = {}) => {
    const entry = getLedger().get(id)
    if (!entry || entry.deletedAt) return { ok: false, error: '没有这条记录' }
    if (!await confirm(event, '以你的更正替换这条记忆？', '旧内容会从检索与提示词中清除；更正会标为用户修正，并保留原记录 ID。')) {
      return { ok: false, cancelled: true }
    }
    return correctExperience(id, text)
  })
  trustedHandle(IPC.LEDGER_EXPORT, async () => {
    const result = await dialog.showSaveDialog({
      title: '导出与凪的共同记忆',
      defaultPath: join(app.getPath('documents'), `凪-共同记忆-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
    const bundle = getLedger().exportBundle()
    writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf8')
    return { ok: true, path: result.filePath, count: bundle.entries.length }
  })
}
