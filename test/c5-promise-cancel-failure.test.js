// test/c5-promise-cancel-failure.test.js
// C5「一并取消」的失败语义（用户点下去的按钮必须说到做到）。
//
// 修前的问题：cancelLinkedPromise 先把承诺标记取消、清正文，再调提醒本体取消，
// 且**忽略 cancelReminder 返回的 {ok:false}、吞掉抛错**，最后一律返回 {ok:true}。
// 后果：用户看到"已取消"，提醒其实还在，承诺簿也已经被清成了最小记录——两头不一致，
// 而且因为正文已清，用户连"原来那条是什么"都看不到了，重试也无从谈起。
//
// 这里全部走真实文件系统 + 真实承诺簿（[mock-io]），只 mock electron 的 userData。
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const userData = mkdtempSync(join(tmpdir(), 'nagi-c5-cancel-'))
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })

const { getPromiseBook, cancelLinkedPromise, removePromise } = await import('../src/main/promises.js')
const { maintenanceHealth, clearMaintenanceTrace } = await import('../src/main/maintenance.js')
const { selectForContext } = await import('../src/core/promises/book.js')

after(() => {
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

const SECRET = '蓝区私密承诺：周五替她交报告'
let seq = 0

/** 造一条"经历已遗忘、用户选择保留"的提醒承诺（detached） */
function seedKept(title = SECRET) {
  const id = `reminder:kept-${++seq}`
  getPromiseBook().create({ id, kind: 'reminder', title,
    source: { type: 'reminder', id: `r-${seq}` }, sourceIds: ['exp-1'], dueAt: Date.now() + 3600000 })
  getPromiseBook().detach(id)
  return id
}

const raw = () => JSON.parse(readFileSync(join(userData, 'promises.json'), 'utf8'))
const entryOf = (id) => raw().entries.find((e) => e.id === id)

test('C5-CANCEL-01：cancelReminder 返回 {ok:false} 时不得报成功，承诺保持可管理、可重试', () => {
  clearMaintenanceTrace()
  const id = seedKept()
  let calls = 0
  const r = cancelLinkedPromise(id, { cancelReminder: () => { calls++; return { ok: false, error: '存储被占用' } } })

  assert.equal(r.ok, false, '提醒本体没取消掉，就不能对用户说"已取消"')
  assert.equal(r.retryable, true, '必须标明可重试')
  assert.equal(calls, 1, '要真的去取消提醒本体')
  assert.ok(/存储被占用/.test(r.error), '失败原因要带给用户：' + r.error)

  const after = getPromiseBook().get(id)
  assert.equal(after.status, 'scheduled', '承诺状态不许被提前改成 cancelled')
  assert.equal(after.title, SECRET, '正文不许被提前清掉——否则用户想重试都不知道原来是什么')
  assert.equal(after.redactedAt, undefined, '不许提前降级成最小记录')
  assert.ok(entryOf(id).title === SECRET && entryOf(id).status === 'scheduled',
    '落盘内容与内存一致（仍是原正文、仍未取消）')

  // 重试：这次成功 → 才允许清理
  const ok = cancelLinkedPromise(id, { cancelReminder: () => ({ ok: true, removed: 1 }) })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(getPromiseBook().get(id).status, 'cancelled')
  assert.equal(getPromiseBook().get(id).title, '')
})

test('C5-CANCEL-02：cancelReminder 抛错时同样不得报成功，且失败进维护状态', () => {
  clearMaintenanceTrace()
  const id = seedKept()
  const r = cancelLinkedPromise(id, { cancelReminder: () => { throw new Error('磁盘满了') } })

  assert.equal(r.ok, false)
  assert.equal(r.retryable, true)
  const after = getPromiseBook().get(id)
  assert.equal(after.status, 'scheduled', '抛错也不能把承诺提前标记取消')
  assert.equal(after.title, SECRET, '抛错也不能提前清正文')
  const health = maintenanceHealth()
  assert.equal(health.healthy, false, '取消失败要能在设置页看到')
  assert.ok(health.sites.some((s) => s.site.startsWith('promises.cancelLinkedPromise') && s.lastClass === 'promise'),
    '要落到承诺相关站点、类别为 promise')
})

test('C5-CANCEL-03：成功取消后正文与派生内容全部清除，且不再进人格回忆/锚点', () => {
  clearMaintenanceTrace()
  const id = seedKept()
  // 先塞一条带可复原字段的证据（detail/path），取消后必须被剥掉
  getPromiseBook().transition(id, 'attempting', { kind: 'execution-started', detail: SECRET, path: 'C:\\secret\\report.txt' })

  let cancelledId = null
  const r = cancelLinkedPromise(id, { cancelReminder: (p) => { cancelledId = p.id; return { ok: true, removed: 1 } } })
  assert.equal(r.ok, true, r.error)
  assert.equal(cancelledId, 'r-' + seq, '要级联取消对应的提醒本体')

  const after = getPromiseBook().get(id)
  assert.equal(after.status, 'cancelled')
  assert.equal(after.title, '', '正文必须清除（只留最小履约记录）')
  assert.ok(after.evidence.length >= 1, '证据类别要留着')
  for (const ev of after.evidence) {
    assert.equal(Object.keys(ev).sort().join(','), 'at,kind', '证据不得带 detail/path/bytes 等可复原字段')
  }
  // 只查这一条的落盘形态：同文件里还有别的用例**故意**保留的失败态承诺，不能混在一起看
  const onDisk = JSON.stringify(entryOf(id))
  assert.ok(!onDisk.includes(SECRET), '落盘的 promises.json 里，这一条不能再出现正文')
  assert.ok(!onDisk.includes('secret\\report'), '证据里的路径也不许留下')

  // 派生：不再进人格回忆 / 关系锚点 / 模型上下文
  assert.ok(!selectForContext(getPromiseBook().list(), { forgottenIds: [] }).some((p) => p.id === id),
    '已降级的承诺不得再进上下文')

  // 最小记录仍在，可走删除入口；删除不重放任何外部操作
  assert.equal(removePromise(id).ok, true)
  assert.equal(getPromiseBook().get(id), null)
})

test('C5-CANCEL-04：承诺簿写盘失败（半完成）必须如实说，且重试能补齐', () => {
  clearMaintenanceTrace()
  const id = seedKept()
  const book = getPromiseBook()
  const realPersist = book.persist
  let cancelled = 0
  book.persist = () => { throw new Error('权限不足，写不进去') }
  try {
    const r = cancelLinkedPromise(id, { cancelReminder: () => { cancelled++; return { ok: true, removed: 1 } } })
    assert.equal(r.ok, false, '记录没写成就不算成功')
    assert.equal(r.retryable, true)
    assert.equal(r.reminderCancelled, true, '要说明"提醒已取消、记录没跟上"这个半完成状态')
    assert.ok(/权限不足/.test(r.error))
  } finally {
    book.persist = realPersist
  }
  assert.equal(cancelled, 1, '提醒本体确实已经取消了')
  const after = getPromiseBook().get(id)
  assert.equal(after.status, 'scheduled', '写盘失败要回滚，不能留下半新半旧的状态')
  assert.equal(after.title, SECRET)

  // 重试：只补记录（提醒已不在，removed 为 0 也照成）
  const retry = cancelLinkedPromise(id, { cancelReminder: () => ({ ok: true, removed: 0 }) })
  assert.equal(retry.ok, true, retry.error)
  assert.equal(retry.reminderMissing, true, '要如实说明提醒本来就不在列表里')
  assert.equal(getPromiseBook().get(id).status, 'cancelled')
  assert.equal(getPromiseBook().get(id).title, '')
})

test('C5-CANCEL-05：已结束的记录走删除入口，取消入口不再含糊其辞', () => {
  clearMaintenanceTrace()
  const id = seedKept()
  getPromiseBook().transition(id, 'completed', { kind: 'user-confirmation' })
  const r = cancelLinkedPromise(id, { cancelReminder: () => { throw new Error('不该被调用') } })
  assert.equal(r.ok, false)
  assert.equal(r.finished, true, '要标明"已结束"，让界面改走删除入口')
  assert.equal(getPromiseBook().get(id).status, 'completed', '已结束状态不许被改动')
  assert.equal(removePromise(id).ok, true, '已结束记录要能直接删除')
})
