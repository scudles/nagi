// test/relation.test.js
// S4 关系层单测：情绪跨重启延续 + 熟悉度 + 情绪时间线（全纯逻辑，假时钟，无 IO）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMood, MOOD_PARAMS } from '../src/core/emotion/mood.js'
import {
  emptyStats,
  normalizeStats,
  noteInteraction,
  familiarityScore,
  familiarityLevel,
  levelProgress,
  describeRelation,
  localDateKey,
  FAMILIARITY_LEVELS
} from '../src/core/relation/familiarity.js'
import {
  TIMELINE,
  normalizePoint,
  normalizePoints,
  shouldRecord,
  appendPoint,
  toSegments,
  dailyBuckets,
  staleDates
} from '../src/core/relation/timeline.js'

const DAY_MS = 86400000
const MIN = 60000

/** 假时钟：默认落在 2026-10-14 12:00（中午，避开深夜推力） */
function fakeClock(iso = '2026-10-14T12:00:00') {
  let t = new Date(iso).getTime()
  return { fn: () => t, advance: (ms) => { t += ms }, at: () => t }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

/* ==================== 情绪：跨重启延续 ==================== */

test('mood：serialize 导出可落盘的状态快照', () => {
  const c = fakeClock()
  const m = createMood({ now: c.fn })
  m.propose('joy', 1.0, 'test') // 异情绪接管 → intensity = 1.0 * 0.7
  const s = m.serialize()
  assert.equal(s.version, 1)
  assert.equal(s.mood, 'joy')
  assert.ok(close(s.intensity, 0.7))
  assert.equal(s.savedAt, c.at())
  assert.ok(Array.isArray(s.chatTimes))
})

test('mood：restore 非法输入返回 false 且不动状态', () => {
  const c = fakeClock()
  const m = createMood({ now: c.fn })
  m.propose('joy', 1.0)
  assert.equal(m.restore(null), false)
  assert.equal(m.restore('nope'), false)
  assert.equal(m.restore(42), false)
  assert.equal(m.current().mood, 'joy')
})

test('mood：立即重启 → 情绪基本延续（离线不足一个心跳不衰减）', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.propose('joy', 1.0)
  const snap = a.serialize()

  const b = createMood({ now: c.fn })
  assert.equal(b.restore(snap), true)
  assert.equal(b.current().mood, 'joy')
  assert.ok(close(b.current().intensity, 0.7), '强度应保留：' + b.current().intensity)
})

test('mood：离线按同样心跳速率衰减（短离线只掉一点，一夜必回平静）', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.propose('joy', 1.0)
  const snap = a.serialize()

  // 离线 1 个心跳 → 正好衰减一步
  const c1 = fakeClock()
  c1.advance(MOOD_PARAMS.TICK_MS)
  const b = createMood({ now: c1.fn })
  b.restore(snap)
  assert.equal(b.current().mood, 'joy')
  assert.ok(close(b.current().intensity, 0.7 - MOOD_PARAMS.DECAY), '实际 ' + b.current().intensity)

  // 离线一夜 → 回平静，不会出现"三天前的闹别扭还挂在脸上"
  const c2 = fakeClock()
  c2.advance(10 * 60 * 60 * 1000)
  const d = createMood({ now: c2.fn })
  d.restore(snap)
  assert.equal(d.current().mood, 'calm')
  assert.equal(d.current().intensity, 0)
})

test('mood：久离线后闹别扭情绪也归零（不会跨天挂着）', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.propose('pout', 1.0)
  const snap = a.serialize()
  const c2 = fakeClock('2026-10-17T12:00:00') // 三天后
  const b = createMood({ now: c2.fn })
  b.restore(snap)
  assert.equal(b.current().mood, 'calm')
})

test('mood：开机不立刻闹别扭（冷落计时重新起算）', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.noteInteraction()
  a.propose('joy', 1.0)
  a.tick() // 消化掉连聊 burst，避免干扰
  const snap = a.serialize()

  // 两小时没理她之后开机
  const c2 = fakeClock()
  c2.advance(2 * 60 * 60 * 1000)
  const b = createMood({ now: c2.fn })
  b.restore(snap)
  b.tick() // 开机第一次心跳
  assert.notEqual(b.current().mood, 'pout', '开机不该马上闹别扭（那只是技术事件）')
  // lastInteraction 保留真实值——上下文里那句"8 小时前"得是真的
  assert.equal(b.serialize().lastInteraction, snap.lastInteraction)
})

