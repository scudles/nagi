// test/voice-owner.test.js
// 语音播放归属单测（V01 修复，2026-10-15）：一次回复只允许一个窗口朗读。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickVoiceOwner } from '../src/core/voice/owner.js'

test('桌宠形态：归属桌宠窗', () => {
  assert.equal(pickVoiceOwner('pet', { pet: true, workbench: true }), 'pet')
  assert.equal(pickVoiceOwner('pet', { pet: true }), 'pet')
})

test('工作台形态：归属工作台窗（V01 核心：隐藏的桌宠窗不是归属者）', () => {
  assert.equal(pickVoiceOwner('workbench', { pet: true, workbench: true }), 'workbench')
  assert.equal(pickVoiceOwner('workbench', { workbench: true }), 'workbench')
})

test('兜底：当前形态的窗不在时用另一个，避免全员静默', () => {
  assert.equal(pickVoiceOwner('workbench', { pet: true, workbench: false }), 'pet')
  assert.equal(pickVoiceOwner('pet', { pet: false, workbench: true }), 'workbench')
})

test('两个窗都不在：返回 null', () => {
  assert.equal(pickVoiceOwner('pet', {}), null)
  assert.equal(pickVoiceOwner('workbench', {}), null)
  assert.equal(pickVoiceOwner('pet', { pet: false, workbench: false }), null)
})

test('未识别形态按桌宠处理（与 MODE 默认一致）', () => {
  assert.equal(pickVoiceOwner('', { pet: true, workbench: true }), 'pet')
  assert.equal(pickVoiceOwner(undefined, { pet: true, workbench: true }), 'pet')
})
