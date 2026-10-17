// test/ambient.test.js
// 待机行为纯逻辑回归锁（全部注入假时钟/假随机，不依赖真实时间）：
//   ① 注视是"事件驱动的微注视"，不是持续跟随：
//      明显移动才触发、间隔不够不看、看一会儿自动移开、移开期不重看、
//      她说话/播动作时不看、静默时强制归中、方向被夹到 [-1,1]；
//   ② 小动作配额：空闲不够不动作、没到点不动作、做完推迟下一次、静默时永不动作；
//   ③ 换装契机与配额：一天上限、最小间隔、契机优先级（时段 > 情绪 > 音乐 > 长空闲）、
//      busy/silent 一律不做；
//   ④ 声调映射与"为什么换了"的说法（她以后要能解释自己）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AMBIENT_PRESETS,
  ACT_REASON,
  RESTYLE_REASON,
  TONE,
  ambientFromSettings,
  createAmbientPlan,
  createGazeScheduler,
  describeRestyleReason,
  toneForCategory
} from '../src/core/ambient.js'

/** 假时钟 */
function clock(start = 0) {
  let t = start
  return { now: () => t, set: (v) => (t = v), add: (ms) => (t += ms) }
}
const seq = (arr) => {
  let i = 0
  return () => arr[i++ % arr.length]
}

/* ---------------- ① 注视调度 ---------------- */

test('注视：明显移动触发一次，且方向被夹到 [-1,1]', () => {
  const g = createGazeScheduler({ minGapMs: 6000, rng: () => 0 })
  assert.equal(g.onCursorMove({ x: 3.5, y: -9 }, 100000), true)
  const s = g.snapshot()
  assert.equal(s.mode, 'looking')
  assert.equal(s.dir.x, 1, 'x 应被夹到 1')
  assert.equal(s.dir.y, -1, 'y 应被夹到 -1')
})

test('注视：间隔不够就不看（不会变成盯着鼠标）', () => {
  const g = createGazeScheduler({ minGapMs: 6000, holdMs: [1600, 1600], avertMs: [1000, 1000], rng: () => 0 })
  const t = clock(0)
  assert.equal(g.onCursorMove({ x: 0.5, y: 0.5 }, t.now()), true)
  t.add(1600)
  g.tick(t.now()) // 到点 → 进入移开
  t.add(1000)
  g.tick(t.now()) // 移开结束 → neutral
  t.add(1000) // 距上次注视只有 3.6s < 6s
  assert.equal(g.onCursorMove({ x: 0.2, y: 0.2 }, t.now()), false, '间隔不够不该看')
  t.add(3000) // 累计 6.6s
  assert.equal(g.onCursorMove({ x: 0.2, y: 0.2 }, t.now()), true)
})

test('注视：看一会儿会自己移开（不是看到你不动为止）', () => {
  const g = createGazeScheduler({ minGapMs: 0, holdMs: [2000, 2000], avertMs: [5000, 5000], rng: () => 0 })
  const t = clock(0)
  g.onCursorMove({ x: 1, y: 0 }, t.now())
  let v = g.tick(t.now())
  assert.equal(v.mode, 'looking')
  assert.equal(v.x, 1)
  t.add(2100)
  v = g.tick(t.now())
  assert.equal(v.mode, 'averted', '到点应当进入移开')
  assert.equal(v.x, 0, '移开后方向归零')
  t.add(5100)
  assert.equal(g.tick(t.now()).mode, 'neutral')
})

test('注视：正在看的时候不追着改目标（避免眼球抖）', () => {
  const g = createGazeScheduler({ minGapMs: 0, holdMs: [3000, 3000], rng: () => 0 })
  const t = clock(0)
  g.onCursorMove({ x: 1, y: 0 }, t.now())
  t.add(100)
  assert.equal(g.onCursorMove({ x: -1, y: 0 }, t.now()), false)
  assert.equal(g.snapshot().dir.x, 1, '仍然是第一次的方向')
})

test('注视：她说话/演动作时根本不看', () => {
  const g = createGazeScheduler({ minGapMs: 0, rng: () => 0 })
  assert.equal(g.onCursorMove({ x: 1, y: 1 }, 0, { busy: true }), false)
  assert.equal(g.snapshot().mode, 'neutral')
})

