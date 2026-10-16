import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromiseBook } from '../src/core/promises/book.js'

const withBook = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-promises-'))
  try { return fn(new PromiseBook(dir), dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('承诺簿持久化区分通知发出与用户确认完成', () => withBook((book, dir) => {
  book.create({ id: 'reminder:a', kind: 'reminder', title: '喝水', source: { type: 'reminder' }, dueAt: 123 })
  assert.throws(() => book.transition('reminder:a', 'completed'), /证据/)
  assert.throws(() => book.transition('reminder:a', 'delivered'), /证据/)
  book.transition('reminder:a', 'delivered', { kind: 'notification-dispatched' }, 200)
  const restored = new PromiseBook(dir).load()
  assert.equal(restored.get('reminder:a').status, 'delivered')
  restored.transition('reminder:a', 'completed', { kind: 'user-confirmation' }, 300)
  assert.equal(new PromiseBook(dir).load().get('reminder:a').status, 'completed')
  assert.throws(() => restored.updateDueAt('reminder:a', 400), /不能重新排期/)
}))

test('重启后中断的尝试只能成为结果未知，不会被算完成', () => withBook((book, dir) => {
  book.create({ id: 'tool:a', kind: 'agent-tool', title: '打开应用', source: { type: 'agent-tool' } })
  book.transition('tool:a', 'attempting', { kind: 'execution-started' })
  const restored = new PromiseBook(dir).load().get('tool:a')
  assert.equal(restored.status, 'attempted')
  assert.equal(restored.evidence.at(-1).kind, 'interrupted-on-restart')
  assert.equal(JSON.parse(readFileSync(join(dir, 'promises.json'), 'utf8')).entries[0].status, 'attempted')
}))

test('重复承诺重新排期保留之前的通知证据', () => withBook((book) => {
  book.create({ id: 'reminder:b', kind: 'reminder', title: '吃饭', source: { type: 'reminder' }, dueAt: 100 })
  book.transition('reminder:b', 'delivered', { kind: 'notification-dispatched' }, 200)
  const next = book.updateDueAt('reminder:b', 400, 200)
  assert.equal(next.status, 'scheduled')
  assert.equal(next.dueAt, 400)
  assert.equal(next.evidence.length, 1)
}))
