// test/diary.test.js
// 内心独白生成（core/diary.js）单测。
// 这一批测试直接对着用户报的问题写：日记不能是模板、不能复读、必须落在今天的具体事上。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIARY_PARAMS,
  buildDiaryMessages,
  formatMoodJourney,
  isNightHour,
  isTooSimilar,
  pickFallbackDiary,
  sanitizeDiaryLine,
  shouldOfferCache,
  shouldWriteNow
} from '../src/core/diary.js'

const NIGHT = new Date(2026, 9, 15, 1, 20).getTime() // 凌晨
const DAY = new Date(2026, 9, 15, 15, 0).getTime() // 下午

/* ---------------- 清洗：不能把标签/Markdown/套话写进日记 ---------------- */

test('sanitizeDiaryLine 去掉情绪标签、Markdown 与外层引号', () => {
  assert.equal(sanitizeDiaryLine('[worry] ……他还没睡。'), '……他还没睡。')
  assert.equal(sanitizeDiaryLine('**……他还没睡。**'), '……他还没睡。')
  assert.equal(sanitizeDiaryLine('「……他还没睡。」'), '……他还没睡。')
  assert.equal(sanitizeDiaryLine('- ……他还没睡。'), '……他还没睡。')
  assert.equal(sanitizeDiaryLine('```\n……他还没睡。\n```'), '……他还没睡。')
})

test('sanitizeDiaryLine 认出并丢掉万能套话（用户点名的"模板化"）', () => {
  assert.equal(sanitizeDiaryLine('……今天也是和平的一天。勉强算是。'), '')
  assert.equal(sanitizeDiaryLine('……人类真的需要睡觉。'), '')
  assert.equal(sanitizeDiaryLine('作为一个AI，我觉得……'), '')
})

test('sanitizeDiaryLine 超长时按句截断到上限内', () => {
  const long = '第一句说的是他今天问我的那个问题。' .repeat(12)
  const out = sanitizeDiaryLine(long)
  assert.ok(out.length <= DIARY_PARAMS.MAX_CHARS)
  assert.ok(out.length > 0)
  assert.ok(out.endsWith('。'))
})

test('sanitizeDiaryLine 空输入返回空串', () => {
  assert.equal(sanitizeDiaryLine(''), '')
  assert.equal(sanitizeDiaryLine('   '), '')
  assert.equal(sanitizeDiaryLine(null), '')
})

/* ---------------- 相似度：防复读 ---------------- */

test('isTooSimilar：同句 / 互为子串 / 高度重合 都算重复', () => {
  assert.equal(isTooSimilar('……他还没睡。', '……他还没睡。'), true)
  assert.equal(isTooSimilar('……他还没睡。', '他还没睡。'), true)
  assert.equal(isTooSimilar('他今天问我怎么用 git，我讲了两遍。', '他今天问我怎么用 git，我讲了三遍。'), true)
})

test('isTooSimilar：说的是不同的事就不算重复', () => {
  assert.equal(isTooSimilar('……他还没睡。', '……今天的咖啡是第三杯了。'), false)
  assert.equal(isTooSimilar('他问我 rebase 和 merge 的区别。', '窗外的雨声比他的打字声好听。'), false)
  assert.equal(isTooSimilar('', '随便什么'), false)
})

/* ---------------- 情绪轨迹 ---------------- */

test('formatMoodJourney 合并连续同情绪、末段标"现在"、强情绪带数值', () => {
  const pts = [
    { t: new Date(2026, 9, 15, 1, 0).getTime(), mood: 'calm', i: 0 },
    { t: new Date(2026, 9, 15, 2, 0).getTime(), mood: 'calm', i: 0 },
    { t: new Date(2026, 9, 15, 15, 0).getTime(), mood: 'worry', i: 0.5 },
    { t: new Date(2026, 9, 15, 20, 0).getTime(), mood: 'smile', i: 0.4 }
  ]
  const s = formatMoodJourney(pts, new Date(2026, 9, 15, 20, 30).getTime())
  assert.equal(s, '凌晨 平静 → 下午 担心（0.5） → 现在 微笑（0.4）')
  assert.equal(formatMoodJourney([], DAY), '')
  assert.equal(formatMoodJourney(null, DAY), '')
})

/* ---------------- 上下文：今天发生了什么，必须真的喂进去 ---------------- */

