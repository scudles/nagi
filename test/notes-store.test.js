// test/notes-store.test.js
// BLUE-3 主进程业务层：默认关闭不落盘、开启后记录、来源被忘记即撤回、关闭即删文件、上限清理。
// 以及扩展接线：install 订阅两条通道、dispose 注销、开关全关时不产生任何记录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'nagi-notes-'))
let preset = {
  presence: { notesEnabled: false, tracesEnabled: false, anchorsEnabled: false },
  privacy: { doNotDisturb: false, onlyPresence: false }
}

mock.module('electron', { exports: { app: { getPath: () => dir } } })
mock.module('../src/main/settings-store.js', { exports: { getSettings: () => preset } })
mock.module('../src/main/persist.js', {
  exports: {
    listMemories: () => [{ id: 'mem-1', text: '他让我叫他阿凪', provenance: 'user-stated', at: T0 }],
    loadRelationStats: () => ({ firstMetAt: T0 - 30 * 86400000, interactionCount: 200, activeDays: [], lastActiveDay: null })
  }
})
mock.module('../src/main/promises.js', {
  exports: { getPromiseBook: () => ({ list: () => [{ id: 'p1', title: '记得提醒他喝水', at: T0 }] }) }
})

const T0 = Date.UTC(2026, 9, 17, 4, 0, 0)
const MIN = 60 * 1000
const FILE = join(dir, 'notes.json')

const store = await import('../src/main/presence-notes.js')
const ext = await import('../src/main/extensions/traces.js')

const activity = (id, at = T0) => ({ kind: 'activity', at, activity: { id, type: 'quiet-wait', startedAt: at, endedAt: at + 10 * MIN } })
const trace = (id, at = T0) => ({ kind: 'action-trace', version: 1, id, at, tool: 'file_list', ok: true, status: 'returned', completionVerified: false, result: { summary: '工具已返回，外部效果未核实' } })

function setFlags(flags) {
  preset = { ...preset, presence: { notesEnabled: false, tracesEnabled: false, anchorsEnabled: false, ...flags } }
}

test('默认关闭：不读盘、不建文件、记录为空', () => {
  store.clearNotes()
  setFlags({})
  const view = store.listNotes(T0)
  assert.deepEqual(view.enabled, { notes: false, traces: false, anchors: false })
  assert.equal(view.externalWriteAvailable, false, '外部写入未实现，必须如实说明')
  assert.deepEqual(view.notes, [])
  assert.deepEqual(view.traces, [])
  store.recordPresenceEvent(activity('a0'), T0)
  store.recordActionTrace(trace('t0'), T0)
  assert.deepEqual(store.listNotes(T0).notes, [])
  assert.equal(existsSync(FILE), false, '关闭时不得创建文件')
})

test('开启便签：活动事件 → 便签入库并落盘', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true })
  const note = store.recordPresenceEvent(activity('a1'), T0)
  assert.ok(note && note.noteKind === 'activity')
  assert.equal(note.provenance, 'simulation')
  const view = store.listNotes(T0)
  assert.equal(view.notes.length, 1)
  assert.ok(view.notes[0].text.includes('10 分钟'))
  assert.equal(existsSync(FILE), true)
  const raw = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.notes.length, 1)
})

test('幂等与间隔：同一事件不重复，间隔不足不追加', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true })
  store.recordPresenceEvent(activity('a1'), T0)
  store.recordPresenceEvent(activity('a1'), T0 + MIN)
  assert.equal(store.listNotes(T0).notes.length, 1)
  store.recordPresenceEvent(activity('a2'), T0 + 5 * MIN)
  assert.equal(store.listNotes(T0).notes.length, 1, '间隔不足 30 分钟不应追加')
  store.recordPresenceEvent(activity('a3'), T0 + 31 * MIN)
  assert.equal(store.listNotes(T0).notes.length, 2)
})

test('勿扰：不产生便签（但设置仍开着）', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true })
  preset = { ...preset, privacy: { doNotDisturb: true, onlyPresence: false } }
  assert.equal(store.recordPresenceEvent(activity('a9'), T0), null)
  assert.deepEqual(store.listNotes(T0).notes, [])
  preset = { ...preset, privacy: { doNotDisturb: false, onlyPresence: false } }
})

test('行动留痕：tracesEnabled 入库，摘要不冒充外部成功；notesEnabled 时同时出一张便签', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true, tracesEnabled: true })
  store.recordActionTrace(trace('t1'), T0)
  const view = store.listNotes(T0)
  assert.equal(view.traces.length, 1)
  assert.equal(view.traces[0].tool, 'file_list')
  assert.equal(view.traces[0].status, 'returned')
  assert.ok(!/已经帮你|完成/.test(view.traces[0].summary))
  assert.equal(view.notes.length, 1)
  assert.ok(view.notes[0].text.includes('没有核实'))
})

