// src/core/relation/familiarity.js
// 熟悉度（关系层，S4）：把「认识了多久 / 一起活跃过多少天 / 聊过多少次」折算成 0~1 的关系分。
//
// 为什么用「活跃天数」而不是「天数」：装完放半年不用，不该算熟。
// 三条曲线各自饱和后按权重加权：
//   相识时长 0.30（30 天到 63%）
//   活跃天数 0.40（18 个活跃日到 63%）
//   互动次数 0.30（150 次到 63%）
// 结果用来做两件事：① 注入「此刻」上下文，她知道自己和你多熟；
// ② 落实人格设定里的护栏「熟悉度门槛不装亲密」——低等级会把"别装作很熟"写进提示。
//
// 纯函数，无 IO、无时间依赖（now 全部走参数），可单测。

const DAY_MS = 86400000

/** 关系等级（按 min 升序，右开区间）。note 会原样进提示词，所以要短、要是"行为约束"。 */
export const FAMILIARITY_LEVELS = [
  { key: 'stranger', min: 0, label: '陌生', note: '才刚开始，别装作很熟。' },
  { key: 'acquaintance', min: 0.15, label: '认识', note: '还不算熟人，客气一点。' },
  { key: 'familiar', min: 0.35, label: '熟悉', note: '可以自然些，不必每句都端着。' },
  { key: 'close', min: 0.62, label: '默契', note: '可以省掉客套，偶尔主动关心他的状态。' },
  { key: 'intimate', min: 0.85, label: '深交', note: '可以流露在意，但别越出自己的分寸。' }
]

/** 三条曲线的饱和尺度 */
export const GROWTH = { TENURE_DAYS: 30, ACTIVE_DAYS: 18, INTERACTIONS: 150 }
/** 权重（和为 1） */
export const WEIGHTS = { TENURE: 0.3, ACTIVE_DAYS: 0.4, INTERACTIONS: 0.3 }
/** 活跃日记录上限（约一年多；超出丢最早的） */
const MAX_ACTIVE_DAYS = 400

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** 指数饱和：x 到 k 时约 63% */
const grow = (x, k) => 1 - Math.exp(-Math.max(0, x) / k)

/** 本地日期键：2026-10-15 */
export function localDateKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 全新关系（首次见面） */
export function emptyStats(now = Date.now()) {
  return { firstMetAt: now, interactionCount: 0, activeDays: [], lastActiveDay: null }
}

/** 规范化外部传进来的 stats（容忍残缺/脏数据） */
export function normalizeStats(stats, now = Date.now()) {
  const s = stats && typeof stats === 'object' ? stats : {}
  const days = Array.isArray(s.activeDays) ? s.activeDays.filter((d) => typeof d === 'string' && d) : []
  return {
    firstMetAt: Number.isFinite(s.firstMetAt) ? s.firstMetAt : now,
    interactionCount: Math.max(0, Math.floor(Number(s.interactionCount) || 0)),
    activeDays: days.slice(-MAX_ACTIVE_DAYS),
    lastActiveDay: typeof s.lastActiveDay === 'string' ? s.lastActiveDay : null
  }
}

/**
 * 记一次互动（纯函数，返回新对象，不改原值）。
 * 互动 = 他跟我说了话 / 戳了我：只加次数与当天活跃，不直接加分。
 */
export function noteInteraction(stats, now = Date.now()) {
  const s = normalizeStats(stats, now)
  const key = localDateKey(now)
  const activeDays = s.activeDays.includes(key) ? s.activeDays : [...s.activeDays, key].slice(-MAX_ACTIVE_DAYS)
  return {
    firstMetAt: s.firstMetAt,
    interactionCount: s.interactionCount + 1,
    activeDays,
    lastActiveDay: key
  }
}

/** 关系分 0~1 */
export function familiarityScore(stats, now = Date.now()) {
  const s = normalizeStats(stats, now)
  const tenureDays = Math.max(0, (now - s.firstMetAt) / DAY_MS)
  return clamp01(
    WEIGHTS.TENURE * grow(tenureDays, GROWTH.TENURE_DAYS) +
      WEIGHTS.ACTIVE_DAYS * grow(s.activeDays.length, GROWTH.ACTIVE_DAYS) +
      WEIGHTS.INTERACTIONS * grow(s.interactionCount, GROWTH.INTERACTIONS)
  )
}

/** 分数 → 等级对象 */
export function familiarityLevel(score) {
  let hit = FAMILIARITY_LEVELS[0]
  for (const lv of FAMILIARITY_LEVELS) if (score >= lv.min) hit = lv
  return hit
}

/** 到下一个等级还要多少分、进度 0~1（已封顶则 level=null, progress=1） */
export function levelProgress(score) {
  const idx = FAMILIARITY_LEVELS.findIndex((lv) => lv.key === familiarityLevel(score).key)
  const next = FAMILIARITY_LEVELS[idx + 1]
  if (!next) return { level: null, progress: 1, needScore: 0 }
  const cur = FAMILIARITY_LEVELS[idx].min
  const span = next.min - cur
  return {
    level: next,
    progress: span > 0 ? clamp01((score - cur) / span) : 1,
    needScore: Math.max(0, next.min - score)
  }
}

/**
 * 汇总一份口径（IPC / 上下文注入 / 关系页共用，避免三处各算各的）。
 * @returns {{score:number, level:object, next:object|null, progress:number, needScore:number,
 *            firstMetAt:number, daysKnown:number, interactionCount:number,
 *            activeDays:number, lastActiveDay:string|null}}
 */
export function describeRelation(stats, now = Date.now()) {
  const s = normalizeStats(stats, now)
  const score = familiarityScore(s, now)
  const nx = levelProgress(score)
  return {
    score,
    level: familiarityLevel(score),
    next: nx.level,
    progress: nx.progress,
    needScore: nx.needScore,
    firstMetAt: s.firstMetAt,
    daysKnown: Math.max(0, Math.floor((now - s.firstMetAt) / DAY_MS)),
    interactionCount: s.interactionCount,
    activeDays: s.activeDays.length,
    lastActiveDay: s.lastActiveDay
  }
}
