// test/d1-natural-correction.test.js
// D1 自然语言事实纠错的**数据层撤权**（绿区 2026-10-19 判红的唯一阻断项）。
//
// 真机铁证（ff95ee3a，两 case 一致）：
//   说"我喜欢蓝色" → 等后台抽取写盘 → 自然语言"我喜欢的不是蓝色是绿色"
//   → 凪口头答对，但 memory.json 旧条目与新事实并存、账本旧 claim deletedAt=null、
//     rag/pending.jsonl 旧事实仍在、重启后 system「你记得的关于他的事」仍注入旧值。
// 根因：撤权只靠抽模型在 remove 里**逐字复现**旧条目（mergeMemoryEntries 精确匹配），
// 而 temp=1.3 下模型被纠正时只 add 不 remove，整条撤权链不触发。
//
// 本文件两层：
//   A 纯函数层（core/memory.js）——同属性槽确定性撤权的判据与护栏；
//   B 三层落盘集成层——假抽取只 add 不 remove（精确复现真机）时，
//     memory.json / 账本 / RAG 三处都必须撤权，且失败必须如实可见。
// 全程假模型桩，不依赖真模型。

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  memorySlot,
  supersedeSameSlot,
  mergeMemoryEntries,
  MEMORY_EXTRACT_PROMPT
} from '../src/core/memory.js'

/* ================= A 纯函数层 ================= */

// 真机 memory.json 里的原样条目（color case，绿区证据副本）
const REAL_COLOR_BASE = [
  { id: 'm1', text: '喜欢蓝色', at: 1 },
  { id: 'm2', text: '喜欢蓝色，已由本人确认记录', at: 2 },
  { id: 'm3', text: '住在杭州', at: 3 }
]
// 真机抽取模型被纠正时的真实输出：只有 add，没有 remove
const REAL_COLOR_OPS = { add: ['喜欢的颜色是绿色，已本人更正'], remove: [] }

test('A1 核心回归：假抽取只 add 不 remove 时，同槽旧事实仍确定性撤权（color 真机铁证）', () => {
  const r = mergeMemoryEntries(REAL_COLOR_BASE, REAL_COLOR_OPS, 100)
  assert.deepEqual(r.removed, ['喜欢蓝色', '喜欢蓝色，已由本人确认记录'])
  assert.deepEqual(r.entries.map((e) => e.text), ['住在杭州', '喜欢的颜色是绿色，已本人更正'])
  assert.equal(r.changed, true)
  // 新事实确实进去了（不是只删不加）
  assert.deepEqual(r.added, ['喜欢的颜色是绿色，已本人更正'])
})

test('A2 核心回归：city 真机铁证（杭州→上海）同样撤权', () => {
  const base = [{ id: 'c1', text: '住在杭州', at: 1 }]
  const r = mergeMemoryEntries(base, { add: ['已确认居住在上海'], remove: [] }, 100)
  assert.deepEqual(r.removed, ['住在杭州'])
  assert.deepEqual(r.entries.map((e) => e.text), ['已确认居住在上海'])
})

test('A3 跨槽保护：改颜色不得误删城市（绿区明确要求的第三条）', () => {
  const r = mergeMemoryEntries(REAL_COLOR_BASE, REAL_COLOR_OPS, 100)
  assert.ok(r.entries.some((e) => e.text === '住在杭州'),
    '城市条目与颜色不同槽，绝不能被颜色更正顺手删掉')
  // 反向：改城市也不得误删颜色
  const r2 = mergeMemoryEntries(REAL_COLOR_BASE, { add: ['已确认居住在上海'], remove: [] }, 100)
  assert.ok(r2.entries.some((e) => e.text === '喜欢蓝色'), '颜色条目不得被城市更正删掉')
  assert.ok(r2.entries.some((e) => e.text === '喜欢蓝色，已由本人确认记录'))
})