test('只开留痕、不开便签：只入 traces，不出便签', () => {
  store.clearNotes()
  setFlags({ tracesEnabled: true })
  store.recordActionTrace(trace('t2'), T0)
  const view = store.listNotes(T0)
  assert.equal(view.traces.length, 1)
  assert.deepEqual(view.notes, [])
})

test('来源被忘记 → 派生便签跟着撤回', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true })
  store.recordPresenceEvent(activity('a1'), T0)
  assert.equal(store.listNotes(T0).notes.length, 1)
  const r = store.recordPresenceEvent({ kind: 'activity-forgotten', id: 'a1', at: T0 + MIN }, T0 + MIN)
  assert.deepEqual(r, { withdrawn: 1 })
  assert.deepEqual(store.listNotes(T0 + MIN).notes, [])
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).notes.length, 0)
})

test('三个开关全关 → 清内存并删除文件', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true, tracesEnabled: true })
  store.recordPresenceEvent(activity('a1'), T0)
  store.recordActionTrace(trace('t1'), T0)
  assert.equal(existsSync(FILE), true)
  setFlags({})
  const r = store.syncNotesSettings(T0 + MIN)
  assert.equal(r.enabled, false)
  assert.equal(r.removed, true)
  assert.equal(existsSync(FILE), false)
  assert.deepEqual(store.listNotes(T0 + MIN).notes, [])
  assert.deepEqual(store.listNotes(T0 + MIN).traces, [])
})

test('上限：便签条数不超过 maxNotes，且只留 keepDays 内', () => {
  store.clearNotes()
  setFlags({ notesEnabled: true })
  let at = T0
  // 15 天 × 每天 3 条（间隔 31 分钟）→ 45 条，应被上限与天数裁到 ≤30
  for (let d = 0; d < 15; d++) {
    for (let i = 0; i < 3; i++) {
      store.recordPresenceEvent(activity(`d${d}-${i}`, at), at)
      at += 31 * MIN
    }
    at += 24 * 60 * MIN - 3 * 31 * MIN
  }
  const view = store.listNotes(at)
  assert.ok(view.notes.length <= store.NOTES_STORE_LIMITS.maxNotes, `实际 ${view.notes.length}`)
  const cutoff = at - store.NOTES_STORE_LIMITS.keepDays * 86400000
  assert.ok(view.notes.every((n) => n.at >= cutoff), '不得留下超出保留天数的便签')
})

test('回忆物：默认关不给；开启后聚合来源并过熟悉度门槛', () => {
  setFlags({ anchorsEnabled: false })
  assert.deepEqual(store.listAnchorCandidates(T0).anchors, [])
  setFlags({ anchorsEnabled: true })
  const view = store.listAnchorCandidates(T0)
  assert.ok(view.anchors.length >= 2, '应聚合出第一次见面 + 记忆锚点')
  assert.ok(view.anchors.every((a) => a.sourceIds.length > 0))
  // 记忆里有「叫」→ 归为称呼类（私密锚点），当前熟悉度需要达到 familiar
  assert.ok(['stranger', 'acquaintance', 'familiar', 'close', 'intimate'].includes(view.level))
  const kinds = view.anchors.map((a) => a.kind)
  assert.ok(kinds.includes('first-contact'))
  if (view.level === 'stranger' || view.level === 'acquaintance') {
    assert.equal(kinds.includes('nickname'), false, '熟悉度不足时不得出现私密锚点')
  }
})

test('扩展：install 订阅两条通道，dispose 全部注销', () => {
  const seen = { presence: 0, action: 0, stopped: 0 }
  const api = {
    subscribePresenceEvents(fn) { seen.presence++; return () => { seen.stopped++ } },
    subscribeActionTraces(fn) { seen.action++; return () => { seen.stopped++ } }
  }
  const stop = ext.install(api)
  assert.equal(seen.presence, 1)
  assert.equal(seen.action, 1)
  stop()
  assert.equal(seen.stopped, 2)
})

test('扩展：订阅回调只做转发，异常不外泄（核心结果不受影响）', () => {
  let onPresence = null
  const api = {
    subscribePresenceEvents(fn) { onPresence = fn; return () => {} },
    subscribeActionTraces() { return () => {} }
  }
  const stop = ext.install(api)
  setFlags({})
  assert.doesNotThrow(() => onPresence(activity('boom')))
  assert.doesNotThrow(() => onPresence(null))
  stop()
})
