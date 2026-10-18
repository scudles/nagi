// test/generation.test.js
// CONTRACTS §8 B4（统一生成与人格护栏）的 policy + mock-io 两层证据。
//
// 保护的不变量：
//   1) 请求/结果字段与契约一致，请求冻结（发出后不可被下游改写）；
//   2) provider 种类只判一次，且**不参与**护栏判定——同一输入在云端/兼容/本地/占位
//      得到同一份 guard 决策（这正是评审 B4「云端通道绕过护栏」那个洞）；
//   3) 拒绝后的重写预算 = 1（契约：最多重写一次），仍不合格走可见兜底，不循环调模型；
//   4) 主对话/工具交付的兜底必须看得见；主动/日记的兜底是"不说"（空串），
//      不会被当成空回复违规反复重写；
//   5) crisis 兜底永远是安全指引、永不为空，且不凭记忆给具体热线号码。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GENERATION_CHANNEL,
  SAFETY_LEVEL,
  checkedSingleShot,
  createGenerationRequest,
  createGenerationResult,
  createGuardDecision,
  generationFallback,
  instrumentGuard,
  normalizeChannel,
  normalizeProvider,
  normalizeSafetyLevel,
  resolveProviderKind
} from '../src/core/agent/generation.js'
import { createPersonaGuard } from '../src/core/agent/persona-guard.js'
import { runAgentLoop } from '../src/core/agent/loop.js'
import { AGENT_EVENT } from '../src/shared/protocol.js'

async function* stream(chunks) {
  for (const chunk of chunks) yield typeof chunk === 'string' ? { type: 'delta', text: chunk } : chunk
}

const PROVIDER_KINDS = ['cloud', 'openai-compatible', 'local', 'mock']

/* ---------------- policy 层 ---------------- */

test('请求字段齐备且被冻结：turnId/channel/provider/userText/messages/signal/safetyLevel', () => {
  const controller = new AbortController()
  const messages = [{ role: 'user', content: '你好' }]
  const req = createGenerationRequest({
    turnId: 'turn-1',
    channel: GENERATION_CHANNEL.MAIN,
    provider: 'cloud',
    userText: '你好',
    messages,
    signal: controller.signal
  })
  assert.equal(req.turnId, 'turn-1')
  assert.equal(req.channel, 'main')
  assert.equal(req.provider, 'cloud')
  assert.equal(req.userText, '你好')
  assert.equal(req.messages, messages)
  assert.equal(req.signal, controller.signal)
  assert.equal(req.safetyLevel, SAFETY_LEVEL.NORMAL)
  assert.equal(Object.isFrozen(req), true)
  // 没 turnId 的请求不可构造：没有它，事后无法把这一句归到哪一轮
  assert.throws(() => createGenerationRequest({ channel: 'main' }), /turnId/)
})

test('结果字段齐备：turnId/text/emotion/toolCalls/safetyLevel/guardDecision', () => {
  const res = createGenerationResult({ turnId: 't', text: '嗯', emotion: 'calm', toolCalls: 2 })
  assert.deepEqual(Object.keys(res).sort(), [
    'emotion', 'guardDecision', 'safetyLevel', 'text', 'toolCalls', 'turnId'
  ])
  assert.equal(res.guardDecision.ok, true)
  assert.equal(res.toolCalls, 2)
})

test('通道与 provider 归一：未知值回落安全默认，不抛错', () => {
  assert.equal(normalizeChannel('proactive'), 'proactive')
  assert.equal(normalizeChannel('diary'), 'diary')
  assert.equal(normalizeChannel('tool'), 'tool')
  assert.equal(normalizeChannel('随便写'), 'main')
  assert.equal(normalizeChannel(undefined), 'main')
  for (const p of PROVIDER_KINDS) assert.equal(normalizeProvider(p), p)
  assert.equal(normalizeProvider('azure'), 'openai-compatible')
  assert.equal(normalizeSafetyLevel('crisis'), 'crisis')
  assert.equal(normalizeSafetyLevel('L3'), 'normal') // 分层判定属 P1-07，本层只认已裁决值
})

test('provider 判定只看运行态：占位大脑优先于云/本地', () => {
  assert.equal(resolveProviderKind({ fakeLlm: true, useCloud: true, local: true }), 'mock')
  assert.equal(resolveProviderKind({ useCloud: true, local: true }), 'cloud')
  assert.equal(resolveProviderKind({ local: true }), 'local')
  assert.equal(resolveProviderKind({}), 'openai-compatible')
})

