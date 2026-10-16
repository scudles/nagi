// test/agent-cancel.test.js
// B07：R01 取消 / 确认 / 一次性 token 回归固化（Agent 循环与确认门部分）。
// 场景来源：HANDOFF B07 输入的 15 项临时验证（本文件覆盖其中 11 项 Agent/确认门场景，
// settings IPC 的 4 项见 settings-file-root.test.js）。
// 保护的契约：
//   1) CONFIRM.id 是宿主一次性 token，不等于模型工具 ID；TOOL_CALL/TOOL_RESULT 仍按模型 ID 关联；
//   2) 超时、取消、拒绝、过期不授予权限；迟到点击不能显示"已执行"；
//   3) 停止后不再启动尚未开始的动作；取消后未开始的 executeTool 调用次数必须为 0，正常批准只执行 1 次。
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from '../src/core/agent/loop.js'
import { waitForConfirmation, createConfirmationGate } from '../src/core/safety/confirmation.js'
import { AGENT_EVENT, AGENT_STATE } from '../src/shared/protocol.js'

function fakeEmitter() {
  const events = []
  return { events, emit: (e) => events.push(e) }
}

async function* streamOf(chunks) {
  for (const c of chunks) {
    if (typeof c === 'string') yield { type: 'delta', text: c }
    else yield c
  }
}

/** 需要确认的命令（mkdir 不在受控白名单，必须弹确认） */
const RISKY_ARGS = '{"command":"mkdir nagi_cancel_probe"}'
const RISKY_JSON = `[calm] 好，建目录。\n\`\`\`json\n{"action":"run_command","args":${RISKY_ARGS}}\n\`\`\``

/** 按通道产出第一轮工具调用，之后给一句收尾文本 */
function scriptedCallModel(supportsNative) {
  let round = 0
  return async () => {
    round++
    if (round === 1) {
      return supportsNative
        ? streamOf([{ type: 'tool_call', toolCalls: [{ id: 'tc-1', name: 'run_command', arguments: RISKY_ARGS }] }, { type: 'done' }])
        : streamOf([RISKY_JSON])
    }
    return streamOf(['[worry] 好，停下了。'])
  }
}

/* ---------------- waitForConfirmation ---------------- */

test('确认等待中取消：未决 Promise 被中断，且不授予权限', async () => {
  const controller = new AbortController()
  const p = waitForConfirmation(() => new Promise(() => {}), controller.signal) // 永不 settle
  controller.abort()
  assert.equal(await p, false, '取消后不得授予权限')
})

test('迟到拒绝被接住：不翻转结果，也不漏出未决拒绝', async () => {
  const controller = new AbortController()
  let rejectLate = null
  const p = waitForConfirmation(
    () => new Promise((_resolve, reject) => { rejectLate = reject }),
    controller.signal
  )
  controller.abort()
  assert.equal(await p, false)
  rejectLate(new Error('迟到拒绝')) // 已结算后到达的拒绝必须被内部处理器接住
  await new Promise((r) => setTimeout(r, 10)) // 若有未决拒绝，测试运行器会判失败
})

test('传入已中止的 signal：不再询问，直接不授予', async () => {
  const controller = new AbortController()
  controller.abort()
  const asked = []
  const r = await waitForConfirmation(() => { asked.push(1); return Promise.resolve(true) }, controller.signal)
  assert.equal(r, false)
  assert.equal(asked.length, 0, '已中止时不应再发起确认请求')
})

test('批准只在布尔 true 且未中止时生效', async () => {
  assert.equal(await waitForConfirmation(() => Promise.resolve(true)), true)
  assert.equal(await waitForConfirmation(() => Promise.resolve(false)), false)
  assert.equal(await waitForConfirmation(() => Promise.resolve('true')), false, '字符串 true 不算批准')
  assert.equal(await waitForConfirmation(() => Promise.resolve(1)), false, '数字 1 不算批准')
  const controller = new AbortController()
  controller.abort()
  assert.equal(await waitForConfirmation(() => Promise.resolve(true), controller.signal), false, '中止后 true 不算批准')
})

/* ---------------- createConfirmationGate ---------------- */

test('确认门：严格布尔批准，只有 true 放行', async () => {
  const gate = createConfirmationGate()
  const signal = new AbortController().signal
  for (const [answer, approved] of [['true', false], [1, false], [{}, false], [true, true]]) {
    const id = `tok-${String(answer)}-${approved}`
    const waiting = gate.request(id, signal)
    const res = gate.resolve(id, answer)
    assert.deepEqual(res, { ok: true }, `resolve(${JSON.stringify(answer)}) 应被受理`)
    assert.equal(await waiting, approved, `批准值 ${JSON.stringify(answer)} → ${approved}`)
  }
})

