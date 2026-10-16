// src/core/reminders/schedule.js
// 日程提醒的纯逻辑：时间解析 / 到期判定 / 重复推进 / 展示格式化。
//
// 为什么单独抽一层：模型说「三分钟后提醒我」或「明天九点开会」时给的是自然语言，
// 而调度器要的是绝对时间戳。把这段解析与判定做成纯函数，既能单测，又不依赖 Electron。
//
// 无 Electron / Node 依赖。

export const REPEATS = ['none', 'daily', 'weekly']
export const REPEAT_LABEL = { none: '不重复', daily: '每天', weekly: '每周' }

/** 最多保存多少条（超出先丢已完成的，再丢最早的） */
export const REMINDER_LIMIT = 100
/** 时间太近（<5 秒）视为「此刻」，避免建完就立刻过期 */
export const MIN_AHEAD_MS = 5000
/** 最远只接受一年后（防模型算出离谱时间） */
export const MAX_AHEAD_MS = 366 * 86400000

const DAY_MS = 86400000
const HOUR_MS = 3600000
const MIN_MS = 60000

const pad2 = (n) => String(n).padStart(2, '0')

/** 当天的 00:00（本地时区） */
export function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地日期串 YYYY-MM-DD */
export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function sameDay(a, b) {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/* ---------------- 时间解析 ---------------- */

const WEEKDAY_CN = { 日: 0, 天: 0, 七: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 末: 6 }

/**
 * 相对时间：「10分钟后」「半小时后」「2小时」「1天后」「一会儿」。
 * @returns {number|null} 相对现在的毫秒数；识别不出返回 null
 */
function parseRelative(s) {
  const t = String(s).replace(/\s+/g, '').toLowerCase()
  if (/^(一|待)?会儿$|^马上$|^立刻$|^稍后$|^待会$/.test(t)) return 10 * MIN_MS

  let ms = 0
  let hit = false
  const take = (re, unit) => {
    const m = t.match(re)
    if (m) {
      ms += Number(m[1]) * unit
      hit = true
    }
  }
  take(/(\d+(?:\.\d+)?)(?:天|日)后/, DAY_MS)
  take(/(\d+(?:\.\d+)?)(?:个)?(?:小时|钟头)后/, HOUR_MS)
  take(/(\d+(?:\.\d+)?)(?:分钟|分)后/, MIN_MS)
  take(/(\d+(?:\.\d+)?)秒后/, 1000)
  if (/(半(?:个)?小时|半刻钟)后/.test(t)) {
    ms += 30 * MIN_MS
    hit = true
  }

  // 英文 in 5 minutes
  const en = t.match(/^in(\d+)(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days)$/)
  if (en) {
    const n = Number(en[1])
    const u = en[2]
    ms += n * (u.startsWith('sec') ? 1000 : u.startsWith('min') ? MIN_MS : u.startsWith('hour') ? HOUR_MS : DAY_MS)
    hit = true
  }
  return hit ? ms : null
}

/** 日期词 → 天数偏移 / 星期；返回 { rest, dayOffset, weekday, impliedPeriod } */
function extractDay(s) {
  let rest = s
  let dayOffset = null
  let weekday = null
  let impliedPeriod = null

  const consume = (re) => {
    const m = rest.match(re)
    if (m) {
      rest = rest.replace(re, '')
      return m
    }
    return null
  }

  const mWeek = consume(/(下{0,2}(?:个)?(?:周|星期|礼拜))([一二三四五六日天七末])/)
  if (mWeek) {
    weekday = WEEKDAY_CN[mWeek[2]]
    return { rest, dayOffset: null, weekday, impliedPeriod }
  }

  const dayWords = [
    [/大后天/, 3, null],
    [/后天/, 2, null],
    [/明晚/, 1, 'pm'],
    [/明早|明晨/, 1, 'am'],
    [/明天|明日|明儿/, 1, null],
    [/今晚/, 0, 'pm'],
    [/今早|今晨/, 0, 'am'],
    [/今天|今日|今儿/, 0, null]
  ]
  for (const [re, off, period] of dayWords) {
    if (re.test(rest)) {
      rest = rest.replace(re, '')
      dayOffset = off
      impliedPeriod = period
      break
    }
  }
  return { rest, dayOffset, weekday, impliedPeriod }
}

/** 时段词 → 小时修正函数 */
function extractPeriod(s) {
  if (/凌晨/.test(s)) return (h) => h
  if (/清晨|早晨|早上|上午|早/.test(s)) return (h) => (h === 12 ? 0 : h)
  if (/中午|正午/.test(s)) return (h) => (h < 12 ? h + 12 : h)
  if (/下午|午后/.test(s)) return (h) => (h < 12 ? h + 12 : h)
  if (/傍晚/.test(s)) return (h) => (h < 12 ? h + 12 : h)
  if (/晚上|夜里|深夜|晚|夜/.test(s)) return (h) => (h < 12 ? h + 12 : h)
  return null
}

/** 从字符串里取时钟：3点 / 3点半 / 15:30 / 3点15分 */
function extractClock(s) {
  const t = String(s).replace(/：/g, ':').replace(/点半/g, '点30').replace(/\s+/g, '')
  const m = t.match(/(\d{1,2})[点:](\d{1,2})(?:分)?/)
  if (m) {
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (hour > 23 || minute > 59) return null
    return { hour, minute }
  }
  const m2 = t.match(/(\d{1,2})点(?:整)?/)
  if (m2) {
    const hour = Number(m2[1])
    if (hour > 23) return null
    return { hour, minute: 0 }
  }
  return null
}

/**
 * 绝对时间：「明天9:00」「下午3点半」「周五十点」「9点」。
 * @returns {number|null} 时间戳；识别不出返回 null
 */
function parseAbsolute(input, now) {
  const s = String(input)
  const { rest, dayOffset, weekday, impliedPeriod } = extractDay(s)
  const clock = extractClock(rest)
  if (!clock) return null

  const period = (impliedPeriod === 'pm' ? extractPeriod('晚') : impliedPeriod === 'am' ? extractPeriod('早') : null) || extractPeriod(rest)
  let hour = clock.hour
  if (period) hour = period(hour)
  const minutes = hour * 60 + clock.minute

  const base = startOfDay(now)
  const nowMinutes = new Date(now).getHours() * 60 + new Date(now).getMinutes()

  if (weekday != null) {
    const cur = new Date(now).getDay()
    let diff = (weekday - cur + 7) % 7
    if (diff === 0 && minutes <= nowMinutes) diff = 7
    return base + diff * DAY_MS + minutes * MIN_MS
  }
  if (dayOffset != null) {
    return base + dayOffset * DAY_MS + minutes * MIN_MS
  }
  // 没有日期词：今天该时刻已过就顺延到明天
  const today = base + minutes * MIN_MS
  return today > now ? today : today + DAY_MS
}

/**
 * 把一段自然语言时间解析成绝对时间戳。
 * @param {string|number} input
 * @param {number} [now]
 * @returns {{at:number}|{error:string}}
 */
export function parseWhen(input, now = Date.now()) {
  if (input == null) return { error: '缺少时间' }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { error: '时间无效' }
    // 十位数字按「秒」理解，其余按「毫秒」
    return { at: Math.round(input < 1e11 ? input * 1000 : input) }
  }
  const s = String(input).trim()
  if (!s) return { error: '缺少时间' }
  // 纯数字串：同样按秒/毫秒判别
  if (/^\d{10,}$/.test(s)) {
    const n = Number(s)
    return { at: n < 1e11 ? n * 1000 : n }
  }

  // 带年份的完整日期（2026-10-20 09:00 / 2026年10月20日）先交给标准解析——
  // 否则会被下面的「裸时钟」规则抢先匹配到「09:00」，误判成今天/明天
  if (/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/.test(s)) {
    const norm = s.replace(/[年月]/g, '-').replace(/日/g, ' ').replace(/\//g, '-').replace(/\s+/g, ' ').trim()
    const t = Date.parse(norm)
    if (!Number.isNaN(t)) return { at: t }
  }

  const rel = parseRelative(s)
  if (rel != null) return { at: now + rel }

  const abs = parseAbsolute(s, now)
  if (abs != null) return { at: abs }

  // 最后尝试标准日期解析（带年份的 ISO / 2026-10-16 09:00）
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return { at: t }

  return { error: `没法辨认这个时间：${input}` }
}

/* ---------------- 条目规范化与判定 ---------------- */

/** 把磁盘/工具里的原始对象规范成内部条目；非法则返回 null */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text || '').trim()
  if (!text) return null
  const at = Number(raw.at)
  if (!Number.isFinite(at)) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : '',
    text: text.slice(0, 200),
    say: raw.say ? String(raw.say).slice(0, 300) : '',
    at: Math.round(at),
    repeat: REPEATS.includes(raw.repeat) ? raw.repeat : 'none',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Math.round(at),
    firedAt: Number.isFinite(raw.firedAt) ? raw.firedAt : null,
    missedAt: Number.isFinite(raw.missedAt) ? raw.missedAt : null,
    doneAt: Number.isFinite(raw.doneAt) ? raw.doneAt : null
  }
}