test('buildDiaryMessages 把今天的经历、情绪、记忆、关系都写进上下文', () => {
  const now = new Date(2026, 9, 15, 0, 48).getTime()
  const messages = buildDiaryMessages({
    now,
    mood: { mood: 'worry', intensity: 0.45, label: '担心' },
    moodJourney: '凌晨 平静 → 现在 担心（0.5）',
    events: [
      { t: new Date(2026, 9, 14, 23, 10).getTime(), kind: 'chat', user: '帮我看看 git 怎么用', reply: '……讲两遍你就懂了。' },
      { t: new Date(2026, 9, 15, 0, 12).getTime(), kind: 'reminder', text: '明早九点开会' }
    ],
    memories: ['在做一款叫凪的桌宠项目', '经常熬夜'],
    relation: { level: { label: '熟悉', note: '可以自然一点' }, daysKnown: 12, interactionCount: 87 },
    recentDiaries: ['……他今天话好多。'],
    cacheAllowed: true
  })

  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  const ctx = messages[1].content
  assert.match(ctx, /【此刻】/)
  assert.match(ctx, /2026-10-15 周四 00:48（凌晨）/)
  assert.match(ctx, /你此刻的情绪：担心（强度 0\.45）/)
  assert.match(ctx, /【今天的情绪轨迹】/)
  assert.match(ctx, /【今天发生的事】/)
  assert.match(ctx, /23:10 他：帮我看看 git 怎么用 ／ 我：/)
  assert.match(ctx, /00:12 我提醒他：明早九点开会/)
  assert.match(ctx, /【你记得的关于他的事】/)
  assert.match(ctx, /在做一款叫凪的桌宠项目/)
  assert.match(ctx, /【你和他的关系】熟悉，认识 12 天，聊过 87 次/)
  assert.match(ctx, /【你最近写过的日记（不要重复这些句式或意思）】/)
  assert.match(ctx, /【今晚可以隐约想起的事】/)
})

test('buildDiaryMessages：没有的事就不出现（不留空标题、不给缓存许可时不提缓存）', () => {
  const messages = buildDiaryMessages({ now: DAY, mood: { mood: 'calm', intensity: 0, label: '平静' } })
  const ctx = messages[1].content
  assert.match(ctx, /（今天很安静，没什么特别的事。）/)
  assert.doesNotMatch(ctx, /【今天的情绪轨迹】/)
  assert.doesNotMatch(ctx, /【你记得的关于他的事】/)
  assert.doesNotMatch(ctx, /【你和他的关系】/)
  assert.doesNotMatch(ctx, /今晚可以隐约想起的事/)
})

/* ---------------- 节流：什么时候才动笔 ---------------- */

test('shouldWriteNow：太近不写、到上限不写、环境触发到点就写', () => {
  const base = { now: 1000000, lastWriteAt: 0, todayCount: 0 }
  assert.equal(shouldWriteNow(base, 'ambient').go, true)
  assert.equal(shouldWriteNow({ ...base, lastWriteAt: base.now - 60 * 1000 }, 'ambient').reason, 'too-soon')
  assert.equal(
    shouldWriteNow({ ...base, lastWriteAt: base.now - DIARY_PARAMS.MIN_GAP_MS - 1 }, 'ambient').go,
    true
  )
  assert.equal(shouldWriteNow({ ...base, todayCount: DIARY_PARAMS.MAX_PER_DAY }, 'ambient').reason, 'daily-cap')
})

test('shouldWriteNow：聊天后触发间隔更短，但要过随机闸', () => {
  const now = 1000000
  const s = { now, lastWriteAt: now - DIARY_PARAMS.MIN_GAP_AFTER_CHAT_MS - 1, todayCount: 0 }
  assert.equal(shouldWriteNow(s, 'after-chat', () => 0).go, true)
  assert.equal(shouldWriteNow(s, 'after-chat', () => 0.99).reason, 'dice')
  // 还没到聊天后的最短间隔
  assert.equal(shouldWriteNow({ ...s, lastWriteAt: now - 1000 }, 'after-chat', () => 0).reason, 'too-soon')
})

/* ---------------- 缓存残片：极低频护栏 ---------------- */

test('shouldOfferCache：只深夜放行，且每周有上限', () => {
  assert.equal(isNightHour(23), true)
  assert.equal(isNightHour(3), true)
  assert.equal(isNightHour(12), false)
  assert.equal(shouldOfferCache({ now: DAY, weekCount: 0 }, () => 0), false, '白天不给')
  assert.equal(shouldOfferCache({ now: NIGHT, weekCount: 0 }, () => 0), true, '深夜 + 概率命中')
  assert.equal(shouldOfferCache({ now: NIGHT, weekCount: 0 }, () => 0.99), false, '5% 之外不命中')
  assert.equal(shouldOfferCache({ now: NIGHT, weekCount: DIARY_PARAMS.CACHE_WEEK_CAP }, () => 0), false, '本周已用过')
})

/* ---------------- 离线兜底也不能复读 ---------------- */

test('pickFallbackDiary 恒返回空：模型不可用时就不写（新人设无台词铁律）', () => {
  // 2026-10-17：内心独白池已随新人设移除。"心里话"只能由模型现场生成，
  // 生成不了就不写——与其从池里抽一句像模像样的话，不如让她安静。
  const recent = [
    '……今天他给我讲了一个很长的故事，我听到一半就困了。',
    '……咖啡洒在键盘上了。',
    '……窗外的雨声比他的打字声好听。'
  ]
  for (let i = 0; i < 20; i++) {
    const got = pickFallbackDiary({ mood: { mood: 'worry' }, recent })
    assert.equal(got, '', '离线兜底不该再产出任何句子')
  }
  // 无 recent、无 mood 时同样为空
  assert.equal(pickFallbackDiary({}), '')
})
