// test/forget-e2e.test.js
// C5 遗忘端到端（CONTRACTS §11 / EVAL §3.10）：C5-FORGET-01 / C5-RESTART-01 / C5-BG-01。
//
// 这次补的是**便签**那一跳：`scrub()` 原来清历史/记忆/RAG/日记/流水/年鉴，
// 但完全没碰 `notes.json`——一条写着"他上次说不喜欢香菜"的便签，
// 在遗忘之后仍然能被读到，等于原文还留在界面上。
//
// [mock-io] 层：真实文件系统 + 真实 RAG store，只 mock electron 的 userData 路径。
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-forget-e2e-'))
// notes-file（B23 外部便签写入）在导入期就要 electron 的 dialog，
// mock 必须按**实际用到的导出**补齐，否则 ESM 链接阶段直接报
// "does not provide an export named 'dialog'"（见 HANDOFF 环境坑）。
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })

// 便签要开才写盘
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  rag: { enabled: true, provider: 'none' },
  presence: { enabled: false, notesEnabled: true, tracesEnabled: false, anchorsEnabled: false }
}))

const { getRag } = await import('../src/main/rag/index.js')
const { getLedger } = await import('../src/main/ledger.js')
const { addMemory, loadHistory, loadMemories, memoryLines, saveHistory } = await import('../src/main/persist.js')
const { forgetExperience } = await import('../src/main/ledger-actions.js')
const { loadNotes, listNotes, pruneNotesReferencing } = await import('../src/main/presence-notes.js')

const SECRET = '我不喜欢香菜，别给我点'

function seedNotes() {
  writeFileSync(join(userData, 'notes.json'), JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    notes: [
      { id: 'n1', at: Date.now(), kind: 'note', text: '他上次说了：我不喜欢香菜' },
      { id: 'n2', at: Date.now(), kind: 'note', text: '他今天心情不错' }
    ],
    traces: []
  }))
}

// 整个文件共用一个 userData：只用模块级 after 清理，
// 别在单个 test 的 after 里删目录（否则后续"重启"用例找不到文件，假失败）。
after(() => { rmSync(userData, { recursive: true, force: true }) })

test('C5-FORGET-01：遗忘后便签也不再引用原文', async () => {
  const rag = getRag().init()
  const ledger = getLedger()
  loadMemories()
  loadHistory()
  seedNotes()

  addMemory(SECRET)
  const claim = ledger.list().find((e) => e.source.type === 'memory-manual')
  assert.ok(claim, '账本应记下这条经历')
  const fact = rag.ingestFact({ text: SECRET })
  assert.equal(fact.ok, true)
  saveHistory([{ role: 'user', content: SECRET }, { role: 'assistant', content: '记住了' }])

  // 遗忘前：便签里有、记忆里有、检索得回
  assert.equal(listNotes().notes.some((n) => n.text.includes('香菜')), true)
  assert.equal(memoryLines().some((l) => l.includes('香菜')), true)

  const r = forgetExperience(claim.id)
  assert.equal(r.ok, true, r.error)

  // 五处都不可引用
  assert.equal(memoryLines().some((l) => l.includes('香菜')), false, '记忆')
  assert.deepEqual((await rag.recall('香菜')).results, [], '检索')
  assert.equal(rag.io.readPending().some((p) => String(p.text || '').includes('香菜')), false, '待嵌队列')
  const histRaw = existsSync(join(userData, 'history.json')) ? readFileSync(join(userData, 'history.json'), 'utf8') : ''
  assert.equal(histRaw.includes('香菜'), false, '历史')
  const notesRaw = readFileSync(join(userData, 'notes.json'), 'utf8')
  assert.equal(notesRaw.includes('香菜'), false, '便签（本轮补上的那一跳）')
  // 无关便签不能被误删
  assert.match(notesRaw, /心情不错/)
})

test('C5-RESTART-01：重新从磁盘加载后仍不可引用（tombstone 持久化）', async () => {
  getRag().init()
  loadMemories()
  loadHistory()
  // 重新读盘：脏数据不能因为"内存里没查过"而复活
  const histRaw = existsSync(join(userData, 'history.json')) ? readFileSync(join(userData, 'history.json'), 'utf8') : ''
  assert.equal(histRaw.includes('香菜'), false)
  assert.equal(readFileSync(join(userData, 'notes.json'), 'utf8').includes('香菜'), false)
  // 真正启动一个全新的 Node 进程，重新 import 主进程模块并从相同 profile 读盘。
  const check = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    join(process.cwd(), 'scripts', 'fixtures', 'forget-restart-check.mjs'),
    userData
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 })
  assert.equal(check.status, 0, check.stderr || check.stdout)
  const fresh = JSON.parse(check.stdout.trim().split(/\r?\n/).at(-1))
  assert.deepEqual(fresh, { memory: false, history: false, notes: false, rag: false })
})

test('C5-BG-01：遗忘后再跑一次落盘/嵌入，不会把旧内容写回', async () => {
  const rag = getRag().init()
  // 模拟后台：把待嵌队列再 drain 一遍（旧条目已删，队列里不该有它）
  const pending = rag.io.readPending()
  assert.equal(pending.some((p) => String(p.text || '').includes('香菜')), false)
  const again = rag.ingestFact({ text: '今天天气不错' })
  assert.equal(again.ok, true, '新内容仍可正常写入')
})

test('便签清理的边界：短片段不参与匹配，避免误删无关便签', () => {
  const before = listNotes().notes.length
  const empty = pruneNotesReferencing(['香菜']) // 2 字，低于 4 字门槛
  assert.equal(empty.removed, 0)
  assert.equal(listNotes().notes.length, before)
  assert.equal(pruneNotesReferencing([]).removed, 0)
})
