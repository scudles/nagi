// D2: 同一用户轮的模型意图建议。只处理输出开头的有界标签；状态由每次 runTurn 持有。
import { EMOTIONS } from '../../shared/protocol.js'
import { intentDirective, isIntentKind, resolveIntent, INTENT } from './intent.js'

const PREFIX = /^(\s*)\[([a-z_-]{1,20})\|([a-z_-]{1,20})\]/i
const PARTIAL = /^\s*\[[a-z_-]{0,20}(?:\|[a-z_-]{0,20})?$/i

/** 单个 runTurn 的临时邮箱。迟到步骤、旧 epoch 和关单后的建议一律拒绝。 */
export function createTurnHintSlot({ turnId, epoch }) {
  let step = 0
  let pending = null
  let closed = false
  return {
    beginStep() { if (closed) return null; pending = null; return ++step },
    offer({ turnId: offeredTurn, epoch: offeredEpoch, step: offeredStep, hint }) {
      if (closed || offeredTurn !== turnId || offeredEpoch !== epoch || offeredStep !== step || !isIntentKind(hint?.kind)) return false
      pending = { kind: hint.kind }
      return true
    },
    consume() { const value = pending; pending = null; return closed ? null : value },
    close() { closed = true; pending = null }
  }
}

/** 把 [emotion|intent] 还原成既有 [emotion] 流，建议只交本次调用的编排闭包。 */
export async function* stripIntentHintEvents(events, onHint) {
  let pending = ''
  let resolved = false
  for await (const event of events) {
    if (event?.type !== 'delta' || resolved) {
      if (!resolved && pending) {
        yield { type: 'delta', text: pending }
        pending = ''
        resolved = true
      }
      yield event
      continue
    }
    pending += String(event.text || '')
    const match = pending.match(PREFIX)
    if (match && EMOTIONS.includes(match[2].toLowerCase())) {
      const kind = match[3].toLowerCase()
      if (isIntentKind(kind)) onHint?.({ kind })
      yield { ...event, text: match[1] + '[' + match[2].toLowerCase() + ']' + pending.slice(match[0].length) }
      pending = ''
      resolved = true
    } else if (pending.length > 64 || !PARTIAL.test(pending)) {
      yield { ...event, text: pending }
      pending = ''
      resolved = true
    }
  }
  if (pending) yield { type: 'delta', text: pending }
}

/** 只识别明确的功能冲突；不对生成文本做人格台词模板分类。 */
export function candidateFitsIntent(text, kind) {
  const body = String(text || '').trim()
  if (!body) return false
  const questions = (body.match(/[？?]/g) || []).length
  const unsolicitedAdvice = /(?:你应该|你必须|你需要|建议你|首先|第一步)/.test(body)
  if (kind === INTENT.LISTEN || kind === INTENT.BOUNDARY) return !unsolicitedAdvice && questions <= 1
  if (kind === INTENT.CLARIFY) return questions === 1 && !unsolicitedAdvice
  if (kind === INTENT.BRIEF_ACK) return body.length <= 90 && questions <= 1
  if (kind === INTENT.SOLVE || kind === INTENT.REMINISCE) return !/^(?:嗯|好|好的|知道了|明白了)[。！!\s]*$/.test(body)
  return true
}

/** 复用 loop 的现有 guard 重写预算；hint 只从本轮当前模型调用消费一次。 */
export function createModelHintGuard({ userText, crisis, hasGroundedMemory, initialIntent, personaGuard, consumeHint, onAccepted }) {
  let locked = null
  return {
    maxRetries: 1,
    review(text) {
      const hint = consumeHint?.() || null
      const decided = locked || resolveIntent({ userText, crisis, hasGroundedMemory, modelHint: hint })
      const persona = personaGuard?.review(text) || { ok: true }
      if (!persona.ok) {
        locked = decided
        return persona
      }
      if (decided.kind !== initialIntent.kind && !candidateFitsIntent(text, decided.kind)) {
        locked = decided
        return { ok: false, ruleId: 'intent_mismatch' }
      }
      onAccepted?.(decided)
      return { ok: true }
    },
    retryInstruction(ruleId) {
      const persona = ruleId === 'intent_mismatch' ? '' : (personaGuard?.retryInstruction(ruleId) || '')
      const intent = locked || initialIntent
      return `${persona}\n【本轮表达意图复核】${intentDirective(intent.kind)}仅重写本轮最终正文，不复述候选，不再调用工具。`
    }
  }
}