test('确认门：同一 token 的第二个请求不替换等待中的操作', async () => {
  const gate = createConfirmationGate()
  const signal = new AbortController().signal
  const first = gate.request('dup-token', signal)
  const second = await gate.request('dup-token', signal)
  assert.equal(second, false, '重复 token 不得顶掉原操作')
  assert.deepEqual(gate.resolve('dup-token', true), { ok: true })
  assert.equal(await first, true, '原等待应照常被批准')
})

test('确认门：超时过期不授予权限，过期后批准无效', async () => {
  const gate = createConfirmationGate({ timeoutMs: 30 })
  const signal = new AbortController().signal
  assert.equal(await gate.request('expired-token', signal), false, '超时必须自动拒绝')
  assert.deepEqual(gate.resolve('expired-token', true), { ok: false, error: '没有等待中的确认' }, '过期 token 的迟到批准应被拒')
})

test('确认门：取消后的迟到批准无效，未知 id 的批准被拒', async () => {
  const gate = createConfirmationGate()
  const controller = new AbortController()
  const waiting = gate.request('stale-token', controller.signal)
  controller.abort()
  assert.equal(await waiting, false)
  assert.deepEqual(gate.resolve('stale-token', true), { ok: false, error: '没有等待中的确认' }, '取消后迟到批准不得生效')
  assert.deepEqual(gate.resolve('never-asked', true), { ok: false, error: '没有等待中的确认' }, '未知 id 不得生效')
})

/* ---------------- runAgentLoop 取消矩阵（native / JSON 双通道） ---------------- */

for (const supportsNative of [true, false]) {
  const channel = supportsNative ? '原生通道' : 'JSON 兜底通道'

  test(`${channel}：等待确认时取消 → 工具不执行、不伪报结果`, async () => {
    const controller = new AbortController()
    const { events, emit } = fakeEmitter()
    const executed = []
    const confirmCalls = []
    const r = await runAgentLoop({
      messages: [{ role: 'user', content: '建个目录' }],
      supportsNative,
      callModel: scriptedCallModel(supportsNative),
      executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
      confirm: async (c) => {
        confirmCalls.push(c)
        return new Promise(() => { controller.abort() }) // 等待中取消
      },
      emit,
      signal: controller.signal
    })
    assert.equal(r.aborted, true)
    assert.equal(executed.length, 0, '取消后未开始的 executeTool 调用次数必须为 0')
    assert.equal(confirmCalls.length, 1)
    assert.ok(events.some((e) => e.type === AGENT_EVENT.CONFIRM), '应发出确认请求')
    assert.ok(!events.some((e) => e.type === AGENT_EVENT.TOOL_RESULT && e.id === 'tc-1'), '取消后不得伪报工具结果')
    assert.ok(events.some((e) => e.type === AGENT_EVENT.ERROR && e.message === '已取消'))
    assert.equal(r.text, '', '取消后不得把收尾文本当最终回复')
  })

  test(`${channel}：批准与取消同时到达 → 不执行`, async () => {
    const controller = new AbortController()
    const { events, emit } = fakeEmitter()
    const executed = []
    const r = await runAgentLoop({
      messages: [{ role: 'user', content: '建个目录' }],
      supportsNative,
      callModel: scriptedCallModel(supportsNative),
      executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
      confirm: async () => {
        controller.abort() // 先取消，再返回批准
        return true
      },
      emit,
      signal: controller.signal
    })
    assert.equal(r.aborted, true)
    assert.equal(executed.length, 0, '批准与取消同时到达时不得执行')
    assert.ok(!events.some((e) => e.type === AGENT_EVENT.TOOL_RESULT && e.ok === true), '不得显示已执行')
    assert.ok(events.some((e) => e.type === AGENT_EVENT.ERROR && e.message === '已取消'))
  })

  test(`${channel}：ACTING 时取消 → 执行入口不再启动`, async () => {
    const controller = new AbortController()
    const events = []
    const executed = []
    const emit = (e) => {
      events.push(e)
      if (e.type === AGENT_EVENT.STATUS && e.state === AGENT_STATE.ACTING) controller.abort()
    }
    const r = await runAgentLoop({
      messages: [{ role: 'user', content: '建个目录' }],
      supportsNative,
      callModel: scriptedCallModel(supportsNative),
      executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
      confirm: async () => true,
      emit,
      signal: controller.signal
    })
    assert.equal(r.aborted, true)
    assert.equal(executed.length, 0, 'ACTING 时取消，执行入口不得启动')
    assert.ok(events.some((e) => e.type === AGENT_EVENT.STATUS && e.state === AGENT_STATE.ACTING), '应经过 ACTING')
    assert.ok(events.some((e) => e.type === AGENT_EVENT.ERROR && e.message === '已取消'))
  })

  test(`${channel}：正常批准 → 恰好执行一次并回喂结果`, async () => {
    const modelId = supportsNative ? 'tc-1' : 'json_1_0' // JSON 通道的 ID 由循环合成
    const { events, emit } = fakeEmitter()
    const executed = []
    const confirmCalls = []
    let round = 0
    const callModel = async ({ messages }) => {
      round++
      if (round === 1) {
        return supportsNative
          ? streamOf([{ type: 'tool_call', toolCalls: [{ id: 'tc-1', name: 'run_command', arguments: RISKY_ARGS }] }, { type: 'done' }])
          : streamOf([RISKY_JSON])
      }
      const last = messages[messages.length - 1]
      assert.ok(String(last.content).includes('建好了'), '工具结果应回喂给模型')
      return streamOf(['[smile] 目录建好了。'])
    }
    const r = await runAgentLoop({
      messages: [{ role: 'user', content: '建个目录' }],
      supportsNative,
      callModel,
      executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
      confirm: async (c) => { confirmCalls.push(c); return true },
      emit
    })
    assert.equal(r.aborted, false)
    assert.equal(executed.length, 1, '正常批准只执行 1 次')
    assert.equal(confirmCalls.length, 1)
    assert.equal(r.text, '目录建好了。')
    const ask = events.find((e) => e.type === AGENT_EVENT.CONFIRM)
    assert.ok(ask, '应发出确认请求')
    assert.notEqual(ask.id, modelId, '确认 token 不得复用模型工具 ID')
    const result = events.find((e) => e.type === AGENT_EVENT.TOOL_RESULT)
    assert.equal(result.id, modelId, 'TOOL_RESULT 仍按模型工具 ID 关联')
    assert.equal(result.ok, true)
  })
}

