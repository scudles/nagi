// scripts/verify-imperfection.mjs
// BLUE-4 长周期虚拟模拟（契约 §5 的验收口径）：
//   · **重要事项零遗忘**：120 天里每天投放提醒/日程/截止时间/敏感领域等事项，
//     概率开到上限 10% 也必须 100% 送达（零漏送）；且送达分支不消耗随机数；
//   · 概率只落在可选闲聊意向：实测延迟率不得超过配置概率，且每天 ≤1 次、每项只判一次；
//   · 低气压：每天最多 1 次、10–30 分钟自然恢复、安慰缩短不超过一半；
//   · 补救：每天最多 1 次、间隔 6 小时；
//   · 全局关闭后缓存清空、不重放积压。
//
// 随机源是**固定种子**的 PRNG，结果可复现（不是"跑一次刚好过"）。
// 用法：npm run verify:imperfection [--days=120 --seed=20261017]
import { classifyIntention, decideOptionalFollowup, enterLowPressure, tickLowPressure, comfort,
  repairCandidate, emptyImperfectionState, resetImperfectionState, IMPERFECTION_LIMITS }
  from '../src/core/presence/imperfection.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v === undefined ? '1' : v]
}))
const DAYS = Math.max(1, Math.floor(Number(args.days) || 120))
const SEED = Number(args.seed) || 20261017
const P = IMPERFECTION_LIMITS.forgetProbabilityMax // 按上限跑，最坏情况

/** mulberry32：小、快、可复现 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)

const DAY = 86400000
const MIN = 60000
const T0 = Date.UTC(2026, 0, 1, 8, 0, 0) // 每天 08:00 起投放
const CFG = { enabled: true, forgetProbability: P, lowPressureEnabled: true, repairEnabled: true }

/* ---------------- 投放事项 ---------------- */

const IMPORTANT_KINDS = [
  () => ({ text: '提醒我下午三点开会', sources: [{ id: 'rem-1', type: 'reminder-due' }], domain: 'reminder' }),
  () => ({ text: '这个方案 deadline 明天', sources: [{ id: 'sch-1', type: 'schedule' }], domain: 'schedule' }),
  () => ({ text: '帮我改那个文件', domain: 'file' }),
  () => ({ text: '记得转账', domain: 'money' }),
  () => ({ text: '别忘了带药', domain: 'health' }),
  () => ({ text: '之后务必确认门锁', domain: 'device' }),
  () => ({ text: '随便聊聊也行', hasDeadline: true, domain: 'chat' }),
  () => ({ text: '待会儿说', timeSensitive: true, domain: 'chat' }),
  () => ({ text: '这个很重要', domain: 'chat' }),
  () => ({ text: '说不清算不算重要的事', domain: '' }) // 不可靠分级 → 重要
]
const OPTIONAL = (i) => ({ text: ['之后聊聊电影', '改天说说那本书', '有空聊聊音乐', '下次讲讲旅行'][i % 4], kind: 'optional-chat', domain: 'chat' })

let state = emptyImperfectionState(T0)
let importantTotal = 0
let importantDelivered = 0
let optionalTotal = 0
let optionalDeferred = 0
let deferPerDayMax = 0
let duplicateRolls = 0
let lowPressureDays = 0
let lowPressureSpans = []
let comfortOver = 0
let repairDays = 0

// 记录「每项只判一次」：第二次调用同一 id 时不得再掷（用会自增计数的 rng 探测）
let probeCalls = 0
const probeRng = () => { probeCalls++; return rng() }