test('mood：restore 保留真实 lastInteraction，但冷落推力有 20 分钟宽限', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.propose('joy', 1.0)
  const snap = a.serialize()

  const c2 = fakeClock()
  c2.advance(60 * 60 * 1000)
  const b = createMood({ now: c2.fn })
  b.restore(snap)
  assert.equal(b.serialize().lastInteraction, snap.lastInteraction)
  assert.equal(b.serialize().lastIdlePush, c2.at())

  // 开机后再被冷落 26 分钟 → 该闹还是闹
  c2.advance(26 * MIN)
  b.tick()
  assert.equal(b.current().mood, 'pout')
})

test('mood：跨天重置深夜标记，同一天则保留', () => {
  const base = {
    version: 1,
    mood: 'worry',
    intensity: 0.6,
    lastInteraction: new Date('2026-10-14T22:30:00').getTime(),
    nightWorried: true,
    chatTimes: []
  }
  // 跨过零点 → 重置
  const across = fakeClock('2026-10-15T00:30:00')
  const m1 = createMood({ now: across.fn })
  m1.restore({ ...base, savedAt: new Date('2026-10-14T23:50:00').getTime() })
  assert.equal(m1.serialize().nightWorried, false, '跨天应重置"今晚已经担心过"')

  // 同一天稍后重启 → 保留
  const same = fakeClock('2026-10-14T23:00:00')
  const m2 = createMood({ now: same.fn })
  m2.restore({ ...base, savedAt: new Date('2026-10-14T22:30:00').getTime() })
  assert.equal(m2.serialize().nightWorried, true, '同一天应保留')
})

test('mood：restore 丢弃过期的连聊时间戳', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.noteInteraction()
  a.noteInteraction()
  const snap = a.serialize()
  assert.equal(snap.chatTimes.length, 2)

  const c2 = fakeClock()
  c2.advance(MOOD_PARAMS.BURST_WINDOW + 1000) // 超过 90 秒窗口
  const b = createMood({ now: c2.fn })
  b.restore(snap)
  assert.equal(b.serialize().chatTimes.length, 0, '窗口外的连聊时间戳应被丢掉')
})

test('mood：restore 会广播一次（UI 与落盘都能跟上）', () => {
  const c = fakeClock()
  const a = createMood({ now: c.fn })
  a.propose('joy', 1.0)
  const snap = a.serialize()
  const b = createMood({ now: fakeClock().fn })
  let got = null
  b.onChange((s) => { got = s })
  b.restore(snap)
  assert.ok(got && got.mood === 'joy')
})

/* ==================== 熟悉度 ==================== */

test('熟悉度：全新关系是 0 分 / 陌生', () => {
  const now = Date.now()
  const r = describeRelation(emptyStats(now), now)
  assert.ok(close(r.score, 0))
  assert.equal(r.level.key, 'stranger')
  assert.equal(r.daysKnown, 0)
  assert.equal(r.interactionCount, 0)
  assert.equal(r.activeDays, 0)
})

test('熟悉度：noteInteraction 是纯函数，只加次数与当天活跃', () => {
  const now = new Date('2026-10-15T10:00:00').getTime()
  const s0 = emptyStats(now)
  const s1 = noteInteraction(s0, now)
  assert.equal(s0.interactionCount, 0, '原对象不能被改')
  assert.equal(s1.interactionCount, 1)
  assert.deepEqual(s1.activeDays, ['2026-10-15'])
  assert.equal(s1.lastActiveDay, '2026-10-15')

  // 同一天再互动：次数加、活跃日不重复
  const s2 = noteInteraction(s1, now + 3600000)
  assert.equal(s2.interactionCount, 2)
  assert.equal(s2.activeDays.length, 1)

  // 换一天：活跃日增加
  const s3 = noteInteraction(s2, now + DAY_MS)
  assert.equal(s3.activeDays.length, 2)
})

test('熟悉度：同一份统计随时间/互动单调不减', () => {
  const first = new Date('2026-10-01T10:00:00').getTime()
  let stats = emptyStats(first)
  for (let i = 0; i < 40; i++) stats = noteInteraction(stats, first + i * 300000)
  const s1 = familiarityScore(stats, first + 3 * DAY_MS)
  const s2 = familiarityScore(stats, first + 20 * DAY_MS)
  assert.ok(s2 > s1, `越久越熟：${s1} → ${s2}`)
  let stats2 = stats
  for (let i = 0; i < 200; i++) stats2 = noteInteraction(stats2, first + i * 60000)
  assert.ok(familiarityScore(stats2, first + 20 * DAY_MS) > s2, '聊得越多越熟')
})