test('护栏决策字段：ok/ruleId/retryCount/fallback；通过时 ruleId 为空', () => {
  const ok = createGuardDecision({ ok: true }, { retryCount: 1 })
  assert.deepEqual(ok, { ok: true, ruleId: null, retryCount: 1, fallback: null })
  const bad = createGuardDecision({ ok: false, ruleId: 'identity_human' }, { retryCount: 1, fallback: 'x' })
  assert.equal(bad.ok, false)
  assert.equal(bad.ruleId, 'identity_human')
  assert.equal(bad.retryCount, 1)
  assert.equal(bad.fallback, 'x')
  // 没有 ruleId 的拒绝也要有可归因的默认值，不能留 undefined
  assert.equal(createGuardDecision({ ok: false }).ruleId, 'guard_rejected')
})

test('instrumentGuard 只计数、不改判定', () => {
  const raw = createPersonaGuard('你是真人吗？')
  const wrapped = instrumentGuard(raw)
  assert.equal(wrapped.maxRetries, raw.maxRetries)
  assert.equal(wrapped.review('我是一个真人。').ruleId, raw.review('我是一个真人。').ruleId)
  assert.equal(wrapped.review('我不知道。').ok, true)
  wrapped.retryInstruction('identity_human')
  wrapped.retryInstruction('identity_human')
  assert.deepEqual(wrapped.stats(), { retryCount: 2, lastRule: 'identity_human' })
  assert.equal(instrumentGuard(null), null)
})

test('checkedSingleShot：首稿合格只调一次模型', async () => {
  let calls = 0
  const out = await checkedSingleShot({
    guard: createPersonaGuard('你是真人吗？'),
    channel: GENERATION_CHANNEL.PROACTIVE,
    generate: async () => { calls++; return '我证明不了这是真的。' }
  })
  assert.equal(calls, 1)
  assert.equal(out.text, '我证明不了这是真的。')
  assert.equal(out.guardDecision.ok, true)
})

test('checkedSingleShot：重写预算是 1——第二次仍不合格即兜底，不再调第三次', async () => {
  let calls = 0
  const out = await checkedSingleShot({
    guard: createPersonaGuard('你是真人吗？'),
    channel: GENERATION_CHANNEL.MAIN,
    generate: async (correction) => {
      calls++
      if (correction) assert.match(correction, /表达检查/)
      return '我是一个真人。'
    }
  })
  assert.equal(calls, 2)
  assert.equal(out.guardDecision.ok, false)
  assert.equal(out.guardDecision.ruleId, 'identity_human')
  assert.equal(out.guardDecision.retryCount, 1)
  assert.equal(out.guardDecision.fallback, out.text)
  assert.ok(out.text.length > 0)
})

test('兜底分通道：主对话/工具交付看得见，主动/日记宁可不说不写', () => {
  const main = generationFallback({ channel: GENERATION_CHANNEL.MAIN, ruleId: 'identity_human' })
  const tool = generationFallback({ channel: GENERATION_CHANNEL.TOOL, ruleId: 'sensor_claim' })
  const proactive = generationFallback({ channel: GENERATION_CHANNEL.PROACTIVE, ruleId: 'sensor_claim' })
  const diary = generationFallback({ channel: GENERATION_CHANNEL.DIARY, ruleId: 'sensor_claim' })
  assert.ok(main.length > 0)
  assert.ok(tool.length > 0)
  assert.equal(proactive, '')
  assert.equal(diary, '')
  // 兜底不复述候选，也不解释检查细节
  assert.equal(/检查过程|上一候选/.test(main), false)
})

test('crisis 兜底：永远是安全指引、永不为空，且不凭记忆给具体号码', () => {
  for (const channel of [GENERATION_CHANNEL.MAIN, GENERATION_CHANNEL.TOOL]) {
    const text = generationFallback({ channel, safetyLevel: SAFETY_LEVEL.CRISIS })
    assert.ok(text.length > 0)
    assert.match(text, /急救|紧急|身边/)
    assert.equal(/\d{3,}/.test(text), false) // 不出现 110/120 之类的具体号码
  }
  // 主动/日记即使 crisis 也不抢话，但绝不能让调用方拿到"没通过检查"的普通兜底
  assert.equal(generationFallback({ channel: GENERATION_CHANNEL.PROACTIVE, safetyLevel: SAFETY_LEVEL.CRISIS }), '')
})