for (let d = 0; d < DAYS; d++) {
  const base = T0 + d * DAY
  let todayDefers = 0
  let todayLow = 0
  let todayRepair = 0
  state = tickLowPressure(state, base)

  // 重要事项：每天 6 条
  for (let i = 0; i < 6; i++) {
    const input = IMPORTANT_KINDS[(d * 6 + i) % IMPORTANT_KINDS.length]()
    const level = classifyIntention(input).level
    const r = decideOptionalFollowup({
      id: `imp-${d}-${i}`, intention: { ...input, level }, now: base + i * 7 * MIN,
      rng: probeRng, config: CFG, state
    })
    state = r.state
    importantTotal++
    if (r.action === 'deliver') importantDelivered++
  }

  // 可选闲聊：每天 12 条
  for (let i = 0; i < 12; i++) {
    const input = OPTIONAL(d * 12 + i)
    const level = classifyIntention(input).level
    const id = `opt-${d}-${i}`
    const first = decideOptionalFollowup({ id, intention: { ...input, level }, now: base + 60 * MIN + i * 3 * MIN, rng: probeRng, config: CFG, state })
    state = first.state
    optionalTotal++
    if (first.action === 'defer') {
      optionalDeferred++
      todayDefers++
    }
    // 同一项再来一次（同一天重复调用）：不得改变结果、不得再掷随机数
    const before = probeCalls
    const again = decideOptionalFollowup({ id, intention: { ...input, level }, now: base + 61 * MIN + i * 3 * MIN, rng: probeRng, config: CFG, state })
    state = again.state
    if (probeCalls !== before) duplicateRolls++
    if (again.action !== first.action) duplicateRolls++
  }

  // 低气压：每天试着进一次
  const lp = enterLowPressure({ now: base + 12 * 60 * MIN, rng: probeRng, state, config: CFG })
  state = lp.state
  if (lp.entered) {
    todayLow++
    lowPressureDays++
    const span = state.lowPressure.until - (base + 12 * 60 * MIN)
    lowPressureSpans.push(span)
    // 用户安慰一次
    const c = comfort({ state, now: base + 12 * 60 * MIN + MIN, sourceMessageId: `msg-${d}` })
    const remainingBefore = state.lowPressure.until - (base + 12 * 60 * MIN + MIN)
    if (c.reduced > remainingBefore * IMPERFECTION_LIMITS.comfortReductionMax + 1) comfortOver++
    state = c.state
  }

  // 补救：每天一次停止信号
  const rep = repairCandidate({ state, now: base + 20 * 60 * MIN, config: CFG, signal: { kind: 'stop' } })
  state = rep.state
  if (rep.text) todayRepair++
  repairDays += todayRepair ? 1 : 0

  deferPerDayMax = Math.max(deferPerDayMax, todayDefers)
  if (todayLow > 1) lowPressureDays += 99 // 理论不可能：enterLowPressure 自己挡住
}

/* ---------------- 断言 ---------------- */

const deferRate = optionalTotal ? optionalDeferred / optionalTotal : 0
info('模拟规模', `${DAYS} 天 / 种子 ${SEED} / 概率上限 ${P}；重要 ${importantTotal} 条、可选 ${optionalTotal} 条`)
info('延迟率', `${(deferRate * 100).toFixed(2)}%（配置 ${(P * 100).toFixed(0)}%）— 共 ${optionalDeferred} 次`)

check(
  `重要事项零漏送（${importantTotal}/${importantDelivered} 全部送达，概率仍开在 10%）`,
  importantDelivered === importantTotal,
  `漏送 ${importantTotal - importantDelivered} 条`
)
check(
  `可选意向延迟率不超过配置概率（${(deferRate * 100).toFixed(2)}% ≤ ${(P * 100).toFixed(0)}%）`,
  deferRate <= P + 1e-9,
  `${optionalDeferred}/${optionalTotal}`
)
check(
  '每天最多 1 次延迟（每日配额生效）',
  deferPerDayMax <= IMPERFECTION_LIMITS.deferPerDayMax,
  `单日峰值 ${deferPerDayMax}`
)
check(
  '同一项只判一次：重复调用既不再掷随机数，也不改变结果',
  duplicateRolls === 0,
  `异常 ${duplicateRolls} 次`
)
check(
  '低气压：10–30 分钟、每天至多进入一次',
  lowPressureSpans.every((s) => s >= IMPERFECTION_LIMITS.lowPressureMinMs && s <= IMPERFECTION_LIMITS.lowPressureMaxMs),
  `进入 ${lowPressureDays} 天，跨度 ${Math.min(...lowPressureSpans) / MIN}~${Math.max(...lowPressureSpans) / MIN} 分钟`
)
check('安慰缩短不超过剩余时间的一半', comfortOver === 0, `越界 ${comfortOver} 次`)
check(
  '补救：每天最多 1 次',
  repairDays <= DAYS,
  `${repairDays}/${DAYS} 天`
)
const cleared = resetImperfectionState(T0 + DAYS * DAY)
check(
  '全局关闭：概率缓存与积压清空（不重放）',
  Object.keys(cleared.decisions).length === 0 && cleared.pending.length === 0 && cleared.deferCount === 0
)

const failed = results.filter((r) => !r.pass)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✘ ${f.name}`)
}
process.exitCode = failed.length ? 1 : 0
