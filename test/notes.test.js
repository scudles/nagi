// test/notes.test.js
// BLUE-3 环境留痕回归锁：便签候选（笔记）+ 行动留痕（traces）。
//   · 便签：只从三类可信事实生成、幂等、每日≤3、间隔≥30min、勿扰/只陪着不展示、默认关闭；
//     正文不虚构（模拟活动必须带 provenance:'simulation'，动作类不得说「帮你做好了」）。
//   · 留痕：规范化只留白名单字段（丢掉 args/stdout/二进制）、240 字截断、按 id 幂等、
//     条数与天数上限、completionVerified 恒 false、引用措辞不冒充外部成功。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTES_LIMITS,
  emptyNoteState,
  normalizeNoteState,
  humanDuration,
  noteFromEvent,
  considerNote
} from '../src/core/presence/notes.js'
import {
  TRACE_LIMITS,
  normalizeActionTrace,
  appendTrace,
  normalizeTraceList,
  traceReference
} from '../src/core/presence/traces.js'

const T0 = Date.UTC(2026, 9, 17, 1, 0, 0) // 2026-10-17 01:00 UTC
const MIN = 60 * 1000

/* ---------------- 便签：正文不虚构 ---------------- */

test('活动便签：只由类型+时长推出，标 simulation 并带 activityId', () => {
  const note = noteFromEvent({
    kind: 'activity',
    event: { id: 'a1', type: 'simulated-reading', startedAt: T0, endedAt: T0 + 20 * MIN }
  })
  assert.equal(note.noteKind, 'activity')
  assert.equal(note.provenance, 'simulation')
  assert.equal(note.activityId, 'a1')
  assert.match(note.text, /20 分钟/)
  assert.doesNotMatch(note.text, /帮你|已经|真实/, '不得写成真实外界经历或已完成的事')
})

test('活动便签：类型未知 / 缺结束时间 / 缺 id 一律不生成', () => {
  assert.equal(noteFromEvent({ kind: 'activity', event: { id: 'a', type: 'unknown', startedAt: T0, endedAt: T0 + MIN } }), null)
  assert.equal(noteFromEvent({ kind: 'activity', event: { id: 'a', type: 'quiet-wait', startedAt: T0 } }), null)
  assert.equal(noteFromEvent({ kind: 'activity', event: { type: 'quiet-wait', startedAt: T0, endedAt: T0 + MIN } }), null)
})

test('归来便签：只说离开多久，绝不推断用户去了哪里', () => {
  const note = noteFromEvent({ kind: 'reunion', event: { id: 'r1', tier: 'minutes', durationMs: 12 * MIN, at: T0 } })
  assert.equal(note.noteKind, 'reunion')
  assert.match(note.text, /12 分钟/)
  for (const bad of ['去', '外面', '公司', '吃饭', '睡觉']) assert.doesNotMatch(note.text, new RegExp(bad))
})

test('行动便签：只说跑过/返回，外部效果明确声明未核实', () => {
  const ok = noteFromEvent({ kind: 'action', event: { id: 't1', tool: 'file_list', status: 'returned', at: T0 } })
  assert.equal(ok.completionVerified, false)
  assert.match(ok.text, /file_list/)
  assert.match(ok.text, /没有核实/)
  assert.doesNotMatch(ok.text, /帮你做好了|已完成/)
  const failed = noteFromEvent({ kind: 'action', event: { id: 't2', tool: 'run_command', status: 'failed', at: T0 } })
  assert.match(failed.text, /失败/)
})

test('humanDuration：分钟 / 小时 / 天', () => {
  assert.equal(humanDuration(90 * 1000), '2 分钟') // 至少 1 分钟，四舍五入
  assert.equal(humanDuration(12 * MIN), '12 分钟')
  assert.equal(humanDuration(95 * MIN), '1 小时 35 分钟')
  assert.equal(humanDuration(3 * 24 * 60 * MIN), '3 天')
})

/* ---------------- 便签：门与配额 ---------------- */

const ACTIVITY = (id, at = T0) => ({ kind: 'activity', event: { id, type: 'quiet-wait', startedAt: at, endedAt: at + 10 * MIN } })

test('默认关闭：不产生任何候选', () => {
  const r = considerNote({ ...ACTIVITY('a1'), now: T0, state: emptyNoteState(T0), config: { notesEnabled: false }, privacy: {} })
  assert.equal(r.note, null)
  assert.equal(r.reason, 'disabled')
})

test('勿扰与只陪着：都不展示', () => {
  for (const privacy of [{ doNotDisturb: true }, { onlyPresence: true }]) {
    const r = considerNote({ ...ACTIVITY('a1'), now: T0, state: emptyNoteState(T0), config: { notesEnabled: true }, privacy })
    assert.equal(r.note, null)
    assert.equal(r.reason, 'do-not-disturb')
  }
})

test('同一事件 ID 幂等：第二次不再出', () => {
  const first = considerNote({ ...ACTIVITY('a1'), now: T0, state: emptyNoteState(T0), config: { notesEnabled: true }, privacy: {} })
  assert.equal(first.reason, 'accepted')
  const second = considerNote({ ...ACTIVITY('a1'), now: T0 + 40 * MIN, state: first.state, config: { notesEnabled: true }, privacy: {} })
  assert.equal(second.reason, 'duplicate')
  assert.equal(second.note, null)
})