test('未决确认被取消后，迟到拒绝不会带崩会话', async () => {
  const controller = new AbortController()
  const { events, emit } = fakeEmitter()
  const executed = []
  let rejectLate = null
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: '建个目录' }],
    supportsNative: true,
    callModel: scriptedCallModel(true),
    executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
    confirm: () => new Promise((_resolve, reject) => { rejectLate = reject }),
    emit: (e) => {
      emit(e)
      // 确认请求已发出（confirm 已被调用）之后再取消，模拟"等着时用户点了停止"
      if (e.type === AGENT_EVENT.CONFIRM) controller.abort()
    },
    signal: controller.signal
  })
  assert.equal(r.aborted, true)
  assert.equal(executed.length, 0)
  rejectLate(new Error('迟到拒绝'))
  await new Promise((res) => setTimeout(res, 10))
  assert.ok(events.some((e) => e.type === AGENT_EVENT.ERROR && e.message === '已取消'))
})

test('跨回合重复使用同一模型工具 ID：宿主确认 token 每轮都不同', async () => {
  const { events, emit } = fakeEmitter()
  const executed = []
  let round = 0
  const callModel = async () => {
    round++
    if (round <= 2) {
      // 模型在两回合里复用了同一个工具 ID
      return streamOf([{ type: 'tool_call', toolCalls: [{ id: 't1', name: 'run_command', arguments: RISKY_ARGS }] }, { type: 'done' }])
    }
    return streamOf(['[calm] 两次都执行了。'])
  }
  await runAgentLoop({
    messages: [{ role: 'user', content: '连续建两个目录' }],
    supportsNative: true,
    callModel,
    executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, summary: '建好了' } },
    confirm: async () => true,
    emit
  })
  const asks = events.filter((e) => e.type === AGENT_EVENT.CONFIRM)
  assert.equal(asks.length, 2, '两回合各弹一次确认')
  assert.notEqual(asks[0].id, asks[1].id, '重复模型 ID 必须生成不同的宿主确认 token')
  assert.ok(asks.every((a) => a.id !== 't1'), '确认 token 不得等于模型工具 ID')
  const calls = events.filter((e) => e.type === AGENT_EVENT.TOOL_CALL)
  assert.deepEqual(calls.map((c) => c.id), ['t1', 't1'], 'TOOL_CALL 保留模型原 ID')
  const results = events.filter((e) => e.type === AGENT_EVENT.TOOL_RESULT)
  assert.deepEqual(results.map((c) => c.id), ['t1', 't1'], 'TOOL_RESULT 按模型原 ID 关联')
  assert.equal(executed.length, 2, '两次批准各执行一次')
})
