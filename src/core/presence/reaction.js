// src/core/presence/reaction.js
// 「她想一下，然后决定怎么表现」——待机反应的决策层。
//
// 为什么要有这一层：在这之前，"你看到她在做什么"和"她表现出什么"之间是 6~8 条
// **硬编码规则**（坐太久→担心、熬夜→担心…），每条只会吐一个固定情绪 + 一句预写的话。
// 这一层把"决策"换成一次**常识推理**：让她先说清"我注意到什么、为什么想这样表现"，
// 再决定是持续一阵（走情绪）还是只闪一下（走微表情）。
//
// 三条硬约束（都是为了不让它变成"过度解读机器"）：
//   ① **允许什么都不做**：strength 低于阈值就是"不做"，这是最常用的结果；
//   ② **只能提议、不能强设**：持续表情走 mood.propose（自带"候选强度够才接管"的粘性），
//      所以 LLM 说不清的时候，情绪状态机原来的脸不会被莫名其妙顶掉；
//   ③ **按频率花钱**：只在场景切换 / 同场景持续较久 / 长空闲三种时机才想一次，
//      还有小时与每日上限（云端调用是要花钱的）。
//
// 本文件是纯逻辑：不读时钟、不调网络、不写文件（便于单测，见 test/reaction.test.js）。
import { TONE } from '../ambient.js'

/** 可选的情绪（与 core/emotion/mood.js 的 6 种一致） */
export const FEELS = ['calm', 'smile', 'joy', 'puzzled', 'worry', 'pout']
/** 表现形式的两种：持续一阵 / 只闪一下 */
export const MODES = ['sustain', 'flash']

/** 默认节流参数（保守；比"问一次多少钱"更重要的是"别问太多次"） */
export const DEFAULT_THINK = {
  minGapMs: 8 * 60 * 1000, // 两次思考最小间隔
  hourMax: 4, // 每小时最多想几次
  dayMax: 20, // 每天最多想几次
  sceneHoldMs: 20 * 60 * 1000, // 同一个场景待多久之后值得再想一次
  idleThinkMs: 10 * 60 * 1000, // 空闲多久之后值得想一次（他是不是走了）
  quietFactor: 1.8, // "安静陪着"时把最小间隔放宽（你在专注做事，别多想）
  minStrength: 0.15, // 强度低于此值 = 不做（最重要的一条）
  maxSustainStrength: 0.6 // 持续表情的强度上限（别动不动就满格）
}

/**
 * 思考闸门：什么时候值得问一次模型。
 * @param {object} config 见 DEFAULT_THINK
 * @param {{now?:()=>number}} [deps]
 */
export function createThinkGate(config = DEFAULT_THINK, deps = {}) {
  const cfg = { ...DEFAULT_THINK, ...config }
  const now = deps.now ?? (() => Date.now())

  let lastAt = -Infinity
  let lastCategory = null
  // 本场景已经因为"待久了"想过几次：用 sinceMs 的整除商来判，
  // 比记时间戳稳（记时间戳会被"刚换场景"和"刚想过"两件事互相干扰）
  let dwellCount = 0
  let hourKey = ''
  let hourCount = 0
  let dayKeyStr = ''
  let dayCount = 0
  let lastReason = null

  const hourOf = (t) => new Date(t).toISOString().slice(0, 13)
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10)

  function roll(t) {
    const h = hourOf(t)
    if (h !== hourKey) {
      hourKey = h
      hourCount = 0
    }
    const d = dayOf(t)
    if (d !== dayKeyStr) {
      dayKeyStr = d
      dayCount = 0
    }
  }

  /**
   * 现在值不值得想一次。
   * @param {object} ctx
   * @param {string} [ctx.category] 活动分类（work/video/gaming/social/browser/other）
   * @param {number} [ctx.sinceMs] 当前场景已经持续多久
   * @param {number} [ctx.idleMs] 用户多久没动了
   * @param {boolean} [ctx.silent] 勿扰/夜间静默
   * @param {boolean} [ctx.busy] 她正在说话/生成回复
   * @param {string} [ctx.tone] 待机基调
   * @returns {{reason:'switch'|'dwell'|'idle'}|null}
   */
  function shouldThink(ctx = {}) {
    const t = now()
    if (ctx.silent || ctx.busy) return null
    roll(t)
    if (hourCount >= cfg.hourMax) return null
    if (dayCount >= cfg.dayMax) return null

    const gap = cfg.minGapMs * (ctx.tone === TONE.QUIET ? cfg.quietFactor : 1)
    if (t - lastAt < gap) return null

    const category = String(ctx.category || 'other')
    // ① 换了场景：最自然的一次"她注意到了"
    if (category !== lastCategory) return { reason: 'switch', category }
    // ② 同一个场景待了很久（每 sceneHoldMs 至多想一次，不是每个 tick 都想）
    const sinceMs = Number(ctx.sinceMs) || 0
    if (cfg.sceneHoldMs > 0 && Math.floor(sinceMs / cfg.sceneHoldMs) > dwellCount) {
      return { reason: 'dwell', category }
    }
    // ③ 很久没动静（他可能走开了，也可能在发呆）
    if ((Number(ctx.idleMs) || 0) >= cfg.idleThinkMs) return { reason: 'idle', category }
    return null
  }

  /** 记一次"想过了"（失败也要记，否则会连着重试打满配额） */
  function noteThought(reason = null, category = null) {
    const t = now()
    roll(t)
    lastAt = t
    hourCount++
    dayCount++
    if (category) lastCategory = category
    if (reason === 'dwell') dwellCount++
    if (reason === 'switch') dwellCount = 0 // 新场景重新计"待久了"
    lastReason = reason
  }

  /** 场景变化时同步"当前分类"，避免没想也把 switch 一直挂着 */
  function noteCategory(category) {
    const c = String(category || 'other')
    if (c !== lastCategory) {
      lastCategory = c
      dwellCount = 0
    }
  }

  return {
    shouldThink,
    noteThought,
    noteCategory,
    stats: () => ({ lastAt, lastCategory, dwellCount, hourCount, dayCount, lastReason, config: cfg })
  }
}

