// test/journal.test.js
// 事件流水（core/journal.js）单测：日期键、归一化、追加上限、人话格式化、过期清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JOURNAL, dateKey, hhmm, normalizeEntries, appendEntry, eventLine, pruneOld } from '../src/core/journal.js'

test('dateKey / hhmm 输出本地时间格式', () => {
  const t = new Date(2026, 9, 15, 0, 48).getTime()
  assert.equal(dateKey(t), '2026-10-15')
  assert.equal(hhmm(t), '00:48')
  assert.equal(hhmm(new Date(2026, 9, 15, 9, 5).getTime()), '09:05')
})

test('normalizeEntries 丢掉形状不对的条目并截断长文本', () => {
  const long = 'x'.repeat(200)
  const out = normalizeEntries([
    { t: 1, kind: 'chat', user: long, reply: 'ok' },
    { t: 2, kind: '' }, // 没 kind
    { kind: 'poke' }, // 没时间戳
    null,
    'nope'
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'chat')
  assert.ok(out[0].user.length <= JOURNAL.MAX_TEXT + 1) // 截断 + 省略号
})

test('appendEntry 是纯函数：返回新数组、保持顺序、超上限丢最旧', () => {
  const base = []
  const a = appendEntry(base, { t: 1, kind: 'poke' }, 2)
  const b = appendEntry(a, { t: 2, kind: 'poke' }, 2)
  const c = appendEntry(b, { t: 3, kind: 'poke' }, 2)
  assert.equal(base.length, 0, '原数组不该被改')
  assert.deepEqual(c.map((e) => e.t), [2, 3])
  // 非法输入原样返回
  assert.equal(appendEntry(a, null), a)
  assert.equal(appendEntry(a, { kind: '' }), a)
})

test('eventLine：每种事件都能写成一句人话', () => {
  const t = new Date(2026, 9, 14, 23, 10).getTime()
  assert.match(eventLine({ t, kind: 'chat', user: '帮我看看这个报错', reply: '……贴上来。' }), /^23:10 他：帮我看看这个报错 ／ 我：/)
  assert.match(eventLine({ t, kind: 'proactive', text: '……坐太久了。' }), /^23:10 我忍不住开了口：/)
  assert.match(eventLine({ t, kind: 'reminder', text: '明早九点开会' }), /^23:10 我提醒他：明早九点开会/)
  assert.match(eventLine({ t, kind: 'poke' }), /^23:10 他戳了戳我/)
  assert.equal(eventLine({ t, kind: 'chat', user: '', reply: '' }), '')
  assert.equal(eventLine(null), '')
})

test('pruneOld 只挑出保留期之外的日期（旧→新）', () => {
  const now = new Date(2026, 9, 15, 12, 0).getTime()
  const dates = ['2026-10-15', '2026-10-14', '2026-10-07', '2026-10-01', 'bad']
  const dead = pruneOld(dates, now, 7)
  assert.deepEqual(dead, ['2026-10-01', '2026-10-07'])
})
