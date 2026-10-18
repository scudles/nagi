import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { ExperienceLedger } from '../src/core/ledger/store.js'
import { YearbookStore, YEARBOOK_PAGES_KEY, yearbookMarkdown } from '../src/core/yearbook/store.js'
import { realRecordPorts, realYearbookPorts, failingPorts, counterRng, tempDir } from './helpers/store-ports.js'

const ENOENT = () => Object.assign(new Error("ENOENT: no such file or directory, open '.../missing-parent/pages.json'"), { code: 'ENOENT' })

test('年鉴只收有来源的经历，事实、主观记录和用户创作分层导出', () => {
  const dir = tempDir('.nagi-yearbook-test-')
  try {
    const ledger = new ExperienceLedger(realRecordPorts(dir)).load()
    const first = ledger.record({ category: 'experience', text: '他：今天一起讨论了项目。\n我：已经记下。',
      source: { type: 'journal-live', ref: '2026-10-16#1' }, occurredAt: 1792100000000 })
    ledger.record({ category: 'subjective', text: '（心里）这次讨论让我想到新的做法。',
      source: { type: 'diary-live', ref: '2026-10-16#1' },
      meta: { dependsOn: [first.id] } })
    const modelClaim = ledger.record({ category: 'claim', text: '模型说他们去过海边',
      source: { type: 'memory-model', ref: 'hallucination' }, certainty: 'model-inferred' })
    const openBook = () => new YearbookStore({ ...realYearbookPorts(dir), ledger }).load()
    const book = openBook()
    assert.equal(book.add(modelClaim.id).ok, false)
    const added = book.add(first.id)
    assert.equal(added.ok, true)
    assert.equal(added.page.fact.text, first.text)
    assert.equal(added.page.subjective[0].tier, 'subjective')
    assert.equal(book.edit(added.page.id, { title: '我们的讨论', note: '我希望以后再读这页。' }).ok, true)
    const markdown = yearbookMarkdown(book.exportBundle())
    assert.match(markdown, /有来源的真实记录/)
    assert.match(markdown, /凪的主观记录/)
    assert.match(markdown, /用户编辑 \/ 创作/)
    assert.match(markdown, /经历 ID：e_/)
    assert.doesNotMatch(markdown, /海边/)
    assert.equal(book.list().fragments[0].triggerSourceId, first.id)
    const reopened = openBook()
    assert.equal(reopened.list().pages[0].note, '我希望以后再读这页。')
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不算测试失败 */ } }
})

test('纠错或忘记来源后，年鉴引用与编辑正文都不再导出或留在文件', () => {
  const dir = tempDir('.nagi-yearbook-forget-')
  try {
    const ports = realYearbookPorts(dir)
    const ledger = new ExperienceLedger(realRecordPorts(dir)).load()
    const old = ledger.record({ category: 'experience', text: '错误的共同经历：蓝色彗星',
      source: { type: 'journal-live', ref: 'mistake' }, occurredAt: 1000 })
    const book = new YearbookStore({ ...ports, ledger }).load()
    const added = book.add(old.id)
    book.edit(added.page.id, { title: '旧页', note: '蓝色彗星的用户笔记' })
    ledger.forget(old.id)
    assert.equal(book.list().pages.length, 0)
    assert.equal(book.exportBundle().fragments.length, 0)
    assert.doesNotMatch(ports.io.read(YEARBOOK_PAGES_KEY) ?? '', /蓝色彗星/)
    assert.doesNotMatch(yearbookMarkdown(book.exportBundle()), /蓝色彗星/)
    assert.equal(new YearbookStore({ ...ports, ledger }).load().list().pages.length, 0)
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不算测试失败 */ } }
})

test('年鉴写盘失败不会在内存中假装已收录或已编辑', () => {
  const dir = tempDir('.nagi-yearbook-disk-')
  try {
    const ledger = new ExperienceLedger(realRecordPorts(dir)).load()
    const source = ledger.record({ category: 'experience', text: '真实的一次对话',
      source: { type: 'journal-live', ref: 'disk-failure' }, occurredAt: 1000 })
    const healthy = realYearbookPorts(dir)
    const openBook = (ports) => new YearbookStore({ ...ports, ledger }).load()
    const book = openBook(healthy)
    // B7：失败注入不再靠"把内部 path 改到不存在的目录"，而是直接让端口拒绝写
    assert.throws(() => openBook({ ...healthy, io: failingPorts(healthy.io, { write: ENOENT() }) }).add(source.id), /ENOENT/)
    assert.equal(book.list().pages.length, 0)
    const added = book.add(source.id)
    const broken = openBook({ ...healthy, io: failingPorts(healthy.io, { write: ENOENT() }) })
    assert.throws(() => broken.edit(added.page.id, { title: '并未写成', note: '并未保存' }), /ENOENT/)
    assert.equal(book.list().pages[0].title, added.page.title)
    assert.equal(openBook(healthy).list().pages[0].note, '')
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不算测试失败 */ } }
})

test('注入时钟与随机数：年鉴的时间戳与 id 完全由外部决定', () => {
  const dir = tempDir('.nagi-yearbook-clock-')
  try {
    let now = 4000
    const rng = counterRng('page')
    const ledger = new ExperienceLedger(realRecordPorts(dir)).load()
    const fact = ledger.record({ category: 'experience', text: '一次散步',
      source: { type: 'journal-live', ref: 'walk' }, occurredAt: 3000 })
    const book = new YearbookStore({ ...realYearbookPorts(dir), now: () => now, rng, ledger }).load()
    const added = book.add(fact.id)
    assert.equal(added.page.id, 'page-1')
    assert.equal(added.page.createdAt, 4000)
    now = 8000
    const edited = book.edit(added.page.id, { note: '后补的注' })
    assert.equal(edited.page.updatedAt, 8000)
    assert.equal(edited.page.createdAt, 4000, '编辑不该改写创建时间')
    assert.equal(book.exportBundle().exportedAt, 8000)
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不算测试失败 */ } }
})