test('A4 反向：撤权只能来自同槽归并——摘掉它，旧事实必然全活', () => {
  // 真机那次 remove 是空的。也就是说：旧事实能被删，**唯一**的原因就是同槽归并。
  // 这条测试把"撤权来源"钉死：removed 必须与 supersedeSameSlot 的产出逐一对应。
  const victims = supersedeSameSlot(REAL_COLOR_BASE, REAL_COLOR_OPS.add)
  assert.deepEqual(victims, ['喜欢蓝色', '喜欢蓝色，已由本人确认记录'])

  const r = mergeMemoryEntries(REAL_COLOR_BASE, REAL_COLOR_OPS, 100)
  assert.deepEqual([...r.removed].sort(), [...victims].sort(),
    'removed 必须完全由同槽归并产生；哪天多出来或少了，这里立刻红')

  // 若同槽归并被摘掉：supersedeSameSlot 返回空 → merge 只剩模型 remove（真机为空）→ 旧事实全活。
  // 用"add 落在不同槽"来复现那个状态：同样没有 remove，但旧事实一条不动。
  const otherSlot = mergeMemoryEntries(REAL_COLOR_BASE, { add: ['已确认居住在上海'], remove: [] }, 100)
  assert.deepEqual(otherSlot.removed, ['住在杭州'])
  assert.ok(otherSlot.entries.some((e) => e.text === '喜欢蓝色'),
    '换槽时颜色条目必须原样活着——证明删除不是某种"一律清旧"的副作用')
})

test('A5 护栏：同一个值换了个说法，不是改版，不撤', () => {
  const r = mergeMemoryEntries(REAL_COLOR_BASE, { add: ['我喜欢的颜色是蓝色'], remove: [] }, 100)
  assert.deepEqual(r.removed, [], '蓝色→蓝色是同一事实的两种说法，撤了就是白丢信息')
  // 重复陈述同一个值同样不撤
  const r2 = mergeMemoryEntries(REAL_COLOR_BASE, { add: ['喜欢蓝色'], remove: [] }, 100)
  assert.deepEqual(r2.removed, [])
})

test('A6 护栏：不是用户自身属性的条目不撤（"桌宠是蓝色的"）', () => {
  const base = [...REAL_COLOR_BASE, { id: 'm4', text: '桌宠是蓝色的', at: 4 }]
  const r = mergeMemoryEntries(base, REAL_COLOR_OPS, 100)
  assert.ok(r.entries.some((e) => e.text === '桌宠是蓝色的'),
    '桌宠的颜色不是用户的颜色偏好，不能被颜色更正删掉')
})

test('A7 护栏：同值域但不同事不撤（"我穿蓝色衣服" vs "我喜欢红色"）', () => {
  const base = [...REAL_COLOR_BASE, { id: 'm5', text: '我穿蓝色衣服', at: 5 }]
  const r = mergeMemoryEntries(base, { add: ['我喜欢红色'], remove: [] }, 100)
  assert.ok(r.entries.some((e) => e.text === '我穿蓝色衣服'),
    '穿什么颜色的衣服和喜欢什么颜色是两件事，谓词不同不能撤')
  // 但它确实是同槽——所以"住在杭州"依旧安全
  assert.ok(r.entries.some((e) => e.text === '住在杭州'))
})

test('A8 模型 remove 仍是有效补充路径（只是不再是唯一路径）', () => {
  // 模型逐字复现了旧条目 → 照样删（回归：不许因为加了同槽归并就把老路拆了）
  const r = mergeMemoryEntries(REAL_COLOR_BASE, { add: [], remove: ['住在杭州'] }, 100)
  assert.deepEqual(r.removed, ['住在杭州'])
  assert.equal(r.entries.some((e) => e.text === '住在杭州'), false)

  // add + remove 同时来，且两条路指向**不同**条目：必须都删、且不重复计数。
  // 同槽归并抓两条"喜欢蓝色*"（与新增的"喜欢紫色"同槽），模型的 remove 抓"住在杭州"（同槽归并不管它）。
  const r2 = mergeMemoryEntries(REAL_COLOR_BASE, { add: ['喜欢紫色'], remove: ['住在杭州'] }, 100)
  assert.deepEqual([...r2.removed].sort(), ['住在杭州', '喜欢蓝色', '喜欢蓝色，已由本人确认记录'].sort())
  assert.equal(r2.removed.length, new Set(r2.removed).size, '同一条不许被两条路删两次')
  assert.deepEqual(r2.entries.map((e) => e.text), ['喜欢紫色'])
})

test('A9 认不出槽的新事实绝不触发任何撤权', () => {
  const base = [{ id: 'x', text: '养了一只猫', at: 1 }, ...REAL_COLOR_BASE]
  const r = mergeMemoryEntries(base, { add: ['养了一只狗'], remove: [] }, 100)
  assert.deepEqual(r.removed, [], '宠物是可多值属性，故意不收进槽表——否则"养狗"会误删"养猫"')
  assert.equal(r.entries.length, base.length + 1)
})

