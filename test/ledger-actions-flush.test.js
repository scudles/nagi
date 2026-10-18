// B01 续：ledger-actions 的"伪报成功"修复回归。
// 场景：用户点"忘记/纠错"→ 六个下游清理完成 → flushPersist 写盘失败。
// 旧行为：不检查 flush 结果，ledger.forget/correct 照常执行并返回 {ok:true}——
// 用户以为已忘记，重启后旧内容复活。新行为：flush 失败即抛错，账本状态不动，返回 {ok:false}。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-la-flush-'))
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  // ledger-actions 现在会经 presence-notes 清理便签，而 presence-notes → notes-file
  // 在导入期就要 dialog。mock 必须补齐实际用到的导出，否则 ESM 链接期直接失败。
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ rag: { enabled: true, provider: 'none' } }))

// persist 真身引进来，只把 flushPersist 换成"写盘失败"的桩；其余（addMemory 等）保持真实
const realPersist = await import('../src/main/persist.js')
let flushShouldFail = false
mock.module('../src/main/persist.js', { exports: {
  ...realPersist,
  flushPersist: () => (flushShouldFail
    ? { ok: false, written: [], failed: [{ file: 'memory.json', error: '替换失败：EPERM: injected' }] }
    : realPersist.flushPersist())
} })

const { getRag } = await import('../src/main/rag/index.js')
const { getLedger } = await import('../src/main/ledger.js')
const { addMemory } = await import('../src/main/persist.js')
const { correctExperience, forgetExperience } = await import('../src/main/ledger-actions.js')

test.after(() => {
  getRag().dispose()
  rmSync(userData, { recursive: true, force: true })
})

test('flush 失败时 forgetExperience 返回 ok:false，且账本状态保持原样（可重试）', () => {
  const rag = getRag().init()
  const ledger = getLedger()
  addMemory('一条不该被忘记却落不了盘的记忆')
  const claim = ledger.list().find((entry) => entry.source.type === 'memory-manual' && entry.text === '一条不该被忘记却落不了盘的记忆')
  assert.ok(claim, '账本里应有这条 manual 记录')
  const textBefore = ledger.get(claim.id).text

  flushShouldFail = true
  const r = forgetExperience(claim.id)
  flushShouldFail = false
  assert.equal(r.ok, false)
  assert.match(r.error, /未完全落盘/)
  // 账本状态未被改写：正文还在、未标记删除——用户重试还能继续
  assert.equal(ledger.get(claim.id).text, textBefore)
  assert.equal(ledger.get(claim.id).deletedAt, null)
  assert.equal(rag.ready, true)
})

test('flush 失败时 correctExperience 返回 ok:false，更正内容不入账', () => {
  const rag = getRag().init()
  const ledger = getLedger()
  const at = Date.now()
  rag.ingestTurn({ user: '原来的说法', assistant: '好', at })
  const entry = ledger.record({ category: 'experience', text: '他：原来的说法\n我：好',
    source: { type: 'chat', ref: `flush-fail-${at}` }, occurredAt: at })
  assert.ok(entry)

  flushShouldFail = true
  const r = correctExperience(entry.id, '更正后的说法')
  flushShouldFail = false
  assert.equal(r.ok, false)
  assert.match(r.error, /未完全落盘/)
  // 账本里还是原文，没有 correctedAt
  const after = ledger.get(entry.id)
  assert.equal(after.text, '他：原来的说法\n我：好')
  assert.equal(after.correctedAt, null)
})

test('flush 成功时 forgetExperience 照常放行（证明失败分支不是"永远失败"）', () => {
  const ledger = getLedger()
  addMemory('这条可以正常忘记')
  const claim = ledger.list().find((entry) => entry.source.type === 'memory-manual' && entry.text === '这条可以正常忘记')
  assert.ok(claim)
  const r = forgetExperience(claim.id)
  assert.equal(r.ok, true, r.error)
  assert.equal(ledger.get(claim.id).text, '') // 物理重写抹除正文
})