test('注视：静默（勿扰/夜间）既不触发，也会把已经在看的收回中立', () => {
  const g = createGazeScheduler({ minGapMs: 0, holdMs: [5000, 5000], rng: () => 0 })
  const t = clock(0)
  assert.equal(g.onCursorMove({ x: 1, y: 1 }, t.now(), { silent: true }), false)
  g.onCursorMove({ x: 1, y: 1 }, t.now())
  assert.equal(g.snapshot().mode, 'looking')
  t.add(500)
  const v = g.tick(t.now(), { silent: true })
  assert.equal(v.mode, 'neutral')
  assert.deepEqual({ x: v.x, y: v.y }, { x: 0, y: 0 })
})

test('注视：方向是 0 向量的观测被忽略（没动就不看）', () => {
  const g = createGazeScheduler({ minGapMs: 0, rng: () => 0 })
  assert.equal(g.onCursorMove({ x: 0, y: 0 }, 0), false)
  assert.equal(g.onCursorMove(null, 0), false)
})

/* ---------------- ② 小动作配额 ---------------- */

test('小动作：空闲不够 / 没到点 / busy / silent 都不动', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, motionGapMs: [300000, 300000], idleBeforeActMs: 90000 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldAct({ idleMs: 0 }), null, '刚动过鼠标不该动')
  assert.equal(plan.shouldAct({ idleMs: 100000 }), null, '还没到 5 分钟')
  t = 300001
  assert.equal(plan.shouldAct({ idleMs: 100000, busy: true }), null, '她在说话不该动')
  assert.equal(plan.shouldAct({ idleMs: 100000, silent: true }), null, '静默不该动')
  assert.ok(plan.shouldAct({ idleMs: 100000 }), '条件齐了应当允许')
})

test('小动作：做完一次会把下一次推迟到间隔之后', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, motionGapMs: [600000, 600000], idleBeforeActMs: 90000 },
    { now: () => t, rng: () => 0 }
  )
  t = 600001
  assert.ok(plan.shouldAct({ idleMs: 100000 }))
  plan.noteAct()
  assert.equal(plan.shouldAct({ idleMs: 100000 }), null, '刚做完不该立刻再做')
  t += 600001
  assert.ok(plan.shouldAct({ idleMs: 100000 }))
})

test('小动作：基调决定由头（陪做事时更安静，看视频游戏时会凑近）', () => {
  let t = 0
  const mk = (tone, r) =>
    createAmbientPlan(
      { ...AMBIENT_PRESETS.conservative, motionGapMs: [0, 0], idleBeforeActMs: 0 },
      { now: () => t, rng: () => r }
    )
  assert.equal(mk(TONE.ATTENTIVE, 0.1).shouldAct({ idleMs: 1, tone: TONE.ATTENTIVE }).reason, ACT_REASON.REACT)
  assert.equal(mk(TONE.QUIET, 0.1).shouldAct({ idleMs: 1, tone: TONE.QUIET }).reason, ACT_REASON.STRETCH)
})

/* ---------------- ③ 自主换装 ---------------- */

test('换装：一天有上限，超了就不换', () => {
  let t = new Date('2026-10-17T02:00:00Z').getTime()
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMaxPerDay: 2, restyleMinGapMs: 0, restyleIdleMs: 1 },
    { now: () => t, rng: () => 0 }
  )
  assert.ok(plan.shouldRestyle({ idleMs: 10 }))
  plan.noteRestyle(RESTYLE_REASON.IDLE)
  assert.ok(plan.shouldRestyle({ idleMs: 10 }), '第一次之后还能再来一次')
  plan.noteRestyle(RESTYLE_REASON.IDLE)
  assert.equal(plan.shouldRestyle({ idleMs: 10 }), null, '达到当日上限应当停下')
})

test('换装：跨天会重置当日计数', () => {
  let t = new Date('2026-10-17T02:00:00Z').getTime()
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMaxPerDay: 1, restyleMinGapMs: 0, restyleIdleMs: 1 },
    { now: () => t, rng: () => 0 }
  )
  plan.noteRestyle(RESTYLE_REASON.IDLE)
  assert.equal(plan.shouldRestyle({ idleMs: 10 }), null)
  t += 24 * 3600 * 1000
  assert.ok(plan.shouldRestyle({ idleMs: 10 }), '第二天应当重新有一次机会')
})

