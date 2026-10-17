// B01 持久化中断窗口 —— main 层集成测试（mock electron + 真实临时目录）
// 端到端证明：写盘失败时原文件保持上一版完好、失败如实上报、账本调用方可检查。
// 失败注入用纯文件系统技巧（把目标/临时文件占成目录），不 mock 任何 fs。
// ledger 记账在这里是无关项，mock 成无副作用桩（真账本行为由 ledger-actions 测试覆盖）。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let userData = mkdtempSync(join(process.cwd(), '.nagi-persist-'))
const dirs = [userData]
const electronMock = { app: { getPath: () => userData } }
mock.module('electron', { exports: electronMock })
mock.module('../src/main/ledger.js', {
  exports: { recordLedger: () => null, deleteLedgerSource: () => 0 }
})

const { addMemory, flushPersist, consumePersistWarnings, loadMemories, loadHistory, saveHistory, saveMoodState } =
  await import('../src/main/persist.js')

/** 每个测试换一个全新 userData（模拟不同启动会话），teardown 统一清理 */
function freshUserData() {
  userData = mkdtempSync(join(process.cwd(), '.nagi-persist-'))
  dirs.push(userData)
  return userData
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const readDisk = (name) => JSON.parse(readFileSync(join(userData, name), 'utf8'))

test('未加载过的文件不会被 flush 覆盖成空（旧版 latent bug：启动即退出即清空）', (t) => {
  t.after(() => freshUserData())
  writeFileSync(join(userData, 'memory.json'), JSON.stringify({ version: 1, entries: [{ id: 'm1', text: '用户明确记下的事', at: 1 }] }))
  writeFileSync(join(userData, 'history.json'), JSON.stringify({ version: 1, messages: [{ role: 'user', content: '在吗' }], lastAt: 5 }))
  const r = flushPersist() // 此前从未 loadMemories/loadHistory
  assert.equal(r.ok, true, JSON.stringify(r.failed))
  assert.equal(readDisk('memory.json').entries.length, 1)
  assert.equal(readDisk('memory.json').entries[0].text, '用户明确记下的事')
  assert.equal(readDisk('history.json').messages[0].content, '在吗')
})

test('flushPersist 全成功：逐文件结果 + 内容正确 + mood/relation 无状态不建文件', (t) => {
  t.after(() => freshUserData())
  addMemory('她记住的第一件事')
  saveHistory([{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗯，我在' }], 123)
  saveMoodState({ label: 'calm', intensity: 0.3 })
  const r = flushPersist()
  assert.equal(r.ok, true, JSON.stringify(r.failed))
  assert.ok(r.written.includes('memory.json'))
  assert.ok(r.written.includes('history.json'))
  assert.ok(r.written.includes('mood.json'))
  assert.equal(r.written.includes('relation.json'), false) // 从未有过关系状态
  assert.equal(existsSync(join(userData, 'relation.json')), false)
  assert.equal(readDisk('mood.json').label, 'calm')
  assert.equal(readDisk('history.json').messages.length, 2)
  // 无残留临时文件
  assert.equal(existsSync(join(userData, 'memory.json.tmp')), false)
})

test('B01 端到端：临时文件写入失败时，原文件保持上一版完好', (t) => {
  t.after(() => freshUserData())
  addMemory('上一版内容')
  assert.equal(flushPersist().ok, true)
  const before = readFileSync(join(userData, 'memory.json'), 'utf8')
  // 注入：把 tmp 占成目录 → writeFileSync(tmp) 必败（EISDIR）
  mkdirSync(join(userData, 'memory.json.tmp'))
  addMemory('这一版应该写不进去')
  const r = flushPersist()
  assert.equal(r.ok, false)
  assert.ok(r.failed.some((f) => f.file === 'memory.json'), JSON.stringify(r.failed))
  assert.equal(readFileSync(join(userData, 'memory.json'), 'utf8'), before) // 原版一字未动
})

test('B01 端到端：rename 失败时，其余文件照常写、失败文件如实记录', (t) => {
  t.after(() => freshUserData())
  saveHistory([{ role: 'user', content: '旧对话' }], 1)
  assert.equal(flushPersist().ok, true)
  // 注入：把目标 memory.json 占成目录 → renameSync(tmp, 目录) 必败
  rmSync(join(userData, 'memory.json'), { force: true })
  mkdirSync(join(userData, 'memory.json'))
  addMemory('这条记忆落不下去')
  const r = flushPersist()
  assert.equal(r.ok, false)
  assert.ok(r.failed.some((f) => f.file === 'memory.json'))
  assert.ok(r.written.includes('history.json')) // 部分失败不影响其它文件
  // 失败报告已落盘（下次启动要能说出来）
  assert.equal(existsSync(join(userData, 'persist-warnings.json')), true)
  const warnings = consumePersistWarnings()
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].failed.some((f) => f.file === 'memory.json'))
  // 取过一次就清，不复读
  assert.deepEqual(consumePersistWarnings(), [])
  assert.equal(existsSync(join(userData, 'persist-warnings.json')), false)
})

test('防抖：同文件多次写在延时内合并为一次', (t) => {
  t.after(() => freshUserData())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const before = loadMemories().length
  addMemory('甲')
  addMemory('乙')
  addMemory('丙')
  assert.equal(existsSync(join(userData, 'memory.json.tmp')), false) // 防抖窗口内还没开始写
  t.mock.timers.tick(400)
  assert.equal(readDisk('memory.json').entries.length, before + 3) // 三次 add 的内存合并结果一次落盘
  assert.equal(existsSync(join(userData, 'memory.json.tmp')), false) // 无残留临时文件
  t.mock.timers.reset()
})

test('loadMemories/loadHistory 懒加载读回磁盘内容', (t) => {
  t.after(() => freshUserData())
  addMemory('跨调用可见')
  flushPersist()
  // 同一进程模块缓存还在，此处主要证明读回的不是空
  assert.ok(loadMemories().some((e) => e.text === '跨调用可见'))
  saveHistory([{ role: 'user', content: '在吗' }], 7)
  flushPersist()
  assert.equal(loadHistory()[0].content, '在吗')
})
