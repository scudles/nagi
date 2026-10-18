// test/imperfection.test.js
// BLUE-4 回归锁（契约 §5）：
//   · 分级默认 important；提醒/日程/截止时间/时间敏感/明确强调/敏感领域一律重要；
//   · 概率门**绝不**作用于重要项（且重要项分支不调用随机数）；
//   · 每项只判一次、每天 ≤1 次 defer、概率上限 10%、defer 最长 10 分钟且到期恢复；
//   · 低气压：opt-in、非忙碌非危机、24 小时一次、10–30 分钟自然恢复、安慰最多减半且每段一次；
//   · 补救：停止信号立即生效、每天 1 次间隔 6 小时、被勿扰压制时**仍保持停止**；
//   · 全局关闭：清缓存、不重放积压。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPERFECTION_LIMITS,
  classifyIntention,
  decideOptionalFollowup,
  enterLowPressure,
  lowPressureState,
  tickLowPressure,
  comfort,
  expressionTone,
  detectStopSignal,
  repairCandidate,
  emptyImperfectionState,
  normalizeImperfectionState,
  resetImperfectionState
} from '../src/core/presence/imperfection.js'

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
const MIN = 60 * 1000
const HOUR = 60 * MIN
const ON = { enabled: true, forgetProbability: 0.1 }

/* ---------------- 1. 分级 ---------------- */

test('默认 important：空输入 / 缺字段 / 不可靠分级', () => {
  assert.equal(classifyIntention({}).level, 'important')
  assert.equal(classifyIntention(null).level, 'important')
  assert.equal(classifyIntention({ text: '之后聊聊电影', domain: 'unknown-domain' }).level, 'important', '陌生领域按重要处理')
  assert.equal(classifyIntention({ text: '' }).level, 'important')
})

test('提醒/日程来源、截止时间、时间敏感、明确强调、敏感领域一律重要', () => {
  const cases = [
    { sources: [{ id: 'r1', type: 'reminder-due' }], text: '随便聊聊' },
    { sources: [{ id: 's1', type: 'schedule' }], domain: 'chat' },
    { hasDeadline: true, domain: 'chat', text: '想聊点别的' },
    { timeSensitive: true, domain: 'chat', text: '想聊点别的' },
    { explicitEmphasis: true, domain: 'chat', text: '想聊点别的' },
    { domain: 'file', text: '想聊点别的' },
    { domain: 'money', text: '想聊点别的' },
    { domain: 'health', text: '想聊点别的' }
  ]
  for (const c of cases) assert.equal(classifyIntention(c).level, 'important', JSON.stringify(c))
})

test('文本里的强调词也算重要（别忘/务必/deadline）', () => {
  for (const text of ['别忘了帮我看看', '务必提醒我', '这个很重要', 'deadline is tomorrow']) {
    assert.equal(classifyIntention({ text, domain: 'chat' }).level, 'important', text)
  }
})

test('只有白名单齐全才是 low-risk，并带上来源 ID', () => {
  const r = classifyIntention({ text: '之后聊聊电影', kind: 'optional-chat', domain: 'chat', sources: [{ id: 'm1', type: 'memory' }] })
  assert.deepEqual(r, { level: 'low-risk', reason: 'optional-chat', sourceIds: ['m1'] })
})

/* ---------------- 2. 概率门 ---------------- */

const LOW = (id) => ({ id, level: 'low-risk', reason: 'optional-chat', sourceIds: [] })

test('重要项永远 deliver，且不调用随机数（零遗忘的关键）', () => {
  let calls = 0
  const rng = () => { calls++; return 0 }
  const important = { id: 'r1', level: 'important', reason: 'source-reminder', sourceIds: ['r1'] }
  for (let i = 0; i < 50; i++) {
    const r = decideOptionalFollowup({ id: 'r1', intention: important, now: T0 + i * MIN, rng, config: ON, state: emptyImperfectionState(T0) })
    assert.equal(r.action, 'deliver')
    assert.equal(r.reason, 'important')
  }
  assert.equal(calls, 0, '重要项分支不得调用 rng')
})

test('关闭 / 概率显式为 0 时不 defer；默认值是 2% 不是 0', () => {
  // 关开关：不给延迟，也不重放积压
  const off = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, config: { enabled: false, forgetProbability: 0.1 } })
  assert.equal(off.reason, 'disabled')
  assert.equal(off.action, 'deliver')
  assert.equal(decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, config: {} }).reason, 'disabled')
  // 开了但概率显式写 0（明确不要）：同样不延迟
  assert.equal(decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, config: { enabled: true, forgetProbability: 0 } }).reason, 'probability-zero')
  // D49：默认概率 2%。不能是 0 —— 开关勾着而概率默认 0，界面显示「已开启」却一次都不生效（假开）
  assert.equal(IMPERFECTION_LIMITS.forgetProbabilityDefault, 0.02)
  // 漏传概率时走默认 2%，而不是退回 0
  assert.equal(decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0.5, config: { enabled: true } }).reason, 'probability')
})