test('换装：最小间隔不够就不换，哪怕契机成立', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMinGapMs: 90 * 60 * 1000, restyleMaxPerDay: 99, restyleIdleMs: 1 },
    { now: () => t, rng: () => 0 }
  )
  assert.ok(plan.shouldRestyle({ idleMs: 10, rhythm: 'morning' }))
  plan.noteRestyle(RESTYLE_REASON.RHYTHM)
  t += 60 * 60 * 1000
  assert.equal(plan.shouldRestyle({ idleMs: 10, rhythm: 'afternoon' }), null, '一小时不够')
  t += 31 * 60 * 1000
  assert.ok(plan.shouldRestyle({ idleMs: 10, rhythm: 'afternoon' }))
})

test('换装契机优先级：时段 > 情绪 > 在听歌 > 待久了', () => {
  let t = 0
  const mk = () =>
    createAmbientPlan(
      { ...AMBIENT_PRESETS.conservative, restyleMinGapMs: 0, restyleMaxPerDay: 99, restyleIdleMs: 1 },
      { now: () => t, rng: () => 0 }
    )
  assert.equal(mk().shouldRestyle({ idleMs: 999999, rhythm: 'night', mood: 'joy', musicPlaying: true }).reason, RESTYLE_REASON.RHYTHM)
  assert.equal(mk().shouldRestyle({ idleMs: 999999, mood: 'joy', musicPlaying: true }).reason, RESTYLE_REASON.MOOD)
  assert.equal(mk().shouldRestyle({ idleMs: 999999, musicPlaying: true }).reason, RESTYLE_REASON.MUSIC)
  assert.equal(mk().shouldRestyle({ idleMs: 999999 }).reason, RESTYLE_REASON.IDLE)
})

test('换装：没有任何契机时就不换（宁可不动）', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMinGapMs: 0, restyleMaxPerDay: 99, restyleIdleMs: 60 * 60 * 1000 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldRestyle({ idleMs: 1000 }), null)
})

test('换装：busy / silent 一律不做', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMinGapMs: 0, restyleMaxPerDay: 99, restyleIdleMs: 1 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldRestyle({ idleMs: 99999, rhythm: 'night', busy: true }), null)
  assert.equal(plan.shouldRestyle({ idleMs: 99999, rhythm: 'night', silent: true }), null)
})

test('换装：时段契机给出建议装束 id（night → 睡前）', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, restyleMinGapMs: 0, restyleMaxPerDay: 99, restyleIdleMs: 1 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldRestyle({ idleMs: 10, rhythm: 'night' }).lookId, 'night')
  assert.equal(plan.shouldRestyle({ idleMs: 10, rhythm: 'morning' }).lookId, 'daily')
})

/* ---------------- ④ 声调与说法 ---------------- */

test('活动分类映射到待机基调', () => {
  assert.equal(toneForCategory('work'), TONE.QUIET)
  assert.equal(toneForCategory('browser'), TONE.QUIET)
  assert.equal(toneForCategory('video'), TONE.ATTENTIVE)
  assert.equal(toneForCategory('gaming'), TONE.ATTENTIVE)
  assert.equal(toneForCategory('other'), TONE.NORMAL)
  assert.equal(toneForCategory(undefined), TONE.NORMAL, '未知分类回落 normal')
  assert.equal(toneForCategory('WORK'), TONE.QUIET, '大小写不敏感')
})

test('每一档预设的参数都自洽（上限>0、间隔区间递增）', () => {
  for (const [name, p] of Object.entries(AMBIENT_PRESETS)) {
    assert.ok(p.restyleMaxPerDay > 0, `${name} 上限应 > 0`)
    assert.ok(p.motionGapMs[0] <= p.motionGapMs[1], `${name} 动作间隔区间应递增`)
    assert.ok(p.gazeHoldMs[0] <= p.gazeHoldMs[1], `${name} 注视时长区间应递增`)
    assert.ok(p.gazeAvertMs[0] <= p.gazeAvertMs[1], `${name} 移开时长区间应递增`)
    assert.ok(p.gazeHoldMs[1] < p.gazeAvertMs[0] + 100000, `${name} 看一眼远短于移开期`)
  }
})

