import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-promises-test-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })
after(() => rmSync(userData, { recursive: true, force: true }))

test('Agent 工具只在文件写入有执行结果时标完成，外部控制只标尝试', async () => {
  const { runRecordedTool, getPromiseBook } = await import('../src/main/promises.js')
  const write = await runRecordedTool(async () => ({ ok: true, summary: '文件已写入' }),
    'file_write', { path: 'note.txt', content: '仅本次写入的秘密' })
  assert.equal(write.ok, true)
  const control = await runRecordedTool(async () => ({ ok: true, summary: '服务已调用' }),
    'home_set', { entity_id: 'light.room', state: 'on' })
  assert.match(control.summary, /外部效果尚未核实/)
  const failed = await runRecordedTool(async () => { throw new Error('offline') },
    'browser_act', { action: 'click' })
  assert.equal(failed.ok, false)
  const entries = getPromiseBook().list()
  assert.deepEqual(entries.map((x) => x.status).sort(), ['attempted', 'completed', 'failed'])
  const disk = readFileSync(join(userData, 'promises.json'), 'utf8')
  assert.doesNotMatch(disk, /仅本次写入的秘密/)
  assert.equal(entries.find((x) => x.status === 'completed').evidence.at(-1).kind, 'file-write-result')
})

test('旧版提醒的 doneAt 不被迁移成有证据的完成', async () => {
  const { syncReminderPromises, getPromiseBook } = await import('../src/main/promises.js')
  syncReminderPromises([{ id: 'legacy', text: '旧提醒', at: 100, createdAt: 50, doneAt: 200 }])
  assert.equal(getPromiseBook().get('reminder:legacy').status, 'legacy-unknown')
})
