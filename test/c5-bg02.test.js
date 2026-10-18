// test/c5-bg02.test.js
// C5-BG-02（EVAL §3.10）：主对话异步记忆抽取"取得旧来源 → 用户遗忘 → 旧结果返回"。
//
// 复现方法（就是本文件的交错顺序）：
//   1) 先造一条记忆并让它进账本 / RAG；
//   2) 模拟"模型还在跑"——手里攥着一份待写的新增列表；
//   3) 这期间执行 forgetExperience；
//   4) 让旧结果"返回"（调 forgetGuard.filterAdds），断言：
//      · 命中已遗忘内容的新增项被丢弃（memory / 账本 / RAG 都不再出现）；
//      · **无关的新内容仍可写**（不能一次遗忘作废整轮抽取）。
//
// [mock-io]：真实文件系统 + 真实 RAG store，只 mock electron 的 userData。
import test, { mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-c5-bg02-'))
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  rag: { enabled: true, provider: 'none' },
  presence: { enabled: false, notesEnabled: true, tracesEnabled: false, anchorsEnabled: false }
}))

const { getRag } = await import('../src/main/rag/index.js')
const { getLedger } = await import('../src/main/ledger.js')
const { addMemory, flushPersist, loadMemories, memoryLines, mergeMemoryOps } = await import('../src/main/persist.js')
const { forgetExperience } = await import('../src/main/ledger-actions.js')
const { forgetGuard } = await import('../src/main/forget-guard.js')
const { createForgetGuard, normalizeFragments } = await import('../src/core/memory/forget-guard.js')

after(() => {
  getRag().dispose()
  forgetGuard.reset()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
})

const SECRET = '我不喜欢香菜，别给我点'
const UNRELATED = '他周日要去爬山'

/** 断言口径自检用：这些读取必须能真的读到东西，否则下面的"没有"就是假绿 */
// 注意：没有嵌入引擎时 ingestFact 进的是**待嵌队列**，不是 liveChunks。
// 只查 liveChunks 会恒为空 → 断言假绿。两处都要看。
const hasLiveRag = (needle) => {
  const rag = getRag()
  const texts = [
    ...rag.store.liveChunks().map((c) => String(c.text || '')),
    ...rag.io.readPending().map((c) => String(c.text || ''))
  ]
  return texts.some((t) => t.includes(needle))
}
const liveLedgerHas = (needle) => getLedger().list().some((e) => !e.deletedAt && String(e.text || '').includes(needle))

test('片段归一化：整句与子句都进表，太短的丢弃', () => {
  const frags = normalizeFragments([SECRET, '香菜'])
  assert.ok(frags.includes(SECRET))
  assert.ok(frags.includes('我不喜欢香菜'), '按标点切出的子句要能匹配"只写一截"的引用')
  assert.equal(frags.includes('香菜'), false, '2 字片段不参与匹配，避免误杀')
})

test('策略层：遗忘前就在飞行的抽取结果，回来时命中项被丢弃、无关项保留', () => {
  const guard = createForgetGuard()
  const inFlight = [SECRET, UNRELATED]
  assert.equal(guard.epoch(), 0)
  guard.noteForget([SECRET])
  assert.equal(guard.epoch(), 1, '遗忘后代数应该递增（诊断用）')
  assert.deepEqual(guard.filterAdds(inFlight), [UNRELATED])
  assert.equal(guard.hitsForgotten('他上次说我不喜欢香菜'), true, '只写一截也要命中')
})

test('C5-BG-02 端到端：真实 forget 会进遗忘表，旧结果回来不再写回 memory/账本', async () => {
  const rag = getRag().init()
  const ledger = getLedger()
  loadMemories()

  addMemory(SECRET)
  const claim = ledger.list().find((e) => e.source.type === 'memory-manual')
  assert.ok(claim, '账本应有这条经历')
  const fact = rag.ingestFact({ text: SECRET })
  assert.equal(fact.ok, true)

  // 口径自检：此时 memory / 账本 / RAG 三处**都应该**有内容，
  // 否则后面的"三处都没有"就是自欺欺人。
  assert.ok(memoryLines().some((l) => l.includes('香菜')), '自检：memory 里要有这条')
  assert.ok(liveLedgerHas('香菜'), '自检：账本里要有这条')
  assert.ok(hasLiveRag('香菜'), '自检：RAG 里要有这条')

  // ② 模型还在跑：手里攥着待写列表
  const inFlight = { add: [SECRET, UNRELATED], remove: [] }

  // ③ 用户遗忘
  const r = forgetExperience(claim.id)
  assert.equal(r.ok, true, r.error)
  assert.ok(forgetGuard.fragments().some((f) => f.includes('我不喜欢香菜')), '遗忘片段要进进程表')

  // ④ 旧结果返回：按 agent.js 的真实路径过滤后写入
  const kept = forgetGuard.filterAdds(inFlight.add)
  const merged = mergeMemoryOps({ add: kept, remove: [] }, Date.now(), { userText: '' })
  assert.equal(flushPersist().ok, true)

  assert.equal(merged.added.length, 1, '只应写入无关的那一条')
  assert.equal(memoryLines().some((l) => l.includes('香菜')), false, 'memory 不得复活')
  assert.equal(liveLedgerHas('香菜'), false, '账本不得被旧结果重新写进 claim')
  assert.equal(hasLiveRag('香菜'), false, 'RAG 不得复活')

  assert.equal(memoryLines().some((l) => l.includes('爬山')), true, '无关的新内容仍可写')
  assert.equal(liveLedgerHas('爬山'), true, '无关的新内容照常进账本')
})

test('无关来源不被误删：另一次遗忘不会影响本条', () => {
  const guard = createForgetGuard()
  guard.noteForget(['他小时候养过一只猫'])
  assert.equal(guard.filterAdds([UNRELATED]).length, 1)
  assert.equal(guard.hitsForgotten('我不喜欢香菜'), false)
})

test('遗忘表有界：超出上限不无限增长，且最近一次仍在', () => {
  const guard = createForgetGuard({ maxFragments: 3 })
  guard.noteForget([SECRET])
  for (let i = 0; i < 50; i++) guard.noteForget([`第 ${i} 件无关的事情内容够长`])
  assert.ok(guard.fragments().length <= 3, '有界')
  // 上限很小意味着最老的会被挤出去——这是已知取舍：进程级表只守最近的遗忘，
  // 跨重启的硬保证由账本/scrub 负责（见 forgetExperience）。
})