test('ambientFromSettings：未知档位回落保守，数值可覆盖', () => {
  assert.equal(ambientFromSettings({ level: '不存在' }).restyleMaxPerDay, AMBIENT_PRESETS.conservative.restyleMaxPerDay)
  assert.equal(ambientFromSettings({ level: 'lively' }).restyleMaxPerDay, AMBIENT_PRESETS.lively.restyleMaxPerDay)
  assert.equal(ambientFromSettings({ level: 'lively', restyleMaxPerDay: 1 }).restyleMaxPerDay, 1)
})

test('换装理由都有中文说法（她以后要能解释自己）', () => {
  for (const r of Object.values(RESTYLE_REASON)) {
    const s = describeRestyleReason(r)
    assert.ok(s && s.length >= 4, `理由 ${r} 没有说法`)
  }
  assert.ok(describeRestyleReason('莫名其妙').length > 0, '未知理由也要有兜底说法')
})

test('随机源耗尽也不会死循环（rng 固定值时仍能返回）', () => {
  const t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, motionGapMs: [0, 0], idleBeforeActMs: 0 },
    { now: () => t, rng: seq([0.999]) }
  )
  assert.ok(plan.shouldAct({ idleMs: 1 }))
})

/* ---------------- ⑤ 微表情由头与罕见专场（2026-10-17 增） ---------------- */

test('自主动作里包含"闪个微表情"这个由头（不是只会换站姿）', () => {
  let t = 0
  const mk = (tone, r) =>
    createAmbientPlan(
      { ...AMBIENT_PRESETS.conservative, motionGapMs: [0, 0], idleBeforeActMs: 0 },
      { now: () => t, rng: () => r }
    )
  // 三个基调下各自都能轮到 EXPR（取扫描一段区间的做法，避免依赖单个随机点）
  for (const tone of [TONE.QUIET, TONE.NORMAL, TONE.ATTENTIVE]) {
    let seen = false
    for (let i = 1; i < 30; i++) {
      const act = mk(tone, i / 30).shouldAct({ idleMs: 1, tone })
      if (act?.reason === ACT_REASON.EXPR) seen = true
    }
    assert.ok(seen, `${tone} 基调下从来没有轮到过 EXPR`)
  }
})

test('罕见专场：空闲不够 / busy / silent 都不演', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, showpieceMaxPerDay: 1, showpieceIdleMs: 30 * 60 * 1000 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldShowpiece({ idleMs: 60 * 1000 }), null, '才闲一分钟不该演')
  assert.equal(plan.shouldShowpiece({ idleMs: 40 * 60 * 1000, busy: true }), null)
  assert.equal(plan.shouldShowpiece({ idleMs: 40 * 60 * 1000, silent: true }), null)
  assert.ok(plan.shouldShowpiece({ idleMs: 40 * 60 * 1000, tone: TONE.NORMAL }), '条件齐了应当允许')
})

test('罕见专场：一天只演一次，跨天才重置', () => {
  let t = new Date('2026-10-17T02:00:00Z').getTime()
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, showpieceMaxPerDay: 1, showpieceIdleMs: 0 },
    { now: () => t, rng: () => 0 }
  )
  assert.ok(plan.shouldShowpiece({ idleMs: 1, tone: TONE.NORMAL }))
  plan.noteShowpiece()
  assert.equal(plan.shouldShowpiece({ idleMs: 1, tone: TONE.NORMAL }), null, '当天不该演第二次')
  t += 24 * 3600 * 1000
  assert.ok(plan.shouldShowpiece({ idleMs: 1, tone: TONE.NORMAL }), '第二天应当重新可以演')
})

