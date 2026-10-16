// src/core/presence/imperfection.js
// 不完美机制（BLUE-4 / 契约 §5）：让「她可能会漏掉一句可选的话」成为可控、可关、可证明的东西。
//
// 硬边界（先读，改这个文件前必须认同）：
//   · **重要事项零遗忘**：提醒、日程、明确强调、带截止时间/时间敏感、文件/设备/钱/健康安全，
//     以及任何无法可靠分级的事项，一律 important。概率**绝不**作用于它们
//     ——本模块不提供任何可拦截 reminder 调度/工具执行的接口，也刻意不接 onDue。
//   · 概率只作用在**可选表达候选**层：用户可选的非时间敏感闲聊意向（例如「之后聊某个话题」）。
//   · 不谎称遗忘：defer 是「表达延迟」，必须保留源记录，且能说明这只是延迟；
//     不得说成数据库遗忘、不得靠重复调用把概率放大。
//   · 低气压不是生理疲倦，也不是责怪冷落：不关闭功能、不变慢工具、不扣减可靠性；
//     不伪造用户安慰（不碰互动计时）。
//   · v2 无毒舌人格：不生成主动吐槽；补救只做「停止 + 一次简短修复」，无辩解、不索求原谅。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

export const IMPERFECTION_LIMITS = {
  /** 概率可配上限（契约写死的 10%） */
  forgetProbabilityMax: 0.1,
  /** 概率默认（opt-in：默认 0 = 不延迟） */
  forgetProbabilityDefault: 0,
  /** 每天最多 defer 几次 */
  deferPerDayMax: 1,
  /** defer 最长多久（超时即恢复，等于「取消这次延迟」） */
  deferMaxMs: 10 * 60 * 1000,
  /** 低气压：每天最多 1 次、间隔 24 小时 */
  lowPressurePerDayMax: 1,
  lowPressureIntervalMs: 24 * 60 * 60 * 1000,
  /** 低气压持续时长范围（10–30 分钟） */
  lowPressureMinMs: 10 * 60 * 1000,
  lowPressureMaxMs: 30 * 60 * 1000,
  /** 安慰最多缩短剩余时间的一半；每段一次 */
  comfortReductionMax: 0.5,
  /** 自动补救：每天 1 次、间隔 6 小时 */
  repairPerDayMax: 1,
  repairIntervalMs: 6 * 60 * 60 * 1000
}

/** 涉及这些领域一律重要（不可靠分级时也按重要处理） */
const SENSITIVE_DOMAINS = ['file', 'device', 'money', 'health', 'safety', 'reminder', 'schedule']
/** 明确强调的信号词 */
const EMPHASIS_PATTERNS = [/一定|务必|千万|别忘了|记住|重要|必须/, /deadline|due\s/i]

export function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 1. 意向分级 ---------------- */

/**
 * 意向分级：**默认 important**，只有白名单条件齐全才判 low-risk。
 *
 * @param {{text?:string, kind?:string, domain?:string, hasDeadline?:boolean,
 *          timeSensitive?:boolean, explicitEmphasis?:boolean,
 *          sources?:Array<{id?:string,type?:string}>}} input
 * @returns {{level:'important'|'low-risk', reason:string, sourceIds:string[]}}
 */
export function classifyIntention(input = {}) {
  if (!input || typeof input !== 'object') return { level: 'important', reason: 'input-invalid', sourceIds: [] }
  const sources = Array.isArray(input.sources) ? input.sources.filter((s) => s && typeof s === 'object') : []
  const sourceIds = sources.map((s) => (typeof s.id === 'string' ? s.id : '')).filter(Boolean)
  const types = sources.map((s) => String(s.type || ''))
  const text = typeof input.text === 'string' ? input.text : ''
  const domain = String(input.domain || '')

  // 任何一条命中都按重要处理（宁可保守）
  if (types.some((t) => t.startsWith('reminder') || t.startsWith('schedule'))) {
    return { level: 'important', reason: 'source-reminder', sourceIds }
  }
  if (SENSITIVE_DOMAINS.includes(domain)) return { level: 'important', reason: 'domain-' + domain, sourceIds }
  if (input.hasDeadline === true) return { level: 'important', reason: 'deadline', sourceIds }
  if (input.timeSensitive === true) return { level: 'important', reason: 'time-sensitive', sourceIds }
  if (input.explicitEmphasis === true) return { level: 'important', reason: 'explicit-emphasis', sourceIds }
  for (const re of EMPHASIS_PATTERNS) {
    if (re.test(text)) return { level: 'important', reason: 'emphasis-pattern', sourceIds }
  }
  // 缺字段、说不清 → 重要（不可靠分级按重要处理）
  if (domain && !SENSITIVE_DOMAINS.includes(domain) && domain !== 'chat') {
    return { level: 'important', reason: 'domain-unknown', sourceIds }
  }
  if (!text.trim()) return { level: 'important', reason: 'no-text', sourceIds }
  // 白名单齐全：明确标注为可选闲聊意向
  if (input.kind === 'optional-chat' || domain === 'chat') {
    return { level: 'low-risk', reason: 'optional-chat', sourceIds }
  }
  return { level: 'important', reason: 'default-important', sourceIds }
}

