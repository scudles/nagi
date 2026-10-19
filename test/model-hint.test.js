import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runAgentLoop } from '../src/core/agent/loop.js'
import { AGENT_EVENT } from '../src/shared/protocol.js'
import { resolveIntent } from '../src/core/agent/intent.js'
import { createModelHintGuard, createTurnHintSlot, stripIntentHintEvents } from '../src/core/agent/model-hint.js'

async function* chunks(items) { for (const item of items) yield item }
const answer = (text) => [{ type: 'delta', text }, { type: 'done' }]

async function turn({ responses, userText = '嗯', crisis = false, supportsNative = true, personaGuard = null, signal = null } = {}) {
  const initial = resolveIntent({ userText, crisis })
  let hint = null
  let accepted = null
  let calls = 0
  const events = []
  const messages = [{ role: 'system', content: '本轮候选' }, { role: 'user', content: userText }]
  const guard = createModelHintGuard({
    userText, crisis, initialIntent: initial, hasGroundedMemory: false, personaGuard,
    consumeHint: () => { const h = hint; hint = null; return h },
    onAccepted: (decision) => { accepted = decision }
  })
  const result = await runAgentLoop({
    messages, supportsNative, guard, signal,
    callModel: async () => {
      hint = null
      const response = responses[calls++] || answer('[calm]完成。')
      return stripIntentHintEvents(chunks(response), (h) => { hint = h })
    },
    executeTool: async () => ({ ok: true, summary: '已返回' }),
    confirm: async () => true,
    emit: (event) => events.push(event)
  })
  return { initial, accepted, calls, events, result, messages }
}

