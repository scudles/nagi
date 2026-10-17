// src/main/reaction.js
// 「她想一下」的引擎：攒上下文 → 问一次模型 → 校验 → 把结果交给表现层。
//
// 位置：插在"你看到她在做什么"和"她表现出什么"之间。原本这段是 6~8 条硬编码规则，
// 现在换成一次常识推理；规则层保留不动（没配模型时自动退回规则，行为不变）。
//
// 隐私（用户 2026-10-17 明确选的边界）：
//   · **只把活动分类**（工作/浏览器/视频/游戏/社交/其他）交给模型，
//     **不传窗口标题、不传应用名、不传文件名**；
//   · 分类来自 core/monitor/tracker.js 的 classify，本身只是枚举值；
//   · 沿用 privacy.monitorEnabled / doNotDisturb 的既有边界：关了监测就不想。
//
// 依赖注入（不直接 import electron / agent），所以这个文件可以在单测里用假模型跑。
import {
  buildReactionMessages,
  createThinkGate,
  extractReaction,
  parseReaction
} from '../core/presence/reaction.js'

const TIMEOUT_MS = 15000

/**
 * 建一个反应引擎。
 * @param {object} opts
 * @param {() => object} opts.getContext 取当前情境（分类/时长/时段/底色/微表情池）
 * @param {(messages:Array) => Promise<string|null>} opts.callModel 调模型，返回纯文本；不可用返回 null
 * @param {(r:object) => void} [opts.onSustain] 持续表现（走情绪）
 * @param {(r:object) => void} [opts.onFlash] 闪回（走微表情）
 * @param {(r:object) => void} [opts.onSay] 想说的话
 * @param {(msg:string) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createReactionEngine(opts = {}) {
  const {
    getContext = () => ({}),
    callModel = async () => null,
    onSustain = () => {},
    onFlash = () => {},
    onSay = () => {},
    log = () => {},
    now = () => Date.now(),
    timeoutMs = TIMEOUT_MS,
    gate = createThinkGate(undefined, { now })
  } = opts

  let busy = false
  let curCategory = null
  let curCategoryAt = 0 // 当前场景是什么时候开始的（算"持续了多久"）
  let lastThought = null // 最近一次"她刚才在想什么"（工作台/日志用）
  let skippedNoModel = 0 // 没配模型时静默跳过，只记一次日志

  /**
   * 喂一次观测。**不阻塞调用方**（内部自己跑异步）。
   * @param {{category?:string, idleMs?:number, sinceMs?:number, silent?:boolean, busy?:boolean, tone?:string}|null} obs
   * @returns {Promise<{ran:boolean, reason?:string, act?:string}>}
   */
  async function observe(obs) {
    if (!obs) return { ran: false, reason: 'no-obs' }
    const ctx0 = getContext() || {}
    const ctx = { ...ctx0, ...obs }
    const t = now()
    const cat = String(ctx.category || 'other')
    if (cat !== curCategory) {
      curCategory = cat
      curCategoryAt = t
    }
    // 调用方没给 sinceMs 就自己算（监测采样只带分类与空闲秒数）
    if (ctx.sinceMs == null) ctx.sinceMs = t - curCategoryAt
    // 注意：**不要**在这里 noteCategory —— 提前记录会把本次的 switch 契机吃掉
    // （记完 lastCategory 就等于当前分类了，shouldThink 就永远看不到"换了场景"）。
    // 分类由 noteThought 在真正想过之后更新；因为节流没想成的切换，下次仍然算"切换"。
    if (busy) return { ran: false, reason: 'busy' }

    const hit = gate.shouldThink(ctx)
    if (!hit) return { ran: false, reason: 'not-time' }

    busy = true
    let text = null
    try {
      const messages = buildReactionMessages({
        category: ctx.category,
        sinceMin: (Number(ctx.sinceMs) || 0) / 60000,
        idleMin: (Number(ctx.idleMs) || 0) / 60000,
        hour: ctx.hour ?? new Date(now()).getHours(),
        weekday: ctx.weekday || '',
        moodLabel: ctx.moodLabel || '平静',
        talkedToday: ctx.talkedToday ?? 0,
        flashOptions: ctx.flashOptions || []
      })
      text = await withTimeout(callModel(messages), timeoutMs)
      if (text === null) {
        // 没配模型/不可用：这一次不算"想过"，归还额度，下次还能试
        busy = false
        if (skippedNoModel++ === 0) log('[reaction] 没有可用模型，先不启用这层（规则层照旧工作）')
        return { ran: false, reason: 'no-model' }
      }
      gate.noteThought(hit.reason, ctx.category)
    } catch (err) {
      gate.noteThought(hit.reason, ctx.category) // 失败也记账，避免连着重试
      log(`[reaction] 思考失败：${err?.message || err}`)
      busy = false
      return { ran: false, reason: 'error' }
    }

    let parsed
    try {
      const ex = extractReaction(text)
      if (!ex.ok) {
        log(`[reaction] 输出不是 JSON，丢弃：${String(text).slice(0, 60)}`)
        busy = false
        return { ran: false, reason: 'bad-json' }
      }
      parsed = parseReaction(ex.raw, { availableFlash: ctx.flashOptions || [] })
    } catch (err) {
      busy = false
      return { ran: false, reason: 'parse-error' }
    }

    lastThought = {
      at: now(),
      reason: hit.reason,
      read: parsed.read,
      why: parsed.why,
      act: parsed.act,
      feel: parsed.feel,
      strength: parsed.strength,
      flash: parsed.flash,
      said: parsed.say,
      dropped: parsed.dropped
    }

    try {
      if (parsed.act === 'sustain') {
        onSustain({ feel: parsed.feel, strength: parsed.strength, why: parsed.why, read: parsed.read })
      } else if (parsed.act === 'flash') {
        onFlash({ flash: parsed.flash, feel: parsed.feel, why: parsed.why, read: parsed.read })
      }
      // 说话是"以表情为主"的例外：只有模型明确给了短句、且当次有实际表现时才说
      if (parsed.say && parsed.act !== 'none') {
        onSay({ text: parsed.say, feel: parsed.feel || 'calm' })
      }
      log(
        `[reaction] ${hit.reason} → ${parsed.act}` +
          (parsed.act === 'sustain' ? ` ${parsed.feel}@${parsed.strength.toFixed(2)}` : '') +
          (parsed.act === 'flash' ? ` ${parsed.flash}` : '') +
          (parsed.say ? ` 说：${parsed.say}` : '') +
          (parsed.why ? `（因为：${parsed.why}）` : '')
      )
    } catch (err) {
      log(`[reaction] 执行表现失败：${err?.message || err}`)
    } finally {
      busy = false
    }
    return { ran: true, reason: hit.reason, act: parsed.act }
  }

  return {
    observe,
    lastThought: () => lastThought,
    state: () => ({ busy, skippedNoModel, gate: gate.stats?.() || null, lastThought }),
    /** 供"她刚才在想什么"面板/日志用 */
    gate
  }
}

function withTimeout(promise, ms) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise ?? null)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), ms)
    timer.unref?.()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