/** 规范化一批，丢掉非法的，并按「未完成在前、时间近在前」排好 */
export function normalizeItems(list) {
  return sortItems((Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean))
}

export function isDue(item, now = Date.now()) {
  return !!(item && !item.doneAt && !item.missedAt && Number.isFinite(item.at) && item.at <= now)
}

/**
 * 重复提醒触发后推进到下一次（错过的多次只推到下一次，不补偿）。
 * @returns {object|null} 推进后的新条目；不重复则返回 null
 */
export function advanceRepeat(item, now = Date.now()) {
  const step = item.repeat === 'daily' ? DAY_MS : item.repeat === 'weekly' ? 7 * DAY_MS : 0
  if (!step) return null
  let at = item.at
  let guard = 0
  while (at <= now && guard++ < 1000) at += step
  return { ...item, at, firedAt: now }
}

/** 排序：未完成在前，各自按触发时间升序 */
export function sortItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const ad = a.doneAt ? 1 : 0
    const bd = b.doneAt ? 1 : 0
    if (ad !== bd) return ad - bd
    return a.at - b.at
  })
}

/* ---------------- 展示格式化 ---------------- */

/** 「今天 15:30」/「明天 09:00」/「10月20日 09:00」 */
export function formatWhen(at, now = Date.now()) {
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (sameDay(at, now)) return `今天 ${hm}`
  if (sameDay(at, startOfDay(now) + DAY_MS)) return `明天 ${hm}`
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}

/** 「还有 3 小时」/「已过 2 分钟」 */
export function remainingText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return ''
  const ms = at - now
  const past = ms < 0
  const a = Math.abs(ms)
  let s
  if (a < MIN_MS) s = `${Math.max(1, Math.round(a / 1000))} 秒`
  else if (a < HOUR_MS) s = `${Math.round(a / MIN_MS)} 分钟`
  else if (a < DAY_MS) s = `${Math.round(a / HOUR_MS)} 小时`
  else s = `${Math.round(a / DAY_MS)} 天`
  return past ? `已过 ${s}` : `还有 ${s}`
}

/** 一行摘要（列表 / 日志用） */
export function describeItem(item, now = Date.now()) {
  const when = formatWhen(item.at, now)
  const rep = item.repeat && item.repeat !== 'none' ? `（${REPEAT_LABEL[item.repeat]}）` : ''
  return `${when}${rep} ${item.text}`
}
