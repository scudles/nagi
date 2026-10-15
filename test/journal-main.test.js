// 事件流水真实文件 IO：跨日和退出前的防抖写盘不能丢记录。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const userData = mkdtempSync(join(tmpdir(), 'nagi-journal-main-'))
mock.module('electron', {
  exports: { app: { getPath: (name) => name === 'userData' ? userData : '' } }
})
const { noteEvent, todayEvents, flushJournal } = await import('../src/main/journal.js')

test('跨日先刷前一天；退出时立即刷当天，不等待防抖定时器', (t) => {
  t.after(() => {
    assert.equal(dirname(userData), tmpdir())
    rmSync(userData, { recursive: true, force: true })
  })

  const yesterday = new Date(2026, 9, 15, 23, 59, 59, 700).getTime()
  const today = new Date(2026, 9, 16, 0, 0, 0, 100).getTime()
  noteEvent({ kind: 'chat', user: '昨天最后一句' }, yesterday)
  noteEvent({ kind: 'poke' }, today)

  const old = JSON.parse(readFileSync(join(userData, 'journal', '2026-10-15.json'), 'utf8'))
  assert.equal(old.entries.length, 1)
  assert.equal(old.entries[0].user, '昨天最后一句')
  assert.deepEqual(todayEvents(today).map((x) => x.kind), ['poke'])

  assert.equal(flushJournal(), true)
  const current = JSON.parse(readFileSync(join(userData, 'journal', '2026-10-16.json'), 'utf8'))
  assert.deepEqual(current.entries.map((x) => x.kind), ['poke'])
  assert.equal(flushJournal(), true, '重复退出刷盘应当安全')
})