test('熟悉度：分数落在 0~1，足够久足够多会封顶', () => {
  const first = new Date('2026-01-01T10:00:00').getTime()
  let stats = emptyStats(first)
  for (let d = 0; d < 200; d++) for (let k = 0; k < 10; k++) stats = noteInteraction(stats, first + d * DAY_MS + k * 60000)
  const now = first + 400 * DAY_MS
  const score = familiarityScore(stats, now)
  assert.ok(score > 0.95 && score <= 1, '长期关系应逼近 1，实际 ' + score)
})

test('熟悉度：等级按分数分档，边界是右开区间', () => {
  assert.equal(familiarityLevel(0).key, 'stranger')
  assert.equal(familiarityLevel(0.149).key, 'stranger')
  assert.equal(familiarityLevel(0.15).key, 'acquaintance')
  assert.equal(familiarityLevel(0.34).key, 'acquaintance')
  assert.equal(familiarityLevel(0.35).key, 'familiar')
  assert.equal(familiarityLevel(0.62).key, 'close')
  assert.equal(familiarityLevel(0.85).key, 'intimate')
  assert.equal(familiarityLevel(1).key, 'intimate')
  assert.equal(FAMILIARITY_LEVELS.length, 5)
})

test('熟悉度：levelProgress 给出到下一级的进度，封顶后 level=null', () => {
  const p0 = levelProgress(0)
  assert.equal(p0.level.key, 'acquaintance')
  assert.ok(close(p0.progress, 0))
  assert.ok(close(p0.needScore, 0.15))

  const p1 = levelProgress(0.25) // 认识(0.15) → 熟悉(0.35)：一半
  assert.equal(p1.level.key, 'familiar')
  assert.ok(close(p1.progress, 0.5))

  const top = levelProgress(1)
  assert.equal(top.level, null)
  assert.equal(top.progress, 1)
})

test('熟悉度：normalizeStats 容错脏数据', () => {
  const now = 1000000
  const s = normalizeStats({ firstMetAt: 'x', interactionCount: -5, activeDays: ['a', 3, null, 'b'], lastActiveDay: 7 }, now)
  assert.equal(s.firstMetAt, now)
  assert.equal(s.interactionCount, 0)
  assert.deepEqual(s.activeDays, ['a', 'b'])
  assert.equal(s.lastActiveDay, null)
  assert.deepEqual(normalizeStats(null, now), { firstMetAt: now, interactionCount: 0, activeDays: [], lastActiveDay: null })
})

test('熟悉度：localDateKey 用本地日期', () => {
  assert.equal(localDateKey(new Date('2026-10-15T23:59:00').getTime()), '2026-10-15')
  assert.equal(localDateKey(new Date('2026-01-02T00:00:00').getTime()), '2026-01-02')
})

test('熟悉度：等级 note 是行为约束（保证"不装亲密"护栏随等级下发）', () => {
  for (const lv of FAMILIARITY_LEVELS) {
    assert.ok(typeof lv.note === 'string' && lv.note.length > 0, lv.key + ' 缺 note')
    assert.ok(lv.note.length <= 30, lv.key + ' 的 note 太长（会撑提示）')
  }
})

/* ==================== 情绪时间线 ==================== */

test('时间线：normalizePoint 容错', () => {
  assert.deepEqual(normalizePoint({ t: 5, mood: 'joy', i: 0.4 }), { t: 5, mood: 'joy', i: 0.4 })
  assert.deepEqual(normalizePoint({ t: 5, mood: '', i: 9 }), { t: 5, mood: 'calm', i: 1 })
  assert.deepEqual(normalizePoint({ t: 5, i: -3 }), { t: 5, mood: 'calm', i: 0 })
  assert.equal(normalizePoint(null), null)
  assert.equal(normalizePoint({ t: 'x' }), null)
})

test('时间线：normalizePoints 过滤非法并保持升序', () => {
  const got = normalizePoints([{ t: 30, mood: 'a' }, { t: 10, mood: 'b' }, null, { t: 50, mood: 'c' }])
  assert.deepEqual(got.map((p) => p.t), [30, 50])
})

test('时间线：采样规则——情绪切换必记、同情绪要够久且变化够大', () => {
  const t0 = 1700000000000
  assert.equal(shouldRecord([], { t: t0, mood: 'calm', i: 0 }), true, '第一个点必记')

  const pts = [{ t: t0, mood: 'calm', i: 0 }]
  assert.equal(shouldRecord(pts, { t: t0 + 60 * MIN, mood: 'joy', i: 0.9 }), true, '情绪切换必记')
  assert.equal(shouldRecord(pts, { t: t0 + 30 * 1000, mood: 'calm', i: 0.5 }), false, '同情绪且未到最小间隔 → 不记')
  assert.equal(shouldRecord(pts, { t: t0 + 3 * MIN, mood: 'calm', i: 0.05 }), false, '同情绪小幅波动 → 不记')
  assert.equal(shouldRecord(pts, { t: t0 + 3 * MIN, mood: 'calm', i: 0.5 }, { MIN_GAP_MS: 0 }), true, '放开间隔后强度跳变 → 记')
  assert.equal(shouldRecord(pts, { t: t0 - 1, mood: 'joy', i: 0.9 }), false, '时间倒流 → 丢')
})