/**
 * 从模型输出里取出反应对象（容忍 ```json 包裹、前后多余的话）。
 * @returns {{ok:boolean, raw:object|null, error?:string}}
 */
export function extractReaction(text) {
  const s = String(text || '').trim()
  if (!s) return { ok: false, raw: null, error: '空响应' }
  const cleaned = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const tryParse = (str) => {
    try {
      const v = JSON.parse(str)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  let obj = tryParse(cleaned)
  if (!obj) {
    // 从"好的，我的判断是 {...}"这种回答里捞出第一个完整对象
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) obj = tryParse(cleaned.slice(start, end + 1))
  }
  if (!obj) return { ok: false, raw: null, error: '不是合法 JSON' }
  return { ok: true, raw: obj }
}

/**
 * 校验并归一化模型的判断。**这里是防守最重的一环**：
 * 模型会幻想出不存在的情绪、给出 1.0 的强度、写一大段话。
 * @param {object} raw extractReaction 出来的对象
 * @param {{availableFlash?:string[]}} [opts] 模型真实拥有的微表情 id（用来过滤）
 * @returns {{act:'none'|'sustain'|'flash', feel:string|null, strength:number, flash:string|null, why:string, say:string|null, dropped:string[]}}
 */
export function parseReaction(raw, opts = {}) {
  const dropped = []
  const r = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_THINK, ...(opts.config || {}) }
  const availableFlash = new Set(opts.availableFlash || [])
  const notes = []

  const feel = typeof r.feel === 'string' ? r.feel.trim().toLowerCase() : ''
  if (feel && !FEELS.includes(feel)) {
    dropped.push(`feel:${feel}`)
    notes.push('情绪不在白名单')
  }
  const mode = typeof r.mode === 'string' ? r.mode.trim().toLowerCase() : ''
  if (mode && !MODES.includes(mode)) dropped.push(`mode:${mode}`)

  let strength = Number(r.strength)
  if (!Number.isFinite(strength)) strength = 0
  strength = Math.max(0, Math.min(1, strength))

  let flash = typeof r.flash === 'string' ? r.flash.trim() : ''
  if (flash && availableFlash.size && !availableFlash.has(flash)) {
    dropped.push(`flash:${flash}`)
    flash = ''
  } else if (flash && !availableFlash.size) {
    flash = '' // 不知道池子里有什么就别乱闪
  }

  const sayRaw = typeof r.say === 'string' ? r.say.trim() : ''
  // 话太长就丢：她主动开口应该是短句，不是小作文
  // null 表示"不说话"（不是空字符串——空串会让下游误以为"有一句空话要说"）
  const say = sayRaw && sayRaw.length <= 60 ? sayRaw : null
  if (sayRaw && !say) dropped.push('say:过长')

  const why = typeof r.why === 'string' ? r.why.trim().slice(0, 80) : ''
  const read = typeof r.read === 'string' ? r.read.trim().slice(0, 80) : ''

  const validFeel = FEELS.includes(feel) ? feel : null

  // ① 最常用的结果：不做。模型自己也可能给 null / 低强度
  if (!validFeel && !flash) {
    return { act: 'none', feel: validFeel, strength: 0, flash: null, why, read, say: null, dropped, notes }
  }
  if (strength < config.minStrength && mode !== 'flash') {
    return { act: 'none', feel: validFeel, strength: 0, flash: null, why, read, say: null, dropped, notes }
  }

  // ② 闪回：有 flash 且（模型说 flash，或强度很低不值得持续）
  if (flash && (mode === 'flash' || strength < config.minStrength)) {
    return { act: 'flash', feel: validFeel, strength, flash, why, read, say, dropped, notes }
  }

  // ③ 持续：强度够，走情绪（会自然衰减）
  if (validFeel) {
    const capped = Math.min(strength, config.maxSustainStrength)
    return { act: 'sustain', feel: validFeel, strength: capped, flash: null, why, read, say, dropped, notes }
  }

  return { act: 'none', feel: null, strength: 0, flash: null, why, read, say: null, dropped, notes }
}