test('概率上限 10%：配置写大也被夹住', () => {
  assert.equal(IMPERFECTION_LIMITS.forgetProbabilityMax, 0.1)
  const r = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0.15, config: { enabled: true, forgetProbability: 0.9 } })
  assert.equal(r.reason, 'probability', '0.15 ≥ 0.10 不该 defer')
})

test('命中概率 → defer，且带 10 分钟恢复时间', () => {
  const r = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0.01, config: ON })
  assert.equal(r.action, 'defer')
  assert.equal(r.until, T0 + IMPERFECTION_LIMITS.deferMaxMs)
  assert.equal(r.state.pending.length, 1)
})

test('同一项只判一次：重复调用不放大概率', () => {
  const first = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0.01, config: ON })
  assert.equal(first.action, 'defer')
  let calls = 0
  const second = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0 + MIN, state: first.state, rng: () => { calls++; return 0 }, config: ON })
  assert.equal(second.action, 'defer')
  assert.equal(second.reason, 'already-decided')
  assert.equal(calls, 0, '已判过的项不得再掷')
})

test('每天最多 1 次 defer；第二天重置', () => {
  const first = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0, config: ON })
  assert.equal(first.action, 'defer')
  const second = decideOptionalFollowup({ id: 'b', intention: LOW('b'), now: T0 + MIN, state: first.state, rng: () => 0, config: ON })
  assert.equal(second.action, 'deliver')
  assert.equal(second.reason, 'daily-limit')
  assert.equal(IMPERFECTION_LIMITS.deferPerDayMax, 1)
  const nextDay = decideOptionalFollowup({ id: 'c', intention: LOW('c'), now: T0 + 24 * HOUR, state: second.state, rng: () => 0, config: ON })
  assert.equal(nextDay.action, 'defer')
})

test('defer 到期自动恢复为 deliver，并保留原决策记录', () => {
  const first = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0, config: ON })
  const after = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0 + IMPERFECTION_LIMITS.deferMaxMs + 1, state: first.state, rng: () => 0, config: ON })
  assert.equal(after.action, 'deliver')
  assert.equal(after.reason, 'defer-expired')
  assert.equal(after.state.decisions.a.action, 'deliver', '决策记录仍在（可追溯）')
})

test('缺 id 不给 defer（无法按项记账就不允许延迟）', () => {
  assert.equal(decideOptionalFollowup({ intention: LOW(''), now: T0, rng: () => 0, config: ON }).reason, 'no-id')
})

test('全局关闭 = 清空缓存，不重放积压', () => {
  const first = decideOptionalFollowup({ id: 'a', intention: LOW('a'), now: T0, rng: () => 0, config: ON })
  const cleared = resetImperfectionState(T0)
  assert.deepEqual(cleared.decisions, {})
  assert.deepEqual(cleared.pending, [])
  assert.equal(cleared.deferCount, 0)
  assert.notDeepEqual(first.state.decisions, cleared.decisions)
})

test('状态规范化：脏数据不炸，非法决策项丢弃', () => {
  const s = normalizeImperfectionState({ dayKey: 1, deferCount: -2, decisions: { a: { action: 'x' }, b: { action: 'defer', decidedAt: T0 } }, lowPressure: { startedAt: 'x' } }, T0)
  assert.equal(s.deferCount, 0)
  assert.deepEqual(Object.keys(s.decisions), ['b'])
  assert.equal(s.lowPressure, null)
})

/* ---------------- 3. 低气压 ---------------- */

test('低气压：默认关 / 忙碌或危机 / 当天已进过 / 未过 24 小时都不进入', () => {
  const off = { enabled: false, lowPressureEnabled: true }
  assert.equal(enterLowPressure({ now: T0, state: null, config: off }).reason, 'disabled')
  assert.equal(enterLowPressure({ now: T0, state: null, config: { enabled: true } }).reason, 'disabled')
  const entered = enterLowPressure({ now: T0, state: null, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0 })
  assert.equal(entered.entered, true)
  assert.equal(enterLowPressure({ now: T0 + MIN, state: entered.state, config: { enabled: true, lowPressureEnabled: true } }).reason, 'already-active')
  assert.equal(enterLowPressure({ now: T0 + 2 * HOUR, state: entered.state, config: { enabled: true, lowPressureEnabled: true }, busy: true }).reason, 'busy-or-crisis')
  assert.equal(enterLowPressure({ now: T0 + 23 * HOUR, state: entered.state, config: { enabled: true, lowPressureEnabled: true } }).reason, 'interval')
  const nextDay = enterLowPressure({ now: T0 + 25 * HOUR, state: entered.state, config: { enabled: true, lowPressureEnabled: true } })
  assert.equal(nextDay.entered, true, '满 24 小时且跨日可再进入')
})

