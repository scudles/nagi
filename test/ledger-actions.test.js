import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-ledger-actions-'))
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
} })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ rag: { enabled: true, provider: 'none' } }))

const { getRag } = await import('../src/main/rag/index.js')
const { getLedger } = await import('../src/main/ledger.js')
const { addMemory, flushPersist, loadHistory, loadMemories, memoryLines, saveHistory } = await import('../src/main/persist.js')
const { noteEvent, flushJournal } = await import('../src/main/journal.js')
const { appendDiary } = await import('../src/main/diary.js')
const { correctExperience, forgetExperience } = await import('../src/main/ledger-actions.js')

test('纠错与忘记清理提示词、待嵌 RAG、旧流水和历史，重启不复活', (t) => {
  t.after(() => {
    getRag().dispose()
    rmSync(userData, { recursive: true, force: true })
  })
  const rag = getRag().init()
  const ledger = getLedger()
  loadMemories()
  loadHistory()

  addMemory('旧的错误偏好')
  const claim = ledger.list().find((entry) => entry.source.type === 'memory-manual')
  const fact = rag.ingestFact({ text: '旧的错误偏好' })
  assert.equal(fact.ok, true)
  const forgot = forgetExperience(claim.id)
  assert.equal(forgot.ok, true, forgot.error)
  assert.equal(memoryLines().some((line) => line.includes('旧的错误偏好')), false)
  assert.equal(rag.io.readPending().some((item) => item.text.includes('旧的错误偏好')), false)
  assert.equal(ledger.get(claim.id).text, '')

  const at = Date.now()
  const turn = rag.ingestTurn({ user: '旧对话秘密词甲乙丙', assistant: '我记下了', at })
  const chat = noteEvent({ kind: 'chat', user: '旧对话秘密词甲乙丙', reply: '我记下了' }, at, [turn.id])
  assert.equal(appendDiary({ label: '平静', intensity: 0.4 }, '想到旧对话秘密词甲乙丙', { kind: 'inner' }), true)
  const diary = ledger.list().find((entry) => entry.source.type === 'diary-live')
  assert.ok(diary.meta.dependsOn.includes(chat.id))
  assert.equal(flushJournal(), true)
  saveHistory([{ role: 'user', content: '旧对话秘密词甲乙丙' }, { role: 'assistant', content: '我记下了' }], at)
  flushPersist()
  const result = correctExperience(chat.id, '用户更正后的真实说法')
  assert.equal(result.ok, true, result.error)
  assert.equal(ledger.get(chat.id).text, '')
  assert.equal(ledger.get(result.entry.id).text, '用户更正后的真实说法')
  assert.equal(memoryLines().some((line) => line.includes('用户更正后的真实说法')), true)
  assert.equal(readFileSync(join(userData, 'history.json'), 'utf8').includes('旧对话秘密词甲乙丙'), false)
  assert.equal(readFileSync(join(userData, 'ledger', 'entries.jsonl'), 'utf8').includes('旧对话秘密词甲乙丙'), false)
  assert.equal(rag.io.readPending().some((item) => item.text.includes('旧对话秘密词甲乙丙')), false)
  assert.equal(ledger.get(diary.id).text, '')
  assert.equal(new (ledger.constructor)(userData).get(chat.id).text, '')
})
