// test/context.test.js
// 「此刻」上下文注入器单测：时间/时段/相对时长/情绪/记忆/反复读约束的格式化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBlock, formatAgo, formatClock, recentAssistantReplies, timeSlot } from '../src/core/context.js'

test('时段划分覆盖全天且与小时对齐', () => {
  const at = (h) => timeSlot(new Date(2026, 9, 14, h, 0))
  assert.equal(at(2), '凌晨')
  assert.equal(at(6), '清晨')
  assert.equal(at(9), '上午')
  assert.equal(at(12), '中午')
  assert.equal(at(15), '下午')
  assert.equal(at(18), '傍晚')
  assert.equal(at(21), '晚上')
  assert.equal(at(23), '深夜')
})

test('formatClock 输出「年月日 周几 时:分」', () => {
  const s = formatClock(new Date(2026, 9, 14, 22, 5).getTime())
  assert.equal(s, '2026-10-14 周三 22:05')
})

test('formatAgo 分级：刚刚 / 分钟 / 小时 / 天', () => {
  assert.equal(formatAgo(30 * 1000), '刚刚')
  assert.equal(formatAgo(12 * 60000), '12 分钟前')
  assert.equal(formatAgo(3 * 3600 * 1000), '3 小时前')
  assert.equal(formatAgo(2 * 24 * 3600 * 1000), '2 天前')
  assert.equal(formatAgo(-1), null)
})

test('上下文块包含时间与时段', () => {
  const now = new Date(2026, 9, 14, 22, 5).getTime()
  const s = buildContextBlock({ now })
  assert.match(s, /^【此刻】/)
  assert.match(s, /2026-10-14 周三 22:05（晚上）/)
  const late = buildContextBlock({ now: new Date(2026, 9, 14, 23, 40).getTime() })
  assert.match(late, /23:40（深夜）/)
})

test('距上次互动较久才写「距离上次和他说话」', () => {
  const now = new Date(2026, 9, 14, 22, 5).getTime()
  const long = buildContextBlock({ now, lastInteractionAt: now - 3 * 3600 * 1000 })
  assert.match(long, /距离上次和他说话：3 小时前/)
  // 刚刚聊过则不提，避免废话
  const just = buildContextBlock({ now, lastInteractionAt: now - 5000 })
  assert.doesNotMatch(just, /距离上次和他说话/)
})

test('情绪只在与平静不同的时写入，并带强度描述', () => {
  const calmed = buildContextBlock({ now: Date.now(), mood: { mood: 'calm', intensity: 0, label: '平静' } })
  assert.doesNotMatch(calmed, /你此刻的情绪/)
  const worried = buildContextBlock({ now: Date.now(), mood: { mood: 'worry', intensity: 0.7, label: '担心' } })
  assert.match(worried, /你此刻的情绪：担心（强度 0\.70，还没消）/)
})

test('长期记忆与「不要重复」约束会进上下文', () => {
  const s = buildContextBlock({
    now: Date.now(),
    memories: ['在做一款叫凪的桌宠项目', '习惯熬夜'],
    recentReplies: ['……人类真是不会照顾自己。']
  })
  assert.match(s, /你记得的关于他的事：在做一款叫凪的桌宠项目；习惯熬夜/)
  assert.match(s, /不要重复这些句式/)
  assert.match(s, /「……人类真是不会照顾自己。」/)
})

test('没有任何附加信息时仍给出时间（时间本身就是情境）', () => {
  const s = buildContextBlock({ now: new Date(2026, 9, 14, 9, 0).getTime() })
  assert.match(s, /现在：2026-10-14 周三 09:00（上午）/)
})

test('recentAssistantReplies 只取最近的 assistant 原话、倒序还原、超长截断', () => {
  const h = [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '第一句' },
    { role: 'user', content: '嗯' },
    { role: 'assistant', content: '第'.repeat(60) },
    { role: 'user', content: '哦' },
    { role: 'assistant', content: '最后一句' }
  ]
  const r = recentAssistantReplies(h, 2)
  assert.equal(r.length, 2)
  assert.equal(r[0].endsWith('…'), true)
  assert.equal(r[1], '最后一句')
})
