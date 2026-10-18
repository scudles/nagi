// test/emotion-resolve.test.js
// B5（情绪裁决统一）：resolved 表达快照的字段分层。
//
// 保护的不变量（CONTRACTS §8 D5）：
//   1) longMood 是长期心境，tone 是本句语气，两者同时存在且互不覆盖；
//   2) tone 只在这一句有效，**绝不**改写 longMood（句子语气不得静默覆盖长期 mood）；
//   3) 快照可追踪：capturedAt 由注入时钟给，source/userInteraction 如实透传。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMoodSnapshot } from '../src/core/emotion/resolve.js'

const base = { mood: 'worry', intensity: 0.62, expr: 'worry', label: '担心', source: 'llm', userInteraction: true }

test('长期心境与本句语气分层：tone 不改写 longMood/intensity', () => {
  const snap = resolveMoodSnapshot(base, { tone: 'joy', toneSource: 'reply' })
  assert.equal(snap.longMood, 'worry')
  assert.equal(snap.mood, 'worry')
  assert.equal(snap.intensity, 0.62)
  assert.equal(snap.expr, 'worry')
  assert.equal(snap.tone, 'joy')
  assert.equal(snap.toneSource, 'reply')
  // 旧字段仍在（渲染层与日志都按 mood 读）
  assert.equal(snap.label, '担心')
})

test('同一心境下连续两句不同语气：longMood 不动，tone 各自独立', () => {
  const first = resolveMoodSnapshot(base, { tone: 'joy' })
  const second = resolveMoodSnapshot(base, { tone: 'puzzled' })
  assert.equal(first.longMood, second.longMood)
  assert.equal(first.intensity, second.intensity)
  assert.equal(first.tone, 'joy')
  assert.equal(second.tone, 'puzzled')
})

test('没有语气时 tone/toneSource 都为 null，不伪造', () => {
  for (const tone of [null, undefined, '', '   ']) {
    const snap = resolveMoodSnapshot(base, { tone })
    assert.equal(snap.tone, null)
    assert.equal(snap.toneSource, null)
  }
  const def = resolveMoodSnapshot(base, { tone: 'calm' })
  assert.equal(def.toneSource, 'reply') // 没指定来源时默认 reply
})

test('capturedAt 来自注入时钟，可追踪', () => {
  const snap = resolveMoodSnapshot(base, { now: () => 1700000000000 })
  assert.equal(snap.capturedAt, 1700000000000)
})

test('归因字段如实透传；缺失时退回安全默认', () => {
  assert.equal(resolveMoodSnapshot(base).source, 'llm')
  assert.equal(resolveMoodSnapshot(base).userInteraction, true)
  const bare = resolveMoodSnapshot({ mood: 'calm', intensity: 0, expr: 'calm', label: '平静' })
  assert.equal(bare.source, null)
  assert.equal(bare.userInteraction, false)
  const empty = resolveMoodSnapshot(null, { now: () => 1 })
  assert.equal(empty.longMood, 'calm')
  assert.equal(empty.intensity, 0)
  assert.equal(empty.capturedAt, 1)
})