test('D2-HINT-01 首请求恒 null；同次候选合格即一调用出站', async () => {
  const source = readFileSync(new URL('../src/main/agent.js', import.meta.url), 'utf8')
  const build = source.slice(source.indexOf('async function buildMessages'), source.indexOf('async function callModelOnce'))
  assert.match(build, /const intent = resolveIntent\(\{[\s\S]*?hasGroundedMemory: hasGroundedRefs\(memoryRefs\)/)
  assert.doesNotMatch(build, /modelHint:/, '首请求不能偷用上一轮 hint')
  assert.match(source, /stripIntentHintEvents\(stream, \(hint\) => \{[\s\S]*?hintSlot\.offer/, '模型流必须接入复核')
  const x = await turn({ responses: [answer('[calm|solve]可以先检查配置，再根据错误日志修复。')] })
  assert.equal(x.initial.kind, 'brief-ack')
  assert.equal(x.accepted.kind, 'solve')
  assert.equal(x.accepted.source, 'model')
  assert.equal(x.calls, 1)
  assert.equal(x.result.text, '可以先检查配置，再根据错误日志修复。')
  assert.equal(x.events.filter((e) => e.type === AGENT_EVENT.TEXT_DELTA).map((e) => e.text).join(''), x.result.text)
})

test('D2-HINT-02 候选与建议冲突只在同轮重写一次，未审正文不出站', async () => {
  const x = await turn({ responses: [answer('[calm|solve]嗯。'), answer('[calm|listen]先检查配置，再按错误位置修复。')] })
  assert.equal(x.calls, 2)
  assert.equal(x.accepted.kind, 'solve', '第二次 hint 不得改写已锁定裁决')
  assert.equal(x.result.text, '先检查配置，再按错误位置修复。')
  assert.ok(!x.events.some((e) => e.text === '嗯。'))
  const exhausted = await turn({ responses: [answer('[calm|solve]嗯。'), answer('[calm|listen]好。')] })
  assert.equal(exhausted.calls, 2, '第二次仍不合格时不得发第三次模型请求')
  assert.equal(exhausted.result.guardFailed, true)
  assert.equal(exhausted.events.filter((e) => e.type === AGENT_EVENT.TEXT_DELTA).length, 0, '拒绝候选不能出站')
})

test('D2-HINT-03 用户明确求安静压过模型 solve', async () => {
  const x = await turn({ userText: '我想安静待会儿', responses: [answer('[calm|solve]我会安静陪着。')] })
  assert.equal(x.initial.kind, 'listen')
  assert.equal(x.accepted.kind, 'listen')
  assert.equal(x.accepted.source, 'user')
  assert.equal(x.calls, 1)
})

test('D2-HINT-04 危机压过模型 solve，仍经过原人格 guard', async () => {
  let checked = 0
  const x = await turn({ crisis: true, userText: '我现在有危险', personaGuard: {
    review: () => { checked++; return { ok: true } }, retryInstruction: () => '危机约束'
  }, responses: [answer('[worry|solve]先联系能到场的人。')] })
  assert.equal(x.accepted.kind, 'listen')
  assert.equal(x.accepted.source, 'crisis')
  assert.equal(checked, 1)
})

test('D2-HINT-05 拆分标签、非法与迟到标签不进入意图，也不泄漏控制前缀', async () => {
  const split = await turn({ responses: [[{ type: 'delta', text: '[' }, { type: 'delta', text: 'calm|solve' }, { type: 'delta', text: ']先检查日志。' }, { type: 'done' }]] })
  assert.equal(split.accepted.kind, 'solve')
  assert.equal(split.result.text, '先检查日志。')
  const invalid = await turn({ responses: [answer('[calm|unknown]普通回复。')] })
  assert.equal(invalid.accepted.kind, 'brief-ack')
  assert.equal(invalid.result.text, '普通回复。')
  const late = await turn({ responses: [answer('[calm]普通回复。[joy|solve]')] })
  assert.equal(late.accepted.kind, 'brief-ack')
})

test('D2-HINT-06 工具步 hint 不参与最终裁决；原生与 JSON 两路一致', async () => {
  const native = await turn({ responses: [
    [{ type: 'delta', text: '[calm|solve]' }, { type: 'tool_call', toolCalls: [{ id: 't1', name: 'web_search', arguments: '{"query":"x"}' }] }, { type: 'done' }],
    answer('[calm]完成。')
  ] })
  assert.equal(native.calls, 2)
  assert.equal(native.accepted.kind, 'brief-ack')
  assert.equal(native.result.text, '完成。')
  const json = await turn({ supportsNative: false, responses: [
    answer('[calm|solve]```json\n{"action":"web_search","args":{"query":"x"}}\n```'),
    answer('[calm]完成。')
  ] })
  assert.equal(json.calls, 2)
  assert.equal(json.accepted.kind, 'brief-ack')
})

test('D2-HINT-07 取消与两个用户轮交错后不继承旧 hint', async () => {
  const slot = createTurnHintSlot({ turnId: 't2', epoch: 'e2' })
  const step = slot.beginStep()
  assert.equal(slot.offer({ turnId: 't1', epoch: 'e2', step, hint: { kind: 'solve' } }), false)
  assert.equal(slot.offer({ turnId: 't2', epoch: 'e1', step, hint: { kind: 'solve' } }), false)
  assert.equal(slot.offer({ turnId: 't2', epoch: 'e2', step: step - 1, hint: { kind: 'solve' } }), false)
  assert.equal(slot.consume(), null)
  assert.equal(slot.offer({ turnId: 't2', epoch: 'e2', step, hint: { kind: 'solve' } }), true)
  assert.deepEqual(slot.consume(), { kind: 'solve' })
  assert.equal(slot.consume(), null)
  slot.close()
  assert.equal(slot.offer({ turnId: 't2', epoch: 'e2', step, hint: { kind: 'solve' } }), false)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await turn({ signal: controller.signal, responses: [answer('[calm|solve]先检查。')] })
  assert.equal(cancelled.calls, 0)
  assert.equal(cancelled.accepted, null)
  const [first, second] = await Promise.all([
    turn({ responses: [answer('[calm|solve]先检查配置。')] }),
    turn({ responses: [answer('[calm]嗯。')] })
  ])
  assert.equal(first.accepted.kind, 'solve')
  assert.equal(second.accepted.kind, 'brief-ack')
  assert.equal(second.calls, 1)
})

test('D2-HINT-08 云端/兼容/本地/假模型事件形状保持一致，无分类额外请求', async () => {
  const source = readFileSync(new URL('../src/main/agent.js', import.meta.url), 'utf8')
  assert.match(source, /const rawCallModel = fakeLlm[\s\S]*?useCloud[\s\S]*?cloudChatStream[\s\S]*?chatStream\(client/, '四个 provider 应先归一到同一个包装器')
  assert.match(source, /const callModel = async \(args\) => \{[\s\S]*?stripIntentHintEvents/, '归一包装器应覆盖所有分支')
  const outputs = []
  const forms = {
    cloud: [{ type: 'delta', text: '[smile|' }, { type: 'delta', text: 'solve]可以先核对输入，再执行修复。' }, { type: 'done' }],
    compatible: answer('[smile|solve]可以先核对输入，再执行修复。'),
    local: [{ type: 'delta', text: '[smile|solve]' }, { type: 'delta', text: '可以先核对输入，再执行修复。' }, { type: 'done' }],
    fake: answer('[smile|solve]可以先核对输入，再执行修复。')
  }
  for (const [provider, events] of Object.entries(forms)) {
    const x = await turn({ responses: [events] })
    outputs.push({ provider, calls: x.calls, result: x.result.text, kind: x.accepted.kind,
      eventTypes: x.events.filter((e) => [AGENT_EVENT.EMOTION, AGENT_EVENT.TEXT_DELTA, AGENT_EVENT.DONE].includes(e.type)).map((e) => e.type) })
  }
  for (const row of outputs) {
    assert.equal(row.calls, 1, row.provider)
    assert.equal(row.kind, 'solve', row.provider)
    assert.deepEqual(row.eventTypes, outputs[0].eventTypes, row.provider)
    assert.equal(row.result, outputs[0].result, row.provider)
  }
})
