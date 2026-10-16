import { app, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../shared/protocol.js'
import { yearbookMarkdown } from '../../core/yearbook/store.js'
import { getYearbook } from '../yearbook.js'
import { trustedHandle } from './trusted.js'

export function registerYearbookIpc() {
  trustedHandle(IPC.YEARBOOK_LIST, () => getYearbook().list())
  trustedHandle(IPC.YEARBOOK_ADD, (_event, { sourceId } = {}) => getYearbook().add(sourceId))
  trustedHandle(IPC.YEARBOOK_EDIT, (_event, { id, title, note } = {}) =>
    getYearbook().edit(id, { title, note }))
  trustedHandle(IPC.YEARBOOK_REMOVE, (_event, { id } = {}) => getYearbook().remove(id))
  trustedHandle(IPC.YEARBOOK_EXPORT, async () => {
    const result = await dialog.showSaveDialog({
      title: '导出与凪的双人年鉴',
      defaultPath: join(app.getPath('documents'), `凪-双人年鉴-${new Date().toISOString().slice(0, 10)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
    const bundle = getYearbook().exportBundle()
    writeFileSync(result.filePath, yearbookMarkdown(bundle), 'utf8')
    return { ok: true, path: result.filePath, count: bundle.pages.length }
  })
}