/* ---------------- 2. 可选表达的概率门 ---------------- */

/** 全新侧车状态 */
export function emptyImperfectionState(now = Date.now()) {
  return {
    dayKey: dayKeyOf(now),
    deferCount: 0,
    lowPressureCount: 0,
    repairCount: 0,
    // id -> {action:'deliver'|'defer', decidedAt, until}
    decisions: {},
    pending: [],
    lowPressure: null, // {startedAt, until, comforted:boolean, comfortSourceId:string|null}
    lastLowPressureAt: 0,
    lastRepairAt: 0,
    repairIndex: 0
  }
}

export function normalizeImperfectionState(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const decisions = s.decisions && typeof s.decisions === 'object' ? s.decisions : {}
  const clean = {}
  for (const [id, d] of Object.entries(decisions)) {
    if (d && typeof d === 'object' && (d.action === 'deliver' || d.action === 'defer') && Number.isFinite(d.decidedAt)) {
      clean[id] = { action: d.action, decidedAt: d.decidedAt, until: Number.isFinite(d.until) ? d.until : d.decidedAt }
    }
  }
  const lp = s.lowPressure
  return {
    dayKey: typeof s.dayKey === 'string' && s.dayKey ? s.dayKey : dayKeyOf(now),
    deferCount: Math.max(0, Math.floor(Number(s.deferCount) || 0)),
    lowPressureCount: Math.max(0, Math.floor(Number(s.lowPressureCount) || 0)),
    repairCount: Math.max(0, Math.floor(Number(s.repairCount) || 0)),
    decisions: clean,
    pending: Array.isArray(s.pending) ? s.pending.filter((p) => p && typeof p.id === 'string') : [],
    lowPressure: lp && Number.isFinite(lp.startedAt) && Number.isFinite(lp.until)
      ? { startedAt: lp.startedAt, until: lp.until, comforted: lp.comforted === true, comfortSourceId: typeof lp.comfortSourceId === 'string' ? lp.comfortSourceId : null }
      : null,
    lastLowPressureAt: Number.isFinite(s.lastLowPressureAt) ? s.lastLowPressureAt : 0,
    lastRepairAt: Number.isFinite(s.lastRepairAt) ? s.lastRepairAt : 0,
    repairIndex: Math.max(0, Math.floor(Number(s.repairIndex) || 0))
  }
}

/** 全局关闭：清掉所有概率缓存与待办积压，不重放 */
export function resetImperfectionState(now = Date.now()) {
  return emptyImperfectionState(now)
}

/**
 * 跨本地日期的计数归零：每日配额（defer / 低气压 / 补救）都按**本地日期**计。
 * 三个入口共用，避免某一条路径漏掉归零而把「每天一次」变成「一辈子一次」。
 */
function rollover(state, now) {
  const cur = normalizeImperfectionState(state, now)
  const day = dayKeyOf(now)
  if (cur.dayKey === day) return cur
  return { ...cur, dayKey: day, deferCount: 0, lowPressureCount: 0, repairCount: 0 }
}

/**
 * 可选表达候选的门禁。
 *
 * - important → **永远 deliver**，且不调用随机数（这是「零遗忘」的证明点）；
 * - low-risk 且功能关闭 → deliver（opt-in，默认不延迟）；
 * - low-risk 且开启 → 每项**只判一次**（按 id 存决策），掷骰一次，命中才 defer；
 * - defer 受「每天 ≤1 次」限制；超过即 deliver（不能靠重复调用放大概率）；
 * - 之前 defer 过的项到期（>10 分钟）自动恢复为 deliver，并保留原决策记录。
 *
 * @param {{id:string,intention:object,now?:number,rng?:()=>number,config?:object,state?:object}} input
 * @returns {{action:'deliver'|'defer', state:object, reason:string, until:number|null}}
 */