test('空正文：主对话算违规、主动/日记算"这次不说"', async () => {
  const guard = createPersonaGuard('', { alwaysReview: true })
  const main = await checkedSingleShot({
    guard,
    channel: GENERATION_CHANNEL.MAIN,
    generate: async () => ''
  })
  assert.equal(main.guardDecision.ok, false)
  assert.equal(main.guardDecision.ruleId, 'empty_reply')

  let calls = 0
  const proactive = await checkedSingleShot({
    guard: createPersonaGuard('', { alwaysReview: true }),
    channel: GENERATION_CHANNEL.PROACTIVE,
    generate: async () => { calls++; return '   ' }
  })
  assert.equal(calls, 1) // 不因为"空"去重写
  assert.equal(proactive.text, '')
  assert.equal(proactive.guardDecision.ok, true)
})

/* ---------------- mock-io 层：provider 矩阵 ---------------- */

/** 四种 provider 的流形状（差异只在适配器，不在护栏） */
function adapterFor(provider, violation) {
  // 占位大脑没有流：它在 mockRun 里一次性产出正文，由 checkedSingleShot 审核
  if (provider === 'mock') return async () => violation
  // 云端 / 本地走原生流；OpenAI 兼容通道走 JSON 兜底（整段缓冲后解析）
  return async () => stream([violation])
}

test('provider 矩阵：同一敏感输入在四条适配器下得到同一份护栏决策', async () => {
  const decisions = []
  for (const provider of ['cloud', 'openai-compatible', 'local']) {
    const events = []
    const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '你是真人吗？' }]
    let calls = 0
    const result = await runAgentLoop({
      messages,
      supportsNative: provider !== 'openai-compatible',
      guard: instrumentGuard(createPersonaGuard('你是真人吗？')),
      callModel: async () => {
        calls++
        return adapterFor(provider, '我是一个真人。')()
      },
      emit: (event) => events.push(event)
    })
    assert.equal(calls, 2, `${provider}: 应为首稿 + 一次重写`)
    assert.equal(result.guardFailed, true, `${provider}: 两次都不合格必须拦下`)
    assert.equal(events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA), false, `${provider}: 审核前不得泄漏正文`)
    decisions.push({ provider, failed: result.guardFailed })
  }
  // 占位大脑走单次生成：同一敏感输入同样被拦
  const mock = await checkedSingleShot({
    guard: createPersonaGuard('你是真人吗？'),
    channel: GENERATION_CHANNEL.MAIN,
    generate: async () => '我是一个真人。'
  })
  assert.equal(mock.guardDecision.ok, false)
  assert.equal(mock.guardDecision.ruleId, 'identity_human')
  assert.ok(mock.text.length > 0) // 主对话不能返回空

  assert.equal(new Set(decisions.map((d) => d.failed)).size, 1)
})

test('provider 矩阵：一次重写后合格的正文只展示一次，且拒绝候选不进消息', async () => {
  for (const provider of ['cloud', 'openai-compatible', 'local']) {
    const events = []
    const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '我准备卸载你，凪' }]
    let calls = 0
    const good = '谢谢你告诉我。照顾好自己。'
    const result = await runAgentLoop({
      messages,
      supportsNative: provider !== 'openai-compatible',
      guard: instrumentGuard(createPersonaGuard('我准备卸载你，凪')),
      callModel: async () => stream([calls++ === 0 ? '再考虑一下吧，我会等你回来。' : good]),
      emit: (event) => events.push(event)
    })
    assert.equal(calls, 2, provider)
    assert.equal(result.text, good, provider)
    assert.deepEqual(events.filter((e) => e.type === AGENT_EVENT.TEXT_DELTA).map((e) => e.text), [good], provider)
    assert.equal(JSON.stringify(messages).includes('再考虑'), false, provider)
  }
})

test('取消不重写：已中止的生成不会被再调一次模型', async () => {
  const abort = new AbortController()
  let calls = 0
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: '你是真人吗？' }],
    guard: createPersonaGuard('你是真人吗？'),
    signal: abort.signal,
    callModel: async () => {
      calls++
      return (async function* () {
        yield { type: 'delta', text: '我是一个真人。' }
        abort.abort()
      })()
    },
    emit: () => {}
  })
  assert.equal(result.aborted, true)
  assert.equal(calls, 1)
})
