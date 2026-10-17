// src/core/presence/anchors.js
// 回忆物锚点（BLUE-3c）：她可以自然提起的共同记忆点。
//
// 契约（§4）：
//   · 接口 `listAnchors({now, relationLevel, sources, config})`；
//   · **引用前重验来源**：任何一个来源被删除/不可访问，整个锚点就不出现（不能引用已撤回的东西）；
//   · 熟悉度门槛：私密锚点（昵称 / 共同引用 / 承诺）在熟悉度不足时不使用；
//   · 引用是克制的：每次候选引用概率 ≤5%、每天 ≤1 次，**不为凑概率制造回忆**
//     （概率门只决定「这次要不要提」，不提就不提，不重试、不补话）。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

export const ANCHOR_LIMITS = {
  /** 候选引用概率上限（契约写死的 5%） */
  referenceProbability: 0.05,
  /** 每天最多引用几次 */
  perDayMax: 1
}

export const ANCHOR_KINDS = ['first-contact', 'nickname', 'shared-reference', 'promise']
/** 私密锚点：熟悉度不足时不使用 */
export const PRIVATE_ANCHOR_KINDS = ['nickname', 'shared-reference', 'promise']
export const ANCHOR_TRUST = ['observed', 'user-stated', 'subjective']

/** 熟悉度等级顺序（与 core/relation/familiarity.js 的 key 一致；避免跨模块 import 只为顺序） */
const LEVEL_ORDER = ['stranger', 'acquaintance', 'familiar', 'close', 'intimate']
/** 私密锚点需要的最低熟悉度 */
export const PRIVATE_ANCHOR_MIN_LEVEL = 'familiar'

export function familiarityRank(levelKey) {
  const i = LEVEL_ORDER.indexOf(levelKey)
  return i < 0 ? 0 : i
}

export function isLevelAtLeast(levelKey, requiredKey) {
  return familiarityRank(levelKey) >= familiarityRank(requiredKey)
}

export function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一个锚点是否可用：来源齐全且都没被删除 */
function usableAnchor(anchor, evidenceMap) {
  if (!anchor || typeof anchor !== 'object') return false
  if (!ANCHOR_KINDS.includes(anchor.kind)) return false
  if (!ANCHOR_TRUST.includes(anchor.trust)) return false
  if (anchor.deletedAt) return false
  const ids = Array.isArray(anchor.sourceIds) ? anchor.sourceIds.filter((x) => typeof x === 'string' && x) : []
  if (!ids.length) return false
  // 重验：每个来源都得仍可访问且没被删（来源=记忆条目/账本条目/承诺簿条目）
  return ids.every((id) => {
    const src = evidenceMap.get(id)
    return !!src && !src.deletedAt
  })
}

/**
 * 列出当前可用的锚点。
 *
 * @param {{now?:number, relationLevel?:string, anchors?:object[], evidence?:object[], config?:object}} input
 *   anchors ：候选锚点（见契约 §4 形状：{id,kind,sourceIds,occurredAt,trust,deletedAt?,text?}）
 *   evidence：**当前可访问的来源登记表** [{id, deletedAt?}]，用来重验锚点的每个 sourceId
 * @returns {object[]} 可用锚点（保持入参顺序）
 */
export function listAnchors({ now = Date.now(), relationLevel = 'stranger', anchors = [], evidence = [], config = {} } = {}) {
  if (config.anchorsEnabled !== true) return []
  const map = new Map()
  for (const s of Array.isArray(evidence) ? evidence : []) {
    if (s && typeof s.id === 'string' && s.id) map.set(s.id, s)
  }
  return (Array.isArray(anchors) ? anchors : [])
    .filter((a) => usableAnchor(a, map))
    // 私密锚点要够熟
    .filter((a) => !PRIVATE_ANCHOR_KINDS.includes(a.kind) || isLevelAtLeast(relationLevel, PRIVATE_ANCHOR_MIN_LEVEL))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      sourceIds: [...a.sourceIds],
      occurredAt: Number.isFinite(a.occurredAt) ? a.occurredAt : now,
      trust: a.trust,
      text: typeof a.text === 'string' ? a.text : '',
      deletedAt: a.deletedAt || null
    }))
}