test('间隔不足 30 分钟：不出（不排队、不积压）', () => {
  const first = considerNote({ ...ACTIVITY('a1'), now: T0, state: emptyNoteState(T0), config: { notesEnabled: true }, privacy: {} })
  const soon = considerNote({ ...ACTIVITY('a2'), now: T0 + 29 * MIN, state: first.state, config: { notesEnabled: true }, privacy: {} })
  assert.equal(soon.reason, 'too-soon')
  assert.equal(soon.note, null)
  assert.deepEqual(soon.state, first.state, '被拒时状态不变')
  const ok = considerNote({ ...ACTIVITY('a2'), now: T0 + 31 * MIN, state: first.state, config: { notesEnabled: true }, privacy: {} })
  assert.equal(ok.reason, 'accepted')
})

test('每天最多 3 条，第 4 条被拒；跨本地日期重置', () => {
  let state = emptyNoteState(T0)
  let at = T0
  for (let i = 1; i <= NOTES_LIMITS.perDay; i++) {
    const r = considerNote({ ...ACTIVITY('a' + i), now: at, state, config: { notesEnabled: true }, privacy: {} })
    assert.equal(r.reason, 'accepted', `第 ${i} 条应被接受`)
    state = r.state
    at += 31 * MIN
  }
  const fourth = considerNote({ ...ACTIVITY('a4'), now: at, state, config: { notesEnabled: true }, privacy: {} })
  assert.equal(fourth.reason, 'daily-limit')
  // 第二天：计数重置（本地日期变了即可）
  const tomorrow = at + 24 * 60 * MIN
  const next = considerNote({ ...ACTIVITY('a5'), now: tomorrow, state: fourth.state, config: { notesEnabled: true }, privacy: {} })
  assert.equal(next.reason, 'accepted')
})

test('状态规范化：脏数据不炸，seen 截断', () => {
  const s = normalizeNoteState({ dayKey: 42, count: -3, lastAt: 'x', seen: [1, 'a', null, 'b'] }, T0)
  assert.equal(typeof s.dayKey, 'string')
  assert.equal(s.count, 0)
  assert.equal(s.lastAt, 0)
  assert.deepEqual(s.seen, ['a', 'b'])
  const many = normalizeNoteState({ seen: Array.from({ length: NOTES_LIMITS.seenMax + 50 }, (_, i) => 'x' + i) }, T0)
  assert.equal(many.seen.length, NOTES_LIMITS.seenMax)
})

/* ---------------- 行动留痕 ---------------- */

test('留痕规范化：只留白名单字段，args/stdout/二进制进不来', () => {
  const t = normalizeActionTrace({
    kind: 'action-trace', version: 1, id: 'x1', at: T0, turnRef: 'r', toolCallId: 'c', tool: 'file_write',
    ok: true, status: 'returned', completionVerified: true, // 上游乱写也会被压回 false
    result: { summary: '工具已返回，外部效果未核实', stdout: 'SSB...', bytes: [1, 2, 3] },
    args: { path: 'C:/secret', content: 'x'.repeat(5000) }
  })
  assert.equal(t.completionVerified, false)
  assert.equal(t.provenance, 'action')
  assert.equal(t.canReference, true)
  assert.deepEqual(Object.keys(t.result), ['summary'])
  assert.equal('args' in t, false)
})

test('留痕规范化：缺 id/tool 丢弃；status 非法按 ok 推断；摘要截断 240', () => {
  assert.equal(normalizeActionTrace({ tool: 'a', id: '' }, T0), null)
  assert.equal(normalizeActionTrace({ tool: '', id: 'a' }, T0), null)
  assert.equal(normalizeActionTrace(null, T0), null)
  const inferred = normalizeActionTrace({ id: 'a', tool: 'x', ok: false, status: 'weird' }, T0)
  assert.equal(inferred.status, 'failed')
  const long = normalizeActionTrace({ id: 'b', tool: 'x', status: 'returned', result: { summary: 'д'.repeat(500) } }, T0)
  assert.equal(long.result.summary.length, TRACE_LIMITS.summaryMax)
})

test('留痕追加：按 id 幂等、超上限丢最早、过期清理', () => {
  let list = []
  for (let i = 0; i < 5; i++) {
    list = appendTrace(list, normalizeActionTrace({ id: 'i' + i, tool: 'x', status: 'returned', at: T0 + i * 1000 }, T0), { max: 3, now: T0 }).list
  }
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((t) => t.id), ['i2', 'i3', 'i4'])
  const dup = appendTrace(list, normalizeActionTrace({ id: 'i4', tool: 'x', at: T0 }, T0), { now: T0 })
  assert.equal(dup.added, false)
  assert.equal(dup.list.length, 3)
  // 8 天前的记录在追加时被清掉
  const old = normalizeActionTrace({ id: 'old', tool: 'x', at: T0 - 8 * 86400000 }, T0)
  const withOld = appendTrace([old], normalizeActionTrace({ id: 'new', tool: 'y', at: T0 }, T0), { now: T0 }).list
  assert.deepEqual(withOld.map((t) => t.id), ['new'])
})

test('留痕列表规范化：非法项丢弃、去重', () => {
  const list = normalizeTraceList([{ id: 'a', tool: 'x', at: T0 }, { tool: 'y' }, null, { id: 'a', tool: 'x', at: T0 }], { now: T0 })
  assert.equal(list.length, 1)
})

test('引用措辞：不冒充「已经帮你做好了」', () => {
  const t = normalizeActionTrace({ id: 'a', tool: 'file_write', status: 'returned', at: T0 }, T0)
  const ref = traceReference(t)
  assert.equal(ref.trust, 'observed')
  assert.equal(ref.completionVerified, false)
  assert.match(ref.text, /外部效果没有核实/)
  assert.doesNotMatch(ref.text, /已经帮你|完成/)
  assert.equal(traceReference(null), null)
})
