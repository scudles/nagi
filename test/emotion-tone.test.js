// test/emotion-tone.test.js
// B5（Codex 打回项）：本句语气的生命周期。
//
// 打回原因：`lastTone` 赋值后从不清除，上一轮语气残留到下一轮。
// 这里把生命周期钉成三步：beginTurn 清空 → settle 固定 → current 只读。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createToneState } from '../src/core/emotion/tone.js'
import { resolveMoodSnapshot } from '../src/core/emotion/resolve.js'

const base = { mood: 'calm', intensity: 0.2, expr: 'calm', label: '平静', source: 'tick', userInteraction: false }

test('新一轮开始即清空：上一句语气不残留', () => {
  const s = createToneState()
  s.settle('worry', 'reply')
  assert.deepEqual(s.current(), { tone: 'worry', toneSource: 'reply' })
  s.beginTurn()
  assert.deepEqual(s.current(), { tone: null, toneSource: null })
  const snap = resolveMoodSnapshot(base, s.current())
  assert.equal(snap.tone, null)
  assert.equal(snap.longMood, 'calm', '长期心境不受语气清空影响')
})

test('连续两句语气各自独立（同一长期心境下不串味）', () => {
  const s = createToneState()
  s.beginTurn()
  s.settle('joy')
  const first = resolveMoodSnapshot(base, s.current())
  s.beginTurn()
  s.settle('puzzled')
  const second = resolveMoodSnapshot(base, s.current())
  assert.equal(first.tone, 'joy')
  assert.equal(second.tone, 'puzzled')
  assert.equal(first.longMood, second.longMood)
  assert.equal(first.intensity, second.intensity)
})

test('空语气 / 空白语气被当作"没有语气"，不产生虚假来源', () => {
  const s = createToneState()
  s.beginTurn()
  s.settle(null)
  assert.deepEqual(s.current(), { tone: null, toneSource: null })
  s.settle('   ')
  assert.deepEqual(s.current(), { tone: null, toneSource: null })
  s.settle('calm', '')
  assert.deepEqual(s.current(), { tone: 'calm', toneSource: 'reply' }, '来源缺失时回落 reply')
})

test('current() 只读：外部改返回值不会污染内部状态', () => {
  const s = createToneState()
  s.settle('joy')
  const view = s.current()
  view.tone = 'worry'
  assert.equal(s.current().tone, 'joy')
})
