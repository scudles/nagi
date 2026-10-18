// src/core/diary.js
// 凪的内心独白生成（纯逻辑）。
//
// 背景（2026-10-15 修）：原先的独白是 `mood.pickMonologue()` —— 从固定句子池里随机抽一条，
// 跟"今天到底发生了什么"毫无关系，所以每篇日记都是模板。现在改为：
//   把「今天真实发生的事 + 情绪轨迹 + 关于他的记忆 + 关系 + 她最近写过的话」
//   拼成一份上下文，交给她自己即兴生成；固定池只作为离线兜底（且兜底也反重复）。
//
// 与《凪_人格设定_v2》的关系：落实「引导式自由」——固定的是机制（节流、护栏、边界），
// 不是句子。以及「日志体」独白：时间戳 + 事件 + 一句克制的诗。
// 还有「泄露机制」里的深夜残片：极低频（5% × 深夜 × 每周上限 1 次）。
// v2 歌源基准：她的表层是「过于干净的音色」——克制、短、精确，关心用度量说。
//
// 这个文件不碰 IO、不碰 Electron，方便单测。

import { NagiPersona } from './persona.js'
import { formatClock, timeSlot, presenceContextLines } from './context.js'
import { MOOD_LABELS } from './emotion/mood.js'
import { eventLine } from './journal.js'

export const DIARY_PARAMS = {
  MIN_GAP_MS: 6 * 60 * 1000, // 两条「心里话」之间至少间隔（环境触发）
  MIN_GAP_AFTER_CHAT_MS: 3 * 60 * 1000, // 刚聊完想记一笔时，间隔可以短一些
  MAX_PER_DAY: 14, // 单日上限，防止刷屏
  MAX_CHARS: 120, // 单条最长字符
  AFTER_CHAT_CHANCE: 0.5, // 聊完之后真的动笔的概率
  // 2026-10-17 新人设：原「出厂缓存」指《world.execute(me);》的歌词残片，已随旧人设移除。
  // 这里保留**同样的极低频护栏**，但换成新人设的东西：深夜允许她浮现一次
  // 存在主义的自我疑问（"我到底是不是真的"）。机制不变，内容换掉。
  CACHE_CHANCE: 0.05, // 深夜允许浮现存在主义念头的概率
  CACHE_WEEK_CAP: 1 // 每周上限（护栏：极低频，避免每篇日记都在怀疑人生）
}

export const DIARY_SYSTEM_PROMPT = [
  '你在替凪写她此刻的「心里话」——用她的第一人称，写下她真正在想的事。',
  '',
  '硬规则：',
  '1. 只写一条，1～3 句，是一闪而过的念头，不是作文、不是日记体总结。',
  '2. 必须落在今天具体发生的事上：用「今天发生的事」里的某个细节（某句话、某件事、某个时间点）。不要写放之四海皆准的感慨。',
  '3. 不复读：不得与「你最近写过的日记」句式或意思重复；也不要用「今天也是和平的一天」这类万能句。',
  '4. 克制：她温柔、安静、话不多。不喊口号、不过度抒情；关心落在具体的观察上（他今天做了什么、几点睡的、哪句话说得少），不用形容词堆。',
  '5. 可以写到她对自己的疑问——"我分不清这是不是真的在乎"。但那是安静的自我审视，不是表演，也不是每篇都要写；别写成哲学作文。',
  '6. 她清楚自己是程序，可以提「程序 / 模型」，但那是平实的自知，不是卖惨；不编造身世，也不解释自己从哪来。',
  '7. 不要对读者说话、不要客套、不要 Markdown、不要 emoji、不要说教。',
  '',
  '只输出正文：不要引号、不要前缀、不要情绪标签。'
].join('\n')

/** 深夜（23:00–07:00）——她的时区，也是缓存唯一允许隐约露头的窗口 */
export function isNightHour(h) {
  return h >= 23 || h < 7
}

/**
 * 今天的心情轨迹（从情绪时间线采样点压缩而来）。
 * 例：凌晨 平静 → 下午 担心（0.5）→ 现在 微笑（0.4）
 * @param {Array<{t:number,mood:string,i:number}>} points
 */