export function decideOptionalFollowup({ id, intention, now = Date.now(), rng, config = {}, state } = {}) {
  const cfg = config || {}
  const next = rollover(state, now)
  const level = intention?.level || classifyIntention(intention).level
  const key = String(id || intention?.id || '')
  if (level !== 'low-risk') return { action: 'deliver', state: next, reason: 'important', until: null }
  if (!key) return { action: 'deliver', state: next, reason: 'no-id', until: null }
  if (cfg.enabled !== true) return { action: 'deliver', state: next, reason: 'disabled', until: null }

  const p = Math.max(0, Math.min(IMPERFECTION_LIMITS.forgetProbabilityMax, Number(cfg.forgetProbability ?? IMPERFECTION_LIMITS.forgetProbabilityDefault) || 0))
  if (p <= 0) return { action: 'deliver', state: next, reason: 'probability-zero', until: null }

  const prior = next.decisions[key]
  if (prior) {
    // 已判过：defer 到期则恢复（保留源记录，只是这次不再延迟）
    if (prior.action === 'defer' && now >= prior.until) {
      next.decisions = { ...next.decisions, [key]: { ...prior, action: 'deliver', decidedAt: now } }
      return { action: 'deliver', state: next, reason: 'defer-expired', until: prior.until }
    }
    return { action: prior.action, state: next, reason: 'already-decided', until: prior.until }
  }
  if (next.deferCount >= IMPERFECTION_LIMITS.deferPerDayMax) {
    next.decisions = { ...next.decisions, [key]: { action: 'deliver', decidedAt: now, until: now } }
    return { action: 'deliver', state: next, reason: 'daily-limit', until: null }
  }
  const roll = typeof rng === 'function' ? rng() : Math.random()
  if (!(roll < p)) {
    next.decisions = { ...next.decisions, [key]: { action: 'deliver', decidedAt: now, until: now } }
    return { action: 'deliver', state: next, reason: 'probability', until: null }
  }
  const until = now + IMPERFECTION_LIMITS.deferMaxMs
  next.deferCount += 1
  next.decisions = { ...next.decisions, [key]: { action: 'defer', decidedAt: now, until } }
  next.pending = [...next.pending, { id: key, until }]
  return { action: 'defer', state: next, reason: 'deferred', until }
}

/* ---------------- 3. 低气压（可选的低气压，不是疲倦） ---------------- */

/** 当前是否处于低气压；越界/到期即自动结束 */
export function lowPressureState(state, now = Date.now()) {
  const lp = state?.lowPressure
  if (!lp || !Number.isFinite(lp.until)) return { active: false, until: null, remainingMs: 0, comforted: false }
  if (now >= lp.until) return { active: false, until: lp.until, remainingMs: 0, comforted: lp.comforted === true }
  return { active: true, until: lp.until, remainingMs: lp.until - now, comforted: lp.comforted === true }
}

/**
 * 尝试进入低气压：只在功能开启、非忙碌、非危机、当天没进过、距上次 ≥24 小时时进入。
 * @returns {{state:object, entered:boolean, reason:string}}
 */
export function enterLowPressure({ now = Date.now(), rng, state, config = {}, busy = false, crisis = false } = {}) {
  const cfg = config || {}
  const cur = normalizeImperfectionState(state, now)
  const next = rollover(state, now)
  if (cfg.enabled !== true || cfg.lowPressureEnabled !== true) return { state: next, entered: false, reason: 'disabled' }
  if (busy || crisis) return { state: next, entered: false, reason: 'busy-or-crisis' }
  if (lowPressureState(next, now).active) return { state: next, entered: false, reason: 'already-active' }
  if (next.lastLowPressureAt && now - next.lastLowPressureAt < IMPERFECTION_LIMITS.lowPressureIntervalMs) {
    return { state: next, entered: false, reason: 'interval' }
  }
  if (next.lowPressureCount >= IMPERFECTION_LIMITS.lowPressurePerDayMax) return { state: next, entered: false, reason: 'daily-limit' }
  const span = IMPERFECTION_LIMITS.lowPressureMinMs +
    (typeof rng === 'function' ? rng() : Math.random()) * (IMPERFECTION_LIMITS.lowPressureMaxMs - IMPERFECTION_LIMITS.lowPressureMinMs)
  next.lowPressure = { startedAt: now, until: now + span, comforted: false, comfortSourceId: null }
  next.lowPressureCount += 1
  next.lastLowPressureAt = now
  return { state: next, entered: true, reason: 'entered' }
}

