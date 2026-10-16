import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperienceLedger } from '../src/core/ledger/store.js'
import { YearbookStore, yearbookMarkdown } from '../src/core/yearbook/store.js'

test('年鉴只收有来源的经历，事实、主观记录和用户创作分层导出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-yearbook-'))
  try {
    const ledger = new ExperienceLedger(dir).load()
    const first = ledger.record({ category: 'experience', text: '他：今天一起讨论了项目。\n我：已经记下。',
      source: { type: 'journal-live', ref: '2026-10-16#1' }, occurredAt: 1792100000000 })
    ledger.record({ category: 'subjective', text: '（心里）这次讨论让我想到新的做法。',
      source: { type: 'diary-live', ref: '2026-10-16#1' },
      meta: { dependsOn: [first.id] } })
    const modelClaim = ledger.record({ category: 'claim', text: '模型说他们去过海边',
      source: { type: 'memory-model', ref: 'hallucination' }, certainty: 'model-inferred' })
    const book = new YearbookStore(dir, ledger).load()
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
    const reopened = new YearbookStore(dir, ledger).load()
    assert.equal(reopened.list().pages[0].note, '我希望以后再读这页。')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('纠错或忘记来源后，年鉴引用与编辑正文都不再导出或留在文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-yearbook-forget-'))
  try {
    const ledger = new ExperienceLedger(dir).load()
    const old = ledger.record({ category: 'experience', text: '错误的共同经历：蓝色彗星',
      source: { type: 'journal-live', ref: 'mistake' }, occurredAt: Date.now() })
    const book = new YearbookStore(dir, ledger).load()
    const added = book.add(old.id)
    book.edit(added.page.id, { title: '旧页', note: '蓝色彗星的用户笔记' })
    ledger.forget(old.id)
    assert.equal(book.list().pages.length, 0)
    assert.equal(book.exportBundle().fragments.length, 0)
    const raw = readFileSync(book.path, 'utf8')
    assert.doesNotMatch(raw, /蓝色彗星/)
    assert.doesNotMatch(yearbookMarkdown(book.exportBundle()), /蓝色彗星/)
    assert.equal(new YearbookStore(dir, ledger).load().list().pages.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
