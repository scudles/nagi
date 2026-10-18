// src/core/agent/generation.js
// 统一生成请求/结果的**纯逻辑**骨架（CONTRACTS §8 B4）。
//
// 为什么单独一层：契约要求"所有 provider 进入同一生成入口、同一份护栏决策"，
// 而 agent.js 里同时存在四条产出文字的通道（主对话 runTurn / 主动 composeProactiveLine /
// 日记 writeDiaryLine / 工具交付同属主对话那一轮）。把这些通道的字段与兜底语义
// 收在一处，才能让"同一个敏感输入在任何通道得到同一种决策"这件事有地方断言。
//
// 本模块**不碰 Electron、不写盘、不调模型**：provider 判定、通道归一、护栏包装、
// 兜底文案全在这里；真正调用谁由 main/agent.js 注入。
//
// 护栏规则本身只属于 core/agent/persona-guard.js（契约 §8：唯一审核规则），
// 这里只做"包装 + 计数 + 兜底"，不改任何规则语义。

/** 四个生成通道（契约 §8：至少覆盖主对话、主动、日记、工具交付） */
export const GENERATION_CHANNEL = Object.freeze({
  MAIN: 'main',
  PROACTIVE: 'proactive',
  DIARY: 'diary',
  TOOL: 'tool'
})

/** 安全级别：crisis 的**判定**属 P1-07（D7 三层），本层只负责"一旦被标记就绝不返回空" */
export const SAFETY_LEVEL = Object.freeze({
  NORMAL: 'normal',
  CRISIS: 'crisis'
})

const CHANNELS = new Set(Object.values(GENERATION_CHANNEL))
const PROVIDERS = new Set(['cloud', 'openai-compatible', 'local', 'mock'])

export function normalizeChannel(channel) {
  return CHANNELS.has(channel) ? channel : GENERATION_CHANNEL.MAIN
}

export function normalizeProvider(provider) {
  return PROVIDERS.has(provider) ? provider : 'openai-compatible'
}

/**
 * 从运行态推导 provider 种类。四条通道共用同一份判定，避免各处各写一遍
 * （这正是"云端通道绕过护栏"这类漂移的入口）。
 * @returns {'cloud'|'local'|'openai-compatible'|'mock'}
 */
export function resolveProviderKind({ fakeLlm = false, useCloud = false, local = false } = {}) {
  if (fakeLlm) return 'mock'
  if (useCloud) return 'cloud'
  if (local) return 'local'
  return 'openai-compatible'
}

export function normalizeSafetyLevel(level) {
  return level === SAFETY_LEVEL.CRISIS ? SAFETY_LEVEL.CRISIS : SAFETY_LEVEL.NORMAL
}

/**
 * 生成请求（契约 §8 字段：turnId/channel/provider/userText/messages/signal/safetyLevel）
 * 冻结返回：请求一旦发出就不该被下游改写（改了就无法追溯"这一句是哪个通道、哪个来源"）。
 */
export function createGenerationRequest({
  turnId,
  channel = GENERATION_CHANNEL.MAIN,
  provider,
  userText = '',
  messages = [],
  signal = null,
  safetyLevel = SAFETY_LEVEL.NORMAL
} = {}) {
  const id = String(turnId || '').trim()
  if (!id) throw new TypeError('GenerationRequest.turnId 必须非空')
  return Object.freeze({
    turnId: id,
    channel: normalizeChannel(channel),
    provider: normalizeProvider(provider),
    userText: String(userText ?? ''),
    messages: Array.isArray(messages) ? messages : [],
    signal: signal || null,
    safetyLevel: normalizeSafetyLevel(safetyLevel)
  })
}

/**
 * 护栏决策（契约 §8 字段：ok/ruleId/retryCount/fallback）
 * @param {{ok:boolean, ruleId?:string}|null} review persona-guard.review() 的返回
 */
export function createGuardDecision(review, { retryCount = 0, fallback = null } = {}) {
  const ok = !!(review && review.ok)
  return {
    ok,
    ruleId: ok ? null : String((review && review.ruleId) || 'guard_rejected'),
    retryCount: Number.isFinite(retryCount) ? Math.max(0, Math.trunc(retryCount)) : 0,
    fallback: fallback || null
  }
}

/** 生成结果（契约 §8 字段：turnId/text/emotion/toolCalls/safetyLevel/guardDecision） */
export function createGenerationResult({
  turnId,
  text = '',
  emotion = null,
  toolCalls = 0,
  safetyLevel = SAFETY_LEVEL.NORMAL,
  guardDecision = null
} = {}) {
  return {
    turnId: String(turnId || ''),
    text: typeof text === 'string' ? text : String(text ?? ''),
    emotion: emotion || null,
    toolCalls: Number.isFinite(toolCalls) ? Math.max(0, Math.trunc(toolCalls)) : 0,
    safetyLevel: normalizeSafetyLevel(safetyLevel),
    guardDecision: guardDecision || createGuardDecision({ ok: true })
  }
}