/** 自然恢复：到期即清；返回新状态 */
export function tickLowPressure(state, now = Date.now()) {
  const cur = normalizeImperfectionState(state, now)
  if (!cur.lowPressure) return cur
  if (now >= cur.lowPressure.until) return { ...cur, lowPressure: null }
  return cur
}

/**
 * 用户明确安慰 → 最多缩短剩余时间的一半；**每段只接受一次**。
 * 只改低气压剩余时间，绝不碰互动计时（不伪造用户安慰）。
 */
export function comfort({ state, now = Date.now(), sourceMessageId = null } = {}) {
  const cur = normalizeImperfectionState(state, now)
  if (!cur.lowPressure) return { state: cur, reduced: 0, reason: 'not-active' }
  if (cur.lowPressure.comforted) return { state: cur, reduced: 0, reason: 'already-comforted' }
  const remaining = cur.lowPressure.until - now
  if (remaining <= 0) return { state: { ...cur, lowPressure: null }, reduced: 0, reason: 'expired' }
  const cut = Math.floor(remaining * IMPERFECTION_LIMITS.comfortReductionMax)
  return {
    state: {
      ...cur,
      lowPressure: { ...cur.lowPressure, until: cur.lowPressure.until - cut, comforted: true, comfortSourceId: typeof sourceMessageId === 'string' ? sourceMessageId : null }
    },
    reduced: cut,
    reason: 'comforted'
  }
}

/** 给「表示文案」用的语气档位：低气压时更收敛（不改变事实、不关闭功能） */
export function expressionTone(state, now = Date.now()) {
  return lowPressureState(state, now).active ? 'subdued' : 'normal'
}

/* ---------------- 4. 补救回路（停止信号优先） ---------------- */

/** 停止 / 明确负面 / 越界三类信号识别（只识别，不生成吐槽） */
export function detectStopSignal(text) {
  const s = typeof text === 'string' ? text.trim() : ''
  if (!s) return { matched: false, kind: null }
  if (/^(停|别说了|别这样|够了|住口|打住)/.test(s) || /别说了|不要再|打住/.test(s)) return { matched: true, kind: 'stop' }
  if (/你不该这样|过分了|太过分|讨厌|烦人|你不该说/.test(s)) return { matched: true, kind: 'negative' }
  if (/越界|别提这个|不想聊这个|隐私/.test(s)) return { matched: true, kind: 'boundary' }
  return { matched: false, kind: null }
}

/** 简短修复候选（无辩解、不索求原谅；同一段内轮换措辞，避免固定台词） */
const REPAIR_LINES = {
  stop: ['好，我不说了。', '嗯，收住了。'],
  negative: ['这句我说重了，我收回。', '刚才是我不对，这句算我没说。'],
  boundary: ['这个我不该提，抱歉。', '越界了，我不往下说了。']
}

/**
 * 补救候选：立即停止优先，最多一次简短修复，每天 1 次、间隔 6 小时。
 * 被勿扰/只陪着压制时**仍保持停止**（不因压制而继续说）。
 */
export function repairCandidate({ state, now = Date.now(), config = {}, signal, privacy = {} } = {}) {
  const cfg = config || {}
  const next = rollover(state, now)
  const kind = signal?.kind || null
  if (!kind) return { text: null, state: next, reason: 'no-signal', stopped: false }
  // 停止立即生效：无论是否给修复文案
  if (!cfg.repairEnabled || cfg.enabled !== true) return { text: null, state: next, reason: 'disabled', stopped: true }
  if (privacy.doNotDisturb === true || privacy.onlyPresence === true) {
    return { text: null, state: next, reason: 'suppressed-still-stopped', stopped: true }
  }
  if (next.repairCount >= IMPERFECTION_LIMITS.repairPerDayMax) return { text: null, state: next, reason: 'daily-limit', stopped: true }
  if (next.lastRepairAt && now - next.lastRepairAt < IMPERFECTION_LIMITS.repairIntervalMs) {
    return { text: null, state: next, reason: 'interval', stopped: true }
  }
  const pool = REPAIR_LINES[kind] || REPAIR_LINES.stop
  const text = pool[next.repairIndex % pool.length]
  next.repairIndex = (next.repairIndex + 1) % pool.length
  next.repairCount += 1
  next.lastRepairAt = now
  return { text, state: next, reason: 'repair', stopped: true }
}