test('罕见专场：安静基调（你在专注做事）不演，心情好时更愿意演', () => {
  let t = 0
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, showpieceMaxPerDay: 9, showpieceIdleMs: 0 },
    { now: () => t, rng: () => 0 }
  )
  assert.equal(plan.shouldShowpiece({ idleMs: 1, tone: TONE.QUIET }), null, '安静陪着时不该突然演一段')
  const joy = plan.shouldShowpiece({ idleMs: 1, tone: TONE.NORMAL, mood: 'joy' })
  assert.ok(joy)
  assert.equal(joy.group, 'Scene')
  assert.ok(joy.why.includes('心情'), `理由该提到心情，实际：${joy.why}`)
})

test('三档预设都有一场专场的配额（不能是 undefined 导致天天不演）', () => {
  for (const [name, p] of Object.entries(AMBIENT_PRESETS)) {
    assert.ok(p.showpieceMaxPerDay >= 1, `${name} 缺 showpieceMaxPerDay`)
    assert.ok(p.showpieceIdleMs > 0, `${name} 缺 showpieceIdleMs`)
  }
})

/* ---------------- ⑥ 节奏对比：簇发与"憋久了更明显"（2026-10-17 增） ---------------- */

test('簇发：一次动作后会紧接着再来一个（而不是永远匀速）', () => {
  let t = 1_000_000
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, motionGapMs: [600000, 600000], burstChance: 1, burstGapMs: [20000, 40000], burstMax: 2 },
    { now: () => t, rng: () => 0.1 }
  )
  const r1 = plan.noteAct()
  assert.equal(r1.burst, true, '概率 1 时应当开一个簇')
  const gap1 = plan.stats().nextMotionAt - t
  assert.ok(gap1 >= 20000 && gap1 <= 40000, `簇内间隔应当是 20~40 秒，实际 ${gap1}`)

  // 第二下之后簇用完了，回到长间隔
  const r2 = plan.noteAct()
  assert.equal(r2.burst, true)
  const r3 = plan.noteAct()
  assert.equal(r3.burst, false, 'burstMax=2 时第三下不该再连')
  const gap3 = plan.stats().nextMotionAt - t
  assert.ok(gap3 >= 600000, `应当回到长间隔，实际 ${gap3}`)
})

test('不开簇时回到长间隔（节奏不能整体变密）', () => {
  let t = 1_000_000
  const plan = createAmbientPlan(
    { ...AMBIENT_PRESETS.conservative, motionGapMs: [300000, 300000], burstChance: 0 },
    { now: () => t, rng: () => 0.9 }
  )
  const r = plan.noteAct()
  assert.equal(r.burst, false)
  assert.equal(plan.stats().nextMotionAt - t, 300000)
})

test('安静很久之后的第一个动作幅度加大，簇里的后续动作不加大', () => {
  let t = 1_000_000
  const cfg = { ...AMBIENT_PRESETS.conservative, idleBeforeActMs: 90000, motionGapMs: [0, 0], burstChance: 1, burstGapMs: [0, 0], burstMax: 2 }
  const plan = createAmbientPlan(cfg, { now: () => t, rng: () => 0.1 })
  // 刚闲 1 分钟：不算"很久"，不该加大
  assert.equal(plan.shouldAct({ idleMs: 60 * 1000, tone: TONE.NORMAL }), null)
  // 闲了 10 分钟：可以动，且要加大
  const first = plan.shouldAct({ idleMs: 10 * 60 * 1000, tone: TONE.NORMAL })
  assert.ok(first?.big, '安静很久之后的第一下应当 big')
  plan.noteAct() // 开簇
  // 簇里的第二下：不再加大（否则连续三下大动作，更吵）
  const second = plan.shouldAct({ idleMs: 10 * 60 * 1000, tone: TONE.NORMAL })
  assert.ok(second && !second.big, '簇里的后续动作不该 big')
})

test('三档预设都配了簇发参数（缺了会退回匀速，等于没做）', () => {
  for (const [name, p] of Object.entries(AMBIENT_PRESETS)) {
    assert.ok(p.burstChance > 0 && p.burstChance < 1, `${name} 缺 burstChance`)
    assert.ok(Array.isArray(p.burstGapMs) && p.burstGapMs.length === 2, `${name} 缺 burstGapMs`)
    assert.ok(p.burstMax >= 2, `${name} 缺 burstMax`)
    assert.ok(p.burstGapMs[1] < p.motionGapMs[0], `${name} 的簇内间隔必须明显短于常规间隔`)
  }
})