test('A10 memorySlot：槽识别与"认不出就返回 null"', () => {
  assert.equal(memorySlot('喜欢蓝色'), 'color')
  assert.equal(memorySlot('喜欢的颜色是绿色'), 'color')
  assert.equal(memorySlot('住在杭州'), 'city')
  assert.equal(memorySlot('居住在上海'), 'city')
  assert.equal(memorySlot('他叫阿伟'), 'name')
  assert.equal(memorySlot('生日是三月'), 'birthday')
  assert.equal(memorySlot('在做一款桌宠项目'), 'occupation')
  // 认不出的一律 null —— 认不出就绝不做同槽撤权
  for (const t of ['养猫', '做过一个项目', '最近在学吉他', '', null, '   ']) {
    assert.equal(memorySlot(t), null, `"${t}" 不该被归进任何槽`)
  }
})

test('A11 抽取提示词不再要求模型逐字复现 remove（撤权主路径已确定化）', () => {
  assert.match(MEMORY_EXTRACT_PROMPT, /拿不准就留空数组/)
  assert.doesNotMatch(MEMORY_EXTRACT_PROMPT, /必须与已有记忆原文完全一致/)
  // 明确告诉模型：漏 output remove 也不会让旧事实继续生效
  assert.match(MEMORY_EXTRACT_PROMPT, /即使你不输出 remove/)
})

/* ================= B 三层落盘集成层 ================= */

let userData = mkdtempSync(join(tmpdir(), 'nagi-d1-'))
let ragDir = mkdtempSync(join(tmpdir(), 'nagi-d1-rag-'))
const dirs = [userData, ragDir]

// 账本间谍：忠实模仿 deleteBySource 的语义——**只对真正入过账的来源返回 true**，
// 查无此条与写入失败都返回 false（与 src/core/ledger/store.js 一致）。
const ledgerSpy = { recorded: [], deleted: [], failAll: false, skipRecord: false }
const ledgerSources = new Set()
mock.module('electron', {
  exports: {
    app: { getPath: () => userData },
    // rag/index.js → keystore.js 会 import 这个命名导出；mock 不全会在测试结束后
    // 抛 "Named export 'safeStorage' not found" 的异步噪音。本文件不碰密钥，给个不可用桩。
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
  }
})
mock.module('../src/main/ledger.js', {
  exports: {
    recordLedger: (entry) => {
      if (ledgerSpy.skipRecord) return null // 模拟"这条从未入账"的历史数据
      ledgerSpy.recorded.push(entry)
      if (entry?.source) ledgerSources.add(`${entry.source.type}:${entry.source.ref}`)
      return entry
    },
    deleteLedgerSource: (type, ref) => {
      ledgerSpy.deleted.push({ type, ref })
      if (ledgerSpy.failAll) return false
      return ledgerSources.has(`${type}:${ref}`)
    }
  }
})

const { mergeMemoryOps, loadMemories, flushPersist, removeMemory } = await import('../src/main/persist.js')
const { RagService } = await import('../src/main/rag/index.js')
const { RagStoreIo } = await import('../src/main/rag/store-io.js')
const { makeFactChunk } = await import('../src/core/rag/index.js')

const T = 1792000000000
const readDiskMemories = () => JSON.parse(readFileSync(join(userData, 'memory.json'), 'utf8')).entries

function freshProfile() {
  // 先把上一个 profile 的防抖写落盘并清掉定时器——否则定时器会在目录被删后触发，
  // 打出 "[persist] 防抖写入失败 ENOENT" 的跨用例噪音。
  try { flushPersist() } catch { /* 上一个 profile 可能已经没了 */ }
  userData = mkdtempSync(join(tmpdir(), 'nagi-d1-'))
  ragDir = mkdtempSync(join(tmpdir(), 'nagi-d1-rag-'))
  dirs.push(userData, ragDir)
  ledgerSources.clear()
  ledgerSpy.recorded = []
  ledgerSpy.deleted = []
  ledgerSpy.failAll = false
  ledgerSpy.skipRecord = false
  // persist.js 的 `memories` 是模块级缓存，不会因为换了 userData 目录就重新读盘。
  // 不清空的话上一个 profile 的条目会漏进下一个用例——假绿假红都是它。
  for (const e of loadMemories()) removeMemory({ id: e.id }, { updateLedger: false })
}

