// src/core/voice/backchannel.js
// 非语言语气音（回合首尾）——纯决策层。
//
// 范围（先读，别扩大）：
//   · 只做「回合开始 / 回合结尾」两个位置，**不做实时插话、不改回复正文**；
//   · 只用现有 TTS 念极短文本实现，**不引入新引擎、不引入音频素材**（契约 §3.6 红线）；
//   · 默认关闭（probability 默认 0）：默认行为与今天完全一致，一个字都不会多念；
//   · 语气音**不含任何语义内容**（不替她表态、不承诺、不追问），因此不受
//     「不催促 / 不索取安慰」等人格条款的额外约束，但仍受时段与勿扰压制。
//
// 能力边界（诚实写在这里）：「轻笑」无法用文本 TTS 合成得像——念出来的「呵」
// 是一个音节而不是笑声。要做真正的笑声必须引入音频素材（= 新增资源依赖，
// 与「不加新依赖」冲突），因此本期**不做轻笑**，只做文本能承载的沉吟 / 迟疑 /
// 叹气 / 收尾音。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。
// 时钟与随机数全部由入参注入，测试完全确定。

export const BACKCHANNEL_LIMITS = {
  /** 概率可配上限（语气音是点缀，压得很低） */
  probabilityMax: 0.3,
  /**
   * 概率默认 15%（D49，原为 0 = opt-in）。
   * 与 DEFAULT_VOICE_SETTINGS.backchannel.probability 保持一致：调用方漏传 probability 时
   * 不能悄悄退回 0，否则又是一个「开关开着但一次不出声」的假开。
   */
  probabilityDefault: 0.15,
  /** 每天最多几次 */
  perDayMax: 4,
  /** 两次语气音之间的最小间隔（避免变成口头禅） */
  minIntervalMs: 3 * 60 * 1000
}

/**
 * 候选库：phase → 情绪 → 文本候选。
 * 空数组 = 这个情绪在这个位置**本来就不出声**（不是"没配"，是有意留白，
 * 例如闹别扭时不接话、开心时收尾干脆）。
 * 文本一律极短、带标点、无语义；不要往里加台词。
 */
export const BACKCHANNEL_LIBRARY = {
  start: {
    calm: [{ text: '嗯。', kind: 'ack' }, { text: '嗯……', kind: 'think' }],
    smile: [{ text: '嗯。', kind: 'ack' }],
    joy: [{ text: '嗯。', kind: 'ack' }],
    puzzled: [{ text: '欸？', kind: 'doubt' }],
    worry: [{ text: '嗯……', kind: 'think' }],
    pout: [] // 闹别扭时不接话：留白本身就是表现
  },
  end: {
    calm: [{ text: '嗯。', kind: 'close' }],
    smile: [{ text: '嗯。', kind: 'close' }],
    joy: [], // 开心时收尾干脆，不拖泥带水
    puzzled: [{ text: '嗯……', kind: 'think' }],
    worry: [{ text: '唉……', kind: 'sigh' }],
    pout: [{ text: '哼。', kind: 'hmph' }]
  }
}

const PHASES = ['start', 'end']

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)
const isFiniteTs = (v) => typeof v === 'number' && Number.isFinite(v)

/** 与 presence 侧同名函数刻意重复一份：core/voice 不依赖 core/presence，可独立测试与复用 */
function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 状态 ---------------- */

export function emptyBackchannelState() {
  return { day: '', count: 0, lastAt: 0, lastText: '', lastKind: '' }
}

/** 把任意输入收敛成合法状态（脏数据 / 跨文件版本差异都不会让它崩） */
export function normalizeBackchannelState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    day: typeof s.day === 'string' ? s.day : '',
    count: Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : 0,
    lastAt: isFiniteTs(s.lastAt) ? s.lastAt : 0,
    lastText: typeof s.lastText === 'string' ? s.lastText : '',
    lastKind: typeof s.lastKind === 'string' ? s.lastKind : ''
  }
}

export function resetBackchannelState(now = Date.now()) {
  const s = emptyBackchannelState()
  s.day = dayKeyOf(isFiniteTs(now) ? now : Date.now())
  return s
}