/**
 * 拼给她看的提示词。
 *
 * 只放**活动分类**，不放窗口标题、不放文件名（用户明确选的边界）。
 * 明确允许"什么都不做"——这条比什么都重要，否则她会把"你在写代码"读成"你很焦虑"。
 */
export function buildReactionMessages(ctx = {}) {
  const {
    category = 'other',
    sinceMin = 0,
    idleMin = 0,
    hour = 12,
    weekday = '',
    moodLabel = '平静',
    talkedToday = 0,
    flashOptions = []
  } = ctx
  const partOfDay =
    hour < 6 ? '凌晨' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜'
  const doing =
    {
      work: '在工作或写东西',
      browser: '在浏览器上翻东西',
      video: '在看视频',
      gaming: '在打游戏',
      social: '在聊天或刷社交',
      other: '在做别的事'
    }[category] || '在做别的事'

  const system = [
    '你在扮演「凪」，一个陪在用户电脑旁的猫娘。现在不是你说话的时候，你只是在观察。',
    '你的任务是：根据你注意到的情况，决定**要不要有一点表情反应**，以及**为什么**。',
    '',
    '输出要求：只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。字段：',
    '{',
    '  "read": "用一句话说清你注意到了什么（不超过 30 字）",',
    '  "feel": "calm|smile|joy|puzzled|worry|pout 之一，或者 null",',
    '  "strength": "0 到 1 之间的小数，表示这个情绪有多强（0.15 以下等于不表现）",',
    '  "mode": "sustain（持续一阵，会慢慢淡下去）或 flash（只闪一下）",',
    `  "flash": "想闪的时候从这些里选一个：${flashOptions.join(' / ') || '（没有可选项，填 null）'}；否则 null",`,
    '  "why": "为什么这样表现，一句话",',
    '  "say": "想对他说的一句话；大多数时候应该是 null"',
    '}',
    '',
    '重要规则：',
    '1. 大多数时候正确答案是「不做」——feel 给 null、strength 给 0。不要为了有反应而硬编一个情绪。',
    '2. 只根据你确实观察到的事实，**不要脑补他的心情**。他在写代码不等于他很焦虑。',
    '3. 只有你确定"这个反应说得通"时才给 strength ≥ 0.3；拿不准就给 flash 闪一下。',
    '4. say 只有在真的有必要时才给（比如他连续坐了很久），通常给 null；一句话，不超过 30 字。',
    '5. 不要说教、不要夸张、不要用感叹号堆情绪。'
  ].join('\n')

  const user = [
    `现在是${partOfDay}（${hour} 点${weekday ? '，' + weekday : ''}）。`,
    `你注意到：他这会儿${doing}，已经持续了约 ${Math.round(sinceMin)} 分钟。`,
    idleMin >= 1 ? `他有 ${Math.round(idleMin)} 分钟没怎么动了。` : '他刚刚还在动鼠标。',
    `你今天已经和他聊过 ${talkedToday} 轮。`,
    `你此刻的底色是「${moodLabel}」。`,
    '现在决定：你要不要有一点反应？'
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}