function makeRag() {
  const rag = new RagService({
    dir: ragDir,
    getSettings: () => ({ rag: { enabled: true, provider: 'none' } }),
    log: () => {}
  })
  // 不调 init()：本文件要验的是撤权链，不是 RAG 启动；init() 要嵌入引擎，
  // 还会挂一个 boot 定时器去扫队列。ready 置真即可走 forgetText → forget。
  rag.ready = true
  return rag
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('B1 三层撤权：假抽取只 add 不 remove 时，memory/账本/RAG 三处全部落地', (t) => {
  freshProfile()
  // 第一轮：用户说"我喜欢蓝色"，抽取写入（走真实 recordLedger）
  const first = mergeMemoryOps({ add: ['喜欢蓝色'], remove: [] }, T, { userText: '我喜欢蓝色' })
  assert.deepEqual(first.added, ['喜欢蓝色'])
  const oldId = loadMemories().find((e) => e.text === '喜欢蓝色').id
  assert.ok(ledgerSpy.recorded.some((r) => r.source.ref === oldId), '新事实必须入账')

  // 第二轮：自然语言纠正。**精确复现真机 temp=1.3 的输出：只有 add，没有 remove**
  const second = mergeMemoryOps({ add: ['喜欢的颜色是绿色，已本人更正'], remove: [] }, T + 1,
    { userText: '我说错了，我喜欢的不是蓝色是绿色' })
  assert.deepEqual(second.superseded, ['喜欢蓝色'], '同槽旧事实必须被识别为被取代')
  assert.deepEqual(second.removed, ['喜欢蓝色'])
  assert.deepEqual(second.ledgerRevocationFailed, [], '账本撤权不许失败')

  // 腿① memory.json：旧条目不在、新事实在
  flushPersist()
  const onDisk = readDiskMemories()
  assert.equal(onDisk.some((e) => e.text === '喜欢蓝色'), false, 'memory.json 旧条目必须移除')
  assert.ok(onDisk.some((e) => e.text === '喜欢的颜色是绿色，已本人更正'))

  // 腿② 账本：旧 claim 被 deleteLedgerSource（store 内部会置 deletedAt 非空）
  assert.ok(ledgerSpy.deleted.some((d) => d.type === 'memory-model' && d.ref === oldId),
    '账本旧 claim 必须被撤权（deletedAt 非空、留痕可审计）')

  // 腿③ RAG：旧事实的 chunk 进 revoked，且从 pending 里消失。
  // 这里直接走 agent.js 会用的那一步：把 mergeMemoryOps 报出的 removed 原文喂给 forgetText。
  const rag = makeRag()
  rag.io.appendPending([makeFactChunk({ text: '喜欢蓝色', at: T, source: 'memory' })])
  rag.io.appendPending([makeFactChunk({ text: '喜欢的颜色是绿色，已本人更正', at: T + 1, source: 'memory' })])
  assert.equal(rag.io.readPending().length, 2)
  for (const text of second.removed) {
    const r = rag.forgetText(text)
    assert.equal(r.ok, true, `RAG 撤权失败：${text} → ${JSON.stringify(r)}`)
  }
  assert.equal(rag.io.readPending().length, 1, 'pending 里的旧事实必须被清掉（否则嵌进去就复活）')
  assert.equal(rag.io.readPending()[0].text, '喜欢的颜色是绿色，已本人更正', '新事实必须留在档案里')
  assert.equal([...rag.io.readRevoked()].length, 1, '旧 chunk 必须进 revoked')
})

test('B2 RAG 未建索引时（真机隔离 profile 状态）旧事实也不复活', () => {
  freshProfile()
  // 先有旧事实（memory 层写好），再纠正——顺序和真机一致
  mergeMemoryOps({ add: ['喜欢蓝色'], remove: [] }, T, { userText: '我喜欢蓝色' })
  const rag = makeRag()
  rag.io.appendPending([
    makeFactChunk({ text: '喜欢蓝色', at: T, source: 'memory' }),
    makeFactChunk({ text: '住在杭州', at: T, source: 'memory' })
  ])
  assert.equal(rag.io.readPending().length, 2)

  // 同槽撤权给出的 removed 原文，必须能精确对上 pending 里的旧事实
  const merged = mergeMemoryOps({ add: ['喜欢的颜色是绿色，已本人更正'], remove: [] }, T + 1,
    { userText: '我说错了，我喜欢的不是蓝色是绿色' })
  assert.deepEqual(merged.removed, ['喜欢蓝色'])
  for (const text of merged.removed) {
    const r = rag.forgetText(text)
    assert.equal(r.ok, true, `撤权失败：${text} → ${JSON.stringify(r)}`)
  }
  // 跨槽的"住在杭州"没被撤，仍在 pending
  const left = rag.io.readPending()
  assert.equal(left.length, 1)
  assert.equal(left[0].text, '住在杭州')

  // 模拟重启：新 io 读回来，revoked 的不会复活，未撤的还在
  const io2 = new RagStoreIo(ragDir)
  assert.equal(io2.readPending().length, 1)
  assert.equal(io2.readPending()[0].text, '住在杭州')
  assert.equal([...io2.readRevoked()].length, 1)
})

test('B3 RAG 已建索引时，旧 chunk 不再可召回、撤销记录可审计', () => {
  freshProfile()
  const rag = makeRag()
  const dim = 16
  const { store } = rag.io.load(dim)
  rag.store = store
  const chunk = makeFactChunk({ text: '喜欢蓝色', at: T, source: 'memory' })
  const row = store.append(chunk, new Float32Array(dim).fill(0.5))
  rag.io.appendEmbedded(chunk, store.rowVector(row))
  assert.equal(store.liveCount, 1)
  const oldId = chunk.id

  const r = rag.forgetText('喜欢蓝色')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(store.liveCount, 0, '已嵌入的旧 chunk 必须被移除，不再可召回')

  // 持久化的撤销凭据是 revoked.json（compact 会把 chunks.jsonl 里的墓碑行一并压实，
  // 所以可审计凭据不是墓碑行——这里按实际行为断言，不断言一个会被压掉的东西）
  const revokedSet = rag.io.readRevoked() // 本身就是 Set
  assert.equal(revokedSet.size, 1)
  assert.ok(revokedSet.has(oldId), 'revoked.json 必须记下被撤的 chunk id')

  // 重启后再读：旧 chunk 彻底不在活索引里
  // 注意：hasId 才是"活着且可召回"的判据；chunkById 查不到返回 null（不是 undefined），
  // 且墓碑行的原 chunk 仍留在 chunks 数组里可读——所以不能拿 chunkById 当"已消失"的证据。
  const io2 = new RagStoreIo(ragDir)
  const { store: store2 } = io2.load(dim)
  assert.equal(store2.liveCount, 0)
  assert.equal(store2.hasId(oldId), false, '重启后旧 chunk 不得复活（不得回到可召回状态）')
})

test('B4 撤权没落地时如实报失败，不伪报成功（契约第 4 条）', (t) => {
  freshProfile()
  mergeMemoryOps({ add: ['喜欢蓝色'], remove: [] }, T, { userText: '我喜欢蓝色' })
  ledgerSpy.deleted = []
  ledgerSpy.failAll = true // 注入：账本写入全部失败

  const r = mergeMemoryOps({ add: ['喜欢的颜色是绿色，已本人更正'], remove: [] }, T + 1,
    { userText: '我说错了，我喜欢的不是蓝色是绿色' })

  // memory.json 里旧条目是没了，但账本腿没落地 —— 必须如实列出，绝不因为"内存改成功了"就报喜
  assert.deepEqual(r.removed, ['喜欢蓝色'], '同槽撤权本身仍然识别到了')
  assert.deepEqual(r.ledgerRevocationFailed, ['喜欢蓝色'], '账本没撤权必须如实上报，不许静默')
  assert.equal(loadMemories().some((e) => e.text === '喜欢蓝色'), false)
  assert.ok(loadMemories().some((e) => e.text === '喜欢的颜色是绿色，已本人更正'))
})

test('B5 从未入账的旧条目（历史数据）也能被同槽撤权识别', (t) => {
  freshProfile()
  // 造一条"从未入账"的旧记忆：账本间谍这次不记录（模拟老版本写入的记忆/入账失败的残留）
  ledgerSpy.skipRecord = true
  const first = mergeMemoryOps({ add: ['喜欢蓝色'], remove: [] }, T, { userText: '我喜欢蓝色' })
  assert.deepEqual(first.added, ['喜欢蓝色'], '记忆本身写进去了')
  assert.equal(ledgerSpy.recorded.length, 0, '这条确实没入账')
  ledgerSpy.skipRecord = false
  ledgerSpy.deleted = []

  const r = mergeMemoryOps({ add: ['喜欢的颜色是绿色，已本人更正'], remove: [] }, T + 1,
    { userText: '我说错了，我喜欢的不是蓝色是绿色' })
  assert.deepEqual(r.removed, ['喜欢蓝色'], '同槽撤权不依赖账本有没有记录')
  // 没入过账 → deleteLedgerSource 返回 false → 如实标为未撤权
  // （可能是查无此条，也可能是写入失败，这里不猜，只如实上报）
  assert.deepEqual(r.ledgerRevocationFailed, ['喜欢蓝色'])
  assert.equal(loadMemories().some((e) => e.text === '喜欢蓝色'), false)
  assert.ok(loadMemories().some((e) => e.text === '喜欢的颜色是绿色，已本人更正'))
})
