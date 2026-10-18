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
  // 2026-10-18：措辞改为明确禁止沿用节奏（原来只说"不要重复这些句式"，
  // 实测模型只换词不换调）。这条锁现在同时钉住"只喂 1 条"这个新约束。
  assert.match(s, /不要重复/)
  assert.match(s, /不要沿用它的节奏与断句/)
  assert.match(s, /「……人类真是不会照顾自己。」/)
})

test('只喂 1 条自己的原话，不再喂 4 条（防止语域自我锚定）', () => {
  const history = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '第一条回复' },
    { role: 'user', content: '二' },
    { role: 'assistant', content: '第二条回复' },
    { role: 'user', content: '三' },
    { role: 'assistant', content: '第三条回复' },
    { role: 'user', content: '四' },
    { role: 'assistant', content: '第四条回复' }
  ]
  // 缺省值已改为 1：调用方不传条数时只取最近一句
  assert.equal(recentAssistantReplies(history).length, 1)
  assert.deepEqual(recentAssistantReplies(history), ['第四条回复'])
  assert.equal(recentAssistantReplies(history, 4).length, 4, '显式指定条数仍然可用')
})

// RAG 召回的往事：为空时必须与「没开 RAG」逐字一致（这是容错底线——
// 检索挂了她照样说话，提示词一个字都不该多）
test('召回往事排在「记得的事」之后；为空时输出与不开 RAG 完全一致', () => {
  const base = {
    now: Date.now(),
    memories: ['在做一款叫凪的桌宠项目'],
    recentReplies: ['……人类真是不会照顾自己。']
  }
  const off = buildContextBlock({ ...base })
  const empty = buildContextBlock({ ...base, recalled: [] })
  assert.equal(empty, off, '召回为空时不能多出任何一行')

  const on = buildContextBlock({ ...base, recalled: ['「三个月前（07-12）：他：最近睡不好」'] })
  assert.match(on, /你想起的相关往事/)
  assert.match(on, /三个月前（07-12）/)
  assert.ok(on.indexOf('你想起的相关往事') > on.indexOf('你记得的关于他的事'), '往事排在精选记忆之后')
  assert.ok(!on.includes('undefined'), '不能出现 undefined 之类的脏输出')
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

/* ---------------- 关系行（S4） ---------------- */

test('关系行：把熟悉度等级与行为约束一起下发（落实"不装亲密"护栏）', () => {
  const s = buildContextBlock({
    now: new Date(2026, 9, 14, 9, 0).getTime(),
    relation: { level: { label: '熟悉', note: '可以自然些，不必每句都端着。' }, daysKnown: 12, interactionCount: 340 }
  })
  assert.match(s, /你和他的关系：熟悉，认识 12 天，聊过 340 次——可以自然些/)
})

test('关系行：刚认识时不下发天数与次数（避免"0 天"这种生硬说法）', () => {
  const s = buildContextBlock({
    now: new Date(2026, 9, 14, 9, 0).getTime(),
    relation: { level: { label: '陌生', note: '才刚开始，别装作很熟。' }, daysKnown: 0, interactionCount: 0 }
  })
  assert.match(s, /你和他的关系：陌生——才刚开始，别装作很熟。/)
  assert.doesNotMatch(s, /认识 0 天/)
  assert.doesNotMatch(s, /聊过 0 次/)
})

test('关系行：缺失或残缺时静默省略，不产生空行', () => {
  const none = buildContextBlock({ now: new Date(2026, 9, 14, 9, 0).getTime() })
  assert.doesNotMatch(none, /你和他的关系/)
  const broken = buildContextBlock({ now: Date.now(), relation: {} })
  assert.doesNotMatch(broken, /你和他的关系/)
})