/** 跨日归零（不重放积压）：只把计数清掉，lastAt 保留以维持间隔节奏 */
export function tickBackchannelState(state, now = Date.now()) {
  const s = normalizeBackchannelState(state)
  const day = dayKeyOf(isFiniteTs(now) ? now : Date.now())
  if (s.day && s.day !== day) return { ...s, day, count: 0 }
  return s.day ? s : { ...s, day }
}

/* ---------------- 决策 ---------------- */

/**
 * 是否在这一回合的开头/结尾加一句非语言语气音。
 *
 * @param {object} input
 *   phase    'start' | 'end'（其它值一律不出声）
 *   mood     情绪名（未知值按 calm；该情绪在该位置无候选则不出声）
 *   period   昼夜时段（'night' 默认压制，可用 config.allowAtNight 放开）
 *   quiet    是否处于勿扰/安静时段（true → 一律不出声）
 *   now      当前时间戳（注入，测试确定）
 *   state    上一次返回的 state（首次传 emptyBackchannelState()）
 *   config   { enabled, probability, perDayMax, minIntervalMs, allowAtNight }
 *   rng      随机数函数（注入，测试确定）
 * @returns {{text:string|null, kind:string, reason:string, state:object}}
 *   text 为 null = 这次不出声；reason 说明为什么（便于真机排查"怎么一直没听到"）
 */
export function decideBackchannel(rawInput) {
  // 入参可能是 null / 字符串 / 数组；一律收敛成空对象，绝不抛错
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}
  const now = isFiniteTs(input.now) ? input.now : Date.now()
  let state = tickBackchannelState(input.state, now)
  const none = (reason, kind = '') => ({ text: null, kind, reason, state })

  const config = input.config && typeof input.config === 'object' ? input.config : {}
  if (config.enabled !== true) return none('disabled')

  // 概率为 0（默认）等于关闭——不必等到掷骰子，直接给出可诊断的理由。
  // 上限在代码里也夹住，不只是设置页：语气音是点缀，配成 0.9 会变成口头禅。
  const cap = Math.min(1, BACKCHANNEL_LIMITS.probabilityMax)
  const raw = Number.isFinite(config.probability)
    ? config.probability
    : BACKCHANNEL_LIMITS.probabilityDefault
  const probability = Math.max(0, Math.min(cap, raw))
  if (probability <= 0) return none('probability-zero')

  if (!PHASES.includes(input.phase)) return none('bad-phase')

  // 勿扰优先于一切：安静时段她不该出声
  if (input.quiet === true) return none('do-not-disturb')
  if (input.period === 'night' && config.allowAtNight !== true) return none('quiet-night')

  const mood = typeof input.mood === 'string' ? input.mood : 'calm'
  const pool = (BACKCHANNEL_LIBRARY[input.phase] || {})[mood] || (BACKCHANNEL_LIBRARY[input.phase] || {}).calm
  if (!Array.isArray(pool) || !pool.length) return none('no-candidate')

  const perDayMax = Number.isFinite(config.perDayMax)
    ? Math.max(0, Math.floor(config.perDayMax))
    : BACKCHANNEL_LIMITS.perDayMax
  if (state.count >= perDayMax) return none('daily-limit')

  const minIntervalMs = Number.isFinite(config.minIntervalMs)
    ? Math.max(0, config.minIntervalMs)
    : BACKCHANNEL_LIMITS.minIntervalMs
  if (state.lastAt && now - state.lastAt < minIntervalMs) return none('too-soon')

  const rng = typeof input.rng === 'function' ? input.rng : Math.random
  const roll = clamp01(rng())
  if (roll >= probability) return none('not-this-time')

  // 选哪个候选要**另掷一次**：与上面那次共用 roll 的话，roll 已被概率门槛压在
  // [0, probability) 内，floor(roll * n) 会永远落在第一个候选上（第二个永不出现）。
  const pickRoll = clamp01(rng())
  const pick = pool.length > 1 ? Math.min(pool.length - 1, Math.floor(pickRoll * pool.length)) : 0
  const chosen = pool[Math.max(0, pick)] || pool[0]

  state = { ...state, count: state.count + 1, lastAt: now, lastText: chosen.text, lastKind: chosen.kind }
  return { text: chosen.text, kind: chosen.kind, reason: 'ok', state }
}