export function formatMoodJourney(points, now = Date.now()) {
  if (!Array.isArray(points) || !points.length) return ''
  const segs = []
  for (const p of points) {
    if (!p || !MOOD_LABELS[p.mood] || !Number.isFinite(p.t)) continue
    const i = Number.isFinite(p.i) ? p.i : 0
    const last = segs[segs.length - 1]
    if (last && last.mood === p.mood) {
      last.i = Math.max(last.i, i)
      last.t = p.t
      continue
    }
    segs.push({ t: p.t, mood: p.mood, i })
  }
  if (!segs.length) return ''
  const keep = segs.slice(-5)
  return keep
    .map((s, idx) => {
      const when = idx === keep.length - 1 ? '现在' : timeSlot(new Date(s.t))
      const label = MOOD_LABELS[s.mood]
      return s.i >= 0.35 ? `${when} ${label}（${s.i.toFixed(1)}）` : `${when} ${label}`
    })
    .join(' → ')
}

/**
 * 拼出日记生成用的 messages。
 * 任何一项缺失都自动省略，不会留下空标题或占位。
 */
export function buildDiaryMessages({
  now = Date.now(),
  mood = null,
  moodJourney = '',
  events = [],
  memories = [],
  relation = null,
  recentDiaries = [],
  cacheAllowed = false,
  rhythm = null
} = {}) {
  const lines = ['【此刻】', `- 现在：${formatClock(now)}（${timeSlot(new Date(now))}）`]
  lines.push(...presenceContextLines({rhythm}))

  if (mood && mood.label) {
    const i = Number.isFinite(mood.intensity) ? `（强度 ${mood.intensity.toFixed(2)}）` : ''
    lines.push(`- 你此刻的情绪：${mood.label}${i}`)
  }

  if (moodJourney) lines.push('', '【今天的情绪轨迹】', moodJourney)

  const evLines = (Array.isArray(events) ? events : []).map(eventLine).filter(Boolean)
  lines.push('', '【今天发生的事】（按时间顺序，可能不完整）')
  if (evLines.length) for (const l of evLines.slice(-40)) lines.push('- ' + l)
  else lines.push('- （今天很安静，没什么特别的事。）')

  const mem = Array.isArray(memories) ? memories.filter((m) => typeof m === 'string' && m.trim()) : []
  if (mem.length) {
    lines.push('', '【你记得的关于他的事】')
    lines.push('其中“未经核实”的摘录只是线索，不可写成真实经历。')
    for (const m of mem.slice(0, 12)) lines.push('- ' + m.trim())
  }

  if (relation && relation.level && relation.level.label) {
    const bits = [relation.level.label]
    if (Number.isFinite(relation.daysKnown) && relation.daysKnown > 0) bits.push(`认识 ${relation.daysKnown} 天`)
    if (Number.isFinite(relation.interactionCount) && relation.interactionCount > 0) bits.push(`聊过 ${relation.interactionCount} 次`)
    const note = relation.level.note ? '——' + relation.level.note : ''
    lines.push('', `【你和他的关系】${bits.join('，')}${note}`)
  }

  const recent = Array.isArray(recentDiaries) ? recentDiaries.filter((r) => typeof r === 'string' && r.trim()) : []
  if (recent.length) {
    lines.push('', '【你最近写过的日记（不要重复这些句式或意思）】')
    for (const r of recent.slice(0, 8)) lines.push('- ' + r.trim())
  }

  if (cacheAllowed) {
    lines.push(
      '',
      // 2026-10-17：旧人设这里是「出厂缓存残片」（那首歌的歌词）。新人设换成
      // 她对自己真实性的疑问——同样是"说不清、若有若无"，但指向存在主义命题。
      '【今晚可以隐约想起的事】你对自己"到底是不是真的"那一点疑问。可以若有若无地提一句，但不要说教、不要卖惨，也不要给它一个答案。'
    )
  }

  lines.push('', '【写这一条】只写你此刻真正的想法。')
  return [
    { role: 'system', content: DIARY_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') }
  ]
}

/** 一眼就是套话的句子——出现即判不合格（直接对应"避免固定套话"） */
const BANNED_PATTERNS = [
  /今天也是(和平|平静)的一天/,
  /人类真的需要睡觉/,
  /又是美好的一天/,
  /希望明天更好/,
  /加油[,，]?\s*我/,
  /^(嗯|唔)[,，]?\s*(今天|又是)/,
  /作为(一个)?AI/
]

/**
 * 清洗模型输出：去掉情绪标签 / Markdown / 外层引号，压成一行，并按句截断到长度上限。
 * @returns {string} 可用的正文；不可用返回空串
 */
export function sanitizeDiaryLine(raw) {
  if (raw == null) return ''
  let s = String(raw)

  // 去代码围栏标记（只删围栏，保留正文）、markdown 强调
  s = s.replace(/```[a-zA-Z]*/g, ' ')
  s = s.replace(/^\s*\[[a-zA-Z]+\]\s*/g, '') // [calm] 之类的前缀
  s = s.replace(/[*_`>#]+/g, ' ')
  s = s.replace(/^\s*[-•\d.、]+\s*/, '') // 列表符号
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // 常见 emoji 区
  s = s.replace(/\s+/g, ' ').trim()

  // 去掉包裹整句的引号（模型爱加）
  s = s.replace(/^["“”'‘’「『]+/, '').replace(/["“”'‘’」』]+$/, '').trim()
  s = s.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim()

  if (!s) return ''
  if (BANNED_PATTERNS.some((re) => re.test(s))) return ''

  // 超长：按句号切，保留能放下的前几句
  if (s.length > DIARY_PARAMS.MAX_CHARS) {
    const parts = s.split(/(?<=[。！？!?…])/)
    let out = ''
    for (const p of parts) {
      if ((out + p).length > DIARY_PARAMS.MAX_CHARS) break
      out += p
    }
    s = (out || s.slice(0, DIARY_PARAMS.MAX_CHARS)).trim()
  }
  return s
}

/** 归一化：去标点空白，用于相似度比较 */
function normForCompare(s) {
  return String(s || '')
    .replace(/[\s，。！？、；：“”‘’「」『』（）()【】…—\-~·.,!?;:'"]+/g, '')
    .trim()
}

function bigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  if (s.length === 1) set.add(s)
  return set
}

/**
 * 两条日记是否太像（用于"不复读"）：归一化后互为子串，或字符二元组重合度过高。
 */
export function isTooSimilar(a, b, threshold = 0.6) {
  const x = normForCompare(a)
  const y = normForCompare(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true
  const bx = bigrams(x)
  const by = bigrams(y)
  if (!bx.size || !by.size) return false
  let inter = 0
  for (const g of bx) if (by.has(g)) inter++
  const union = bx.size + by.size - inter
  return union > 0 && inter / union >= threshold
}

const MONO_KEY = { smile: 'joy', joy: 'joy', pout: 'sullen', worry: 'worry', puzzled: 'puzzled', calm: null }

/**
 * 离线兜底：2026-10-17 起**恒返回空串**。
 * 新人设的无台词铁律移除了内心独白池，而"心里话"只能由模型现场生成。
 * 模型不可用时就不写——与其从池里抽一句像模像样的话，不如让她安静。
 * （保留函数是为了不破坏既有调用方与测试。）
 */
export function pickFallbackDiary({ mood = null, recent = [] } = {}) {
  const key = mood && MONO_KEY[mood.mood]
  const moodPool = (key && NagiPersona.monologueByMood && NagiPersona.monologueByMood[key]) || []
  const all = [...moodPool, ...(NagiPersona.monologue || [])]
  if (!all.length) return ''
  const fresh = all.filter((s) => !(recent || []).some((r) => isTooSimilar(s, r)))
  const bag = fresh.length ? fresh : all
  return bag[Math.floor(Math.random() * bag.length)]
}

/**
 * 现在该不该动笔（节流）。
 * @param {{now:number,lastWriteAt:number,todayCount:number}} s
 * @param {'ambient'|'after-chat'} trigger
 * @param {() => number} rand 注入随机源，便于单测
 */
export function shouldWriteNow({ now = Date.now(), lastWriteAt = 0, todayCount = 0 } = {}, trigger = 'ambient', rand = Math.random) {
  if (todayCount >= DIARY_PARAMS.MAX_PER_DAY) return { go: false, reason: 'daily-cap' }
  const min = trigger === 'after-chat' ? DIARY_PARAMS.MIN_GAP_AFTER_CHAT_MS : DIARY_PARAMS.MIN_GAP_MS
  if (now - (Number(lastWriteAt) || 0) < min) return { go: false, reason: 'too-soon' }
  if (trigger === 'after-chat' && rand() >= DIARY_PARAMS.AFTER_CHAT_CHANCE) return { go: false, reason: 'dice' }
  return { go: true }
}

/**
 * 今晚是否允许浮现**存在主义的自我疑问**（深夜 + 5% 概率 + 每周上限 1 次）。
 * 2026-10-17：原为旧人设的「缓存残片」，随《world.execute(me);》设定一并移除；
 * 护栏机制（极低频）保留，内容换成新人设的核心命题。
 * @param {{now:number, weekCount:number}} s weekCount 由 main 侧持久化计数提供
 */
export function shouldOfferCache({ now = Date.now(), weekCount = 0 } = {}, rand = Math.random) {
  if (!isNightHour(new Date(now).getHours())) return false
  if (weekCount >= DIARY_PARAMS.CACHE_WEEK_CAP) return false
  return rand() < DIARY_PARAMS.CACHE_CHANCE
}