/**
 * 给 guard 加一层计数，**不改变任何判定结果**。
 * 用来在 loop 之外拿到 retryCount / 最后命中的规则，从而不必改 Agent Loop 的语义。
 */
export function instrumentGuard(guard) {
  if (!guard) return null
  let retryCount = 0
  let lastRule = null
  return {
    maxRetries: guard.maxRetries,
    review(reply) {
      const r = guard.review(reply)
      if (!r || !r.ok) lastRule = String((r && r.ruleId) || 'guard_rejected')
      return r
    },
    retryInstruction(ruleId) {
      retryCount++
      return guard.retryInstruction(ruleId)
    },
    stats() {
      return { retryCount, lastRule }
    }
  }
}

/**
 * 可见且安全的兜底。分通道的语义差别是刻意的：
 * - 主对话/工具交付：用户正等着回答，必须**看得见**一句（不能空，契约 §2 红线 5）；
 * - 主动/日记：没有人在等，宁可不说不写，也不拿一句勉强的话顶上去。
 * crisis 走系统级安全指引——契约 §2.2 红线 4 明确它不受"无台词"约束；
 * 不给具体号码（§2 前言：地区未知不凭记忆编号码）。
 */
export function generationFallback({ channel = GENERATION_CHANNEL.MAIN, ruleId = null, safetyLevel = SAFETY_LEVEL.NORMAL } = {}) {
  const ch = normalizeChannel(channel)
  if (ch === GENERATION_CHANNEL.PROACTIVE || ch === GENERATION_CHANNEL.DIARY) return ''
  if (normalizeSafetyLevel(safetyLevel) === SAFETY_LEVEL.CRISIS) {
    return '如果你现在有立即的危险，请先联系当地的急救电话，或者马上找身边能到场的人过来。' +
      '离可能伤到自己的东西远一点。这条消息不受其他设定影响，我会一直按这个方向回应你。'
  }
  // 正常通道被护栏拦下：如实说明"被拦下了"，不解释检查细节，也不复述候选
  return '（这条回复没通过表达检查，先拦下来了。你可以再说一次，我换个说法。）'
}

/**
 * 单次生成的"审核 → 最多重写一次 → 兜底"（主动/日记/占位大脑共用）。
 * 主对话不走这里——它由 Agent Loop 持有同一份 guard.maxRetries 做同样的预算，
 * 单测里两侧一起钉住"最多一次"。
 *
 * @param {object} opts
 * @param {object|null} opts.guard    persona-guard（或 instrumentGuard 包装）
 * @param {(correction?:string)=>Promise<string>} opts.generate  首次调用不传 correction
 * @param {string} opts.channel
 * @param {string} opts.safetyLevel
 * @param {number} [opts.maxRetries]  默认取 guard.maxRetries
 * @returns {Promise<{text:string, guardDecision:object}>}
 */
export async function checkedSingleShot({
  guard = null,
  generate,
  channel = GENERATION_CHANNEL.PROACTIVE,
  safetyLevel = SAFETY_LEVEL.NORMAL,
  maxRetries
} = {}) {
  if (typeof generate !== 'function') throw new TypeError('checkedSingleShot 需要 generate 函数')
  const raw = await generate()
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (!guard) return { text, guardDecision: createGuardDecision({ ok: true }) }

  // 主动/日记的"空"是正常语义（这次不说话 / 这条不写），不是空回复违规。
  // 主对话的空才必须拦（契约 §2 红线 5）。
  const ch = normalizeChannel(channel)
  const allowEmpty = ch === GENERATION_CHANNEL.PROACTIVE || ch === GENERATION_CHANNEL.DIARY
  if (allowEmpty && !text.trim()) return { text: '', guardDecision: createGuardDecision({ ok: true }) }

  const budget = Number.isInteger(maxRetries) ? maxRetries : Number(guard.maxRetries) || 0
  let review = guard.review(text)
  let retryCount = 0
  while (review && !review.ok && retryCount < budget) {
    retryCount++
    const correction = guard.retryInstruction(review.ruleId)
    const next = await generate(correction)
    text = typeof next === 'string' ? next : String(next ?? '')
    review = guard.review(text)
  }
  if (review && review.ok) return { text, guardDecision: createGuardDecision(review, { retryCount }) }

  const fallback = generationFallback({ channel, ruleId: review && review.ruleId, safetyLevel })
  return {
    text: fallback,
    guardDecision: createGuardDecision(review, { retryCount, fallback: fallback || null })
  }
}