/* ---------------- 时间线视图（只读） ---------------- */

/**
 * 按发生时间**倒序**排（最近的在前）。
 * 时间缺失或非法的排在最末尾，**并且不猜、不补默认值**（没有时间就是没有时间，
 * 视图层如实显示「时间不明」）；它们之间保持原有相对顺序。
 *
 * 纯函数：不修改入参数组。
 */
export function sortAnchorsByTime(list) {
  const arr = Array.isArray(list) ? list.slice() : []
  const timeOf = (a) => (a && Number.isFinite(a.occurredAt) ? a.occurredAt : null)
  // sort 在 ES2019 起保证稳定，时间都缺失时返回 0 即可保持原序
  return arr.sort((a, b) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    if (ta === null && tb === null) return 0
    if (ta === null) return 1
    if (tb === null) return -1
    return tb - ta
  })
}

/**
 * 按天分组，供时间线视图画日期小标题。组内仍是时间倒序。
 * @param {object[]} list
 * @returns {Array<{day:string, items:object[]}>} day 为 '' 表示时间不明
 */
export function groupAnchorsByDay(list) {
  const out = []
  let cur = null
  for (const a of sortAnchorsByTime(list)) {
    const day = a && Number.isFinite(a.occurredAt) ? dayKeyOf(a.occurredAt) : ''
    if (!cur || cur.day !== day) {
      cur = { day, items: [] }
      out.push(cur)
    }
    cur.items.push(a)
  }
  return out
}

/** 全新引用状态 */
export function emptyAnchorState(now = Date.now()) {
  return { dayKey: dayKeyOf(now), count: 0, lastAt: 0, lastAnchorId: null }
}

export function normalizeAnchorState(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    dayKey: typeof s.dayKey === 'string' && s.dayKey ? s.dayKey : dayKeyOf(now),
    count: Math.max(0, Math.floor(Number(s.count) || 0)),
    lastAt: Number.isFinite(s.lastAt) ? s.lastAt : 0,
    lastAnchorId: typeof s.lastAnchorId === 'string' ? s.lastAnchorId : null
  }
}

/**
 * 决定「这次要不要提起某个回忆」。
 *
 * 概率门只在**是否提起**这一层：没通过就是这次不提，不重掷、不改写内容、不补一句别的。
 *
 * @param {{anchors:object[],evidence:object[],now?:number,state?:object,rng?:()=>number,config?:object,relationLevel?:string}} input
 * @returns {{anchor:object|null, state:object, reason:string}}
 */
export function decideAnchorReference({ anchors = [], evidence = [], now = Date.now(), state, rng, config = {}, relationLevel = 'stranger' } = {}) {
  const cur = normalizeAnchorState(state, now)
  if (config.anchorsEnabled !== true) return { anchor: null, state: cur, reason: 'disabled' }
  const today = dayKeyOf(now)
  const count = cur.dayKey === today ? cur.count : 0
  if (count >= ANCHOR_LIMITS.perDayMax) return { anchor: null, state: { ...cur, dayKey: today, count }, reason: 'daily-limit' }
  // 先筛可用锚点；没有可用锚点时连骰子都不掷（不为凑概率制造回忆）
  const pool = listAnchors({ now, relationLevel, anchors, evidence, config })
  if (!pool.length) return { anchor: null, state: cur, reason: 'no-anchor' }
  // 不重复同一张：上次提过的排到后面，但不因此提高概率
  const ordered = [...pool.filter((a) => a.id !== cur.lastAnchorId), ...pool.filter((a) => a.id === cur.lastAnchorId)]
  const roll = typeof rng === 'function' ? rng() : Math.random()
  const p = Math.max(0, Math.min(ANCHOR_LIMITS.referenceProbability, Number(config.anchorProbability ?? ANCHOR_LIMITS.referenceProbability) || 0))
  if (!(roll < p)) return { anchor: null, state: cur, reason: 'probability' }
  const anchor = ordered[0]
  return { anchor, state: { dayKey: today, count: count + 1, lastAt: now, lastAnchorId: anchor.id }, reason: 'accepted' }
}