test('低气压持续 10–30 分钟，到期自然恢复', () => {
  const min = enterLowPressure({ now: T0, state: null, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0 })
  const span = min.state.lowPressure.until - T0
  assert.ok(span >= IMPERFECTION_LIMITS.lowPressureMinMs && span <= IMPERFECTION_LIMITS.lowPressureMaxMs, `span=${span}`)
  const max = enterLowPressure({ now: T0, state: null, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0.999 })
  assert.ok(max.state.lowPressure.until - T0 <= IMPERFECTION_LIMITS.lowPressureMaxMs)
  assert.equal(lowPressureState(min.state, T0).active, true)
  assert.equal(lowPressureState(min.state, min.state.lowPressure.until).active, false)
  const ticked = tickLowPressure(min.state, min.state.lowPressure.until + 1)
  assert.equal(ticked.lowPressure, null)
})

test('安慰：最多缩短剩余一半，每段只接受一次', () => {
  const entered = enterLowPressure({ now: T0, state: null, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0.5 })
  const before = entered.state.lowPressure.until
  const c1 = comfort({ state: entered.state, now: T0, sourceMessageId: 'msg-1' })
  const remaining = before - T0
  assert.equal(c1.reduced, Math.floor(remaining * IMPERFECTION_LIMITS.comfortReductionMax))
  const c2 = comfort({ state: c1.state, now: T0, sourceMessageId: 'msg-2' })
  assert.equal(c2.reason, 'already-comforted')
  assert.equal(c2.reduced, 0)
  assert.equal(c1.state.lowPressure.comfortSourceId, 'msg-1')
})

test('安慰不碰互动计时：只改低气压 until', () => {
  const s = emptyImperfectionState(T0)
  const entered = enterLowPressure({ now: T0, state: s, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0 })
  const after = comfort({ state: entered.state, now: T0 }).state
  for (const key of Object.keys(emptyImperfectionState(T0))) assert.ok(Array.isArray(after[key]) || typeof after[key] !== 'undefined')
  assert.ok(after.lowPressure.until < entered.state.lowPressure.until)
  assert.equal(after.lastLowPressureAt, entered.state.lastLowPressureAt)
})

test('语气档位：低气压时 subdued，结束回 normal', () => {
  const entered = enterLowPressure({ now: T0, state: null, config: { enabled: true, lowPressureEnabled: true }, rng: () => 0 })
  assert.equal(expressionTone(entered.state, T0), 'subdued')
  assert.equal(expressionTone(entered.state, entered.state.lowPressure.until + 1), 'normal')
})

/* ---------------- 4. 补救回路 ---------------- */

test('停止信号识别：停 / 明确负面 / 越界', () => {
  assert.deepEqual(detectStopSignal('别说了'), { matched: true, kind: 'stop' })
  assert.deepEqual(detectStopSignal('停'), { matched: true, kind: 'stop' })
  assert.deepEqual(detectStopSignal('你这样过分了'), { matched: true, kind: 'negative' })
  assert.deepEqual(detectStopSignal('这个我不想聊，越界了'), { matched: true, kind: 'boundary' })
  assert.deepEqual(detectStopSignal('今天天气不错'), { matched: false, kind: null })
  assert.deepEqual(detectStopSignal(''), { matched: false, kind: null })
})

test('补救：停止立即生效；即使不给修复文案也不继续说', () => {
  const off = repairCandidate({ state: null, now: T0, config: {}, signal: { kind: 'stop' } })
  assert.equal(off.stopped, true)
  assert.equal(off.text, null)
  assert.equal(off.reason, 'disabled')
  const dnd = repairCandidate({ state: null, now: T0, config: { enabled: true, repairEnabled: true }, signal: { kind: 'stop' }, privacy: { doNotDisturb: true } })
  assert.equal(dnd.stopped, true)
  assert.equal(dnd.text, null)
  assert.equal(dnd.reason, 'suppressed-still-stopped')
})

test('补救：每天 1 次、间隔 6 小时、措辞轮换而非固定台词', () => {
  const first = repairCandidate({ state: null, now: T0, config: { enabled: true, repairEnabled: true }, signal: { kind: 'stop' } })
  assert.ok(first.text && first.text.length < 20)
  assert.ok(!/原谅|我不是故意|你别生气/.test(first.text), '不得辩解或索求原谅')
  // 同一天内第二次：被每日上限挡住（也可能是间隔门槛，取决于是否已跨日）
  const tooSoon = repairCandidate({ state: first.state, now: T0 + HOUR, config: { enabled: true, repairEnabled: true }, signal: { kind: 'negative' } })
  assert.ok(['daily-limit', 'interval'].includes(tooSoon.reason), tooSoon.reason)
  assert.equal(tooSoon.text, null)
  assert.equal(tooSoon.stopped, true)
  const later = repairCandidate({ state: first.state, now: T0 + 7 * HOUR, config: { enabled: true, repairEnabled: true }, signal: { kind: 'negative' } })
  assert.ok(later.text, '6 小时后可再补救一次')
  assert.notEqual(later.text, first.text, '不同类别措辞不同')
})

test('补救不计入 defer 配额，也不产生吐槽类文案', () => {
  const r = repairCandidate({ state: null, now: T0, config: { enabled: true, repairEnabled: true }, signal: { kind: 'negative' } })
  assert.equal(r.state.deferCount, 0)
  assert.ok(!/哼|活该|谁让你/.test(r.text))
})