test('时间线：appendPoint 不满足规则时原样返回（引用不变）', () => {
  const t0 = 1700000000000
  const pts = [{ t: t0, mood: 'calm', i: 0 }]
  assert.equal(appendPoint(pts, { t: t0 + MIN, mood: 'calm', i: 0.02 }), pts)
  const next = appendPoint(pts, { t: t0 + MIN, mood: 'joy', i: 0.8 })
  assert.notEqual(next, pts)
  assert.equal(next.length, 2)
})

test('时间线：单日点数有上限（超出丢最早的）', () => {
  const t0 = 1700000000000
  let pts = []
  for (let k = 0; k < TIMELINE.MAX_POINTS_PER_DAY + 80; k++) {
    // 交错情绪，保证每一点都满足"情绪切换必记"
    pts = appendPoint(pts, { t: t0 + k * 1000, mood: k % 2 ? 'joy' : 'calm', i: k % 2 ? 0.9 : 0 })
  }
  assert.equal(pts.length, TIMELINE.MAX_POINTS_PER_DAY)
  assert.equal(pts[0].t, t0 + 80 * 1000, '丢的是最早的那些')
})

test('时间线：toSegments 折成 0~1 比例色段', () => {
  const from = 1000
  const to = 2000
  const pts = [
    { t: 1000, mood: 'calm', i: 0 },
    { t: 1500, mood: 'joy', i: 0.8 },
    { t: 2000, mood: 'pout', i: 0.5 }
  ]
  const seg = toSegments(pts, { from, to })
  assert.equal(seg.length, 2)
  assert.equal(seg[0].mood, 'calm')
  assert.equal(seg[1].mood, 'joy')
  assert.ok(close(seg[0].from, 0))
  assert.ok(close(seg[0].to, 0.5))
  assert.ok(close(seg[1].from, 0.5))
  assert.ok(close(seg[1].to, 1))
  // 末点管到窗口右端（不产生零宽段）
  assert.ok(seg.every((s) => s.to > s.from))
})

test('时间线：toSegments 裁掉窗口外的点、非法窗口返回空', () => {
  const pts = [{ t: 0, mood: 'calm', i: 0 }, { t: 5000, mood: 'joy', i: 0.9 }]
  const seg = toSegments(pts, { from: 1000, to: 2000 })
  // 两个点都在窗口外：第一个点跨过整个窗口 → 落成一段
  assert.equal(seg.length, 1)
  assert.equal(seg[0].mood, 'calm')
  assert.ok(close(seg[0].from, 0))
  assert.ok(close(seg[0].to, 1))
  assert.deepEqual(toSegments(pts, { from: 5, to: 5 }), [])
  assert.deepEqual(toSegments(pts, {}), [])
  assert.deepEqual(toSegments(pts, null), [])
})

test('时间线：dailyBuckets 给每天的主情绪与峰值', () => {
  const days = [
    { date: '2026-10-14', points: [{ t: 1, mood: 'joy', i: 0.9 }, { t: 2, mood: 'joy', i: 0.8 }, { t: 3, mood: 'calm', i: 0 }] },
    { date: '2026-10-15', points: [{ t: 1, mood: 'worry', i: 0.3 }] },
    { date: '2026-10-16', points: [] }
  ]
  const b = dailyBuckets(days)
  assert.equal(b.length, 3)
  assert.deepEqual(b[0], { date: '2026-10-14', count: 3, dominant: 'joy', peak: 0.9 })
  assert.equal(b[1].dominant, 'worry')
  assert.equal(b[2].count, 0)
  assert.equal(b[2].dominant, 'calm')
  assert.deepEqual(dailyBuckets(null), [])
})

test('时间线：staleDates 只淘汰保留期之外的日期', () => {
  const now = new Date('2026-10-15T12:00:00').getTime()
  const dates = ['2026-10-15', '2026-10-01', '2026-09-16', '2026-09-15', '2026-01-01']
  assert.deepEqual(staleDates(dates, now), ['2026-09-15', '2026-01-01'])
  assert.deepEqual(staleDates(dates, now, 1), ['2026-10-01', '2026-09-16', '2026-09-15', '2026-01-01'])
  assert.deepEqual(staleDates(null, now), [])
})
