// test/notes-file-main.test.js
// B23 主进程桥接（唯一真写 fs 的地方）：确认、取消、未授权、重复、节流、覆盖防护。
//
// 用真实临时目录真写盘（不 mock fs），这样"到底有没有落盘"是看得见的；
// electron 的 dialog 与 settings-store 用 mock 注入。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { readdirSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'nagi-notes-file-'))

let settings = {
  presence: { externalNotesEnabled: true, notesExternalDir: TMP }
}
let dialogAnswer = 0 // 0 = 写入（第一个按钮）
let pickedPaths = [TMP]

mock.module('electron', {
  exports: {
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: pickedPaths }),
      // buttons: ['写入','取消'] → 0 写入 / 1 取消
      showMessageBox: async () => ({ response: dialogAnswer })
    }
  }
})
mock.module('../src/main/settings-store.js', {
  exports: {
    getSettings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch, presence: { ...settings.presence, ...(patch.presence || {}) } }
      return settings
    }
  }
})

const {
  writeNoteFile,
  pickExternalDir,
  revokeExternalDir,
  externalWriteStatus,
  setNotesReader,
  syncExternalNotes,
  __peekNoteFileState
} = await import('../src/main/notes-file.js')

const NOTE = {
  id: 'note-1',
  noteKind: 'activity',
  at: Date.now(),
  text: '你不在的时候，我读了会儿东西。',
  provenance: 'simulation'
}
setNotesReader(() => [NOTE])

/** 关一次开关再打开：这是真实语义（关闭即清空内存状态，不重放积压），
 *  也正好是"重启后幂等表归零"的等价物——比直接摸内部状态体面。 */
function recycleState() {
  settings.presence.externalNotesEnabled = false
  syncExternalNotes()
  settings.presence.externalNotesEnabled = true
  syncExternalNotes()
}

const names = () => readdirSync(TMP)
/** core 拼出来的是 POSIX 分隔符，Windows 上 Node 认，但字符串比较前得先统一 */
const sameChar = (p) => String(p).replace(/\\/g, '/')
const underTmp = (p) => sameChar(p).startsWith(sameChar(TMP) + '/')

test('开关关闭 / 未授权：不写盘，且理由可诊断', async () => {
  settings.presence.externalNotesEnabled = false
  const r = await writeNoteFile('note-1', null)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  settings.presence.externalNotesEnabled = true

  settings.presence.notesExternalDir = ''
  const r2 = await writeNoteFile('note-1', null)
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'no-root')
  settings.presence.notesExternalDir = TMP
  assert.deepEqual(names(), [], '拒绝时不得产生任何文件')
})

test('找不到便签：不写盘', async () => {
  const r = await writeNoteFile('nope', null)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-note')
})

test('用户取消确认：不写盘、不占额度（下次还能再问）', async () => {
  dialogAnswer = 1
  const r = await writeNoteFile('note-1', null)
  assert.equal(r.ok, false)
  assert.equal(r.canceled, true)
  assert.deepEqual(names(), [], '取消后不能留下文件')
  assert.equal(__peekNoteFileState().count, 0, '取消不占额度')
})

test('确认写入：文件真落盘，正文如实（含模拟活动标注）', async () => {
  dialogAnswer = 0
  const r = await writeNoteFile('note-1', null)
  assert.equal(r.ok, true, `应写入成功：${r.error || r.reason}`)
  assert.ok(underTmp(r.path), `必须落在授权目录内：${r.path}`)
  assert.ok(r.fileName.endsWith('.txt'))
  const body = readFileSync(r.path, 'utf8')
  assert.ok(body.includes('读了会儿东西'))
  assert.ok(body.includes('不是你离开期间外界发生的事'), '模拟活动必须照旧标注')
  assert.equal(names().length, 1)
})

test('同一张便签不会写第二遍', async () => {
  dialogAnswer = 0
  const r = await writeNoteFile('note-1', null)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'duplicate')
  assert.equal(names().length, 1, '文件数不该增加')
})

test('30 分钟最小间隔：连着写第二张会被挡，理由如实', async () => {
  const another = { ...NOTE, id: 'note-3', text: '又想起一件事。' }
  setNotesReader(() => [NOTE, another])
  dialogAnswer = 0
  const r = await writeNoteFile('note-3', null)
  assert.equal(r.ok, false, '刚写完一张，不该立刻再写')
  assert.equal(r.reason, 'too-soon')
  assert.equal(names().length, 1, '被节流时不能落盘')
  assert.equal(__peekNoteFileState().count, 1, '被挡不占额度')
  setNotesReader(() => [NOTE])
})

test('选目录：存真实路径；撤销只清授权、不删已写出的文件', async () => {
  const picked = await pickExternalDir(null)
  assert.equal(picked.ok, true)
  assert.equal(settings.presence.notesExternalDir, TMP)
  const before = names().length
  assert.equal(before, 1)
  const revoked = revokeExternalDir()
  assert.equal(revoked.ok, true)
  assert.equal(settings.presence.notesExternalDir, '')
  assert.equal(names().length, before, '撤销不得删用户已有的文件')
  // 撤销后立刻变不可用，且状态被清空
  assert.equal(externalWriteStatus().available, false)
  assert.equal(syncExternalNotes().available, false)
  assert.equal(__peekNoteFileState().count, 0, '撤销即清空内存状态')
  settings.presence.notesExternalDir = TMP
})

test('已存在同名文件时不覆盖：写入失败并如实报错', async () => {
  // 正文必须不同：文件名由「日期 + 类型 + 正文」拼出，同名就撞车，测不到覆盖防护
  const fresh = { ...NOTE, id: 'note-2', text: '窗外的天暗下来了。' }
  setNotesReader(() => [fresh])
  dialogAnswer = 0

  recycleState() // 清掉节流与幂等表，模拟"重启后又来一次"
  const first = await writeNoteFile('note-2', null)
  assert.equal(first.ok, true, `第一次应写入成功：${first.error || first.reason}`)
  assert.ok(underTmp(first.path), `必须落在授权目录内：${first.path}`)
  const guard = readFileSync(first.path, 'utf8')

  recycleState() // 幂等表再次归零：此时同名文件还在，wx 必须挡住
  const second = await writeNoteFile('note-2', null)
  assert.equal(second.ok, false, '同名文件必须拒绝覆盖')
  assert.equal(second.reason, 'write-failed')
  assert.equal(readFileSync(first.path, 'utf8'), guard, '原文件一个字都不能变')
  assert.equal(__peekNoteFileState().count, 0, '写失败不占额度')
})
