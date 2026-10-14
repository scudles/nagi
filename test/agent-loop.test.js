// test/agent-loop.test.js
// Agent Loop 纯逻辑单测（注入假模型 / 假工具 / 假确认）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop, buildSystemPrompt, describeToolCall } from '../src/core/agent/loop.js'
import { AGENT_EVENT } from '../src/shared/protocol.js'

function fakeEmitter() {
  const events = []
  return { events, emit: (e) => events.push(e) }
}

function types(events) {
  return events.map((e) => e.type)
}

async function* streamOf(chunks) {
  for (const c of chunks) {
    if (typeof c === 'string') yield { type: 'delta', text: c }
    else yield c
  }
}

test('buildSystemPrompt：原生通道不含 JSON 协议提示，兜底通道含', () => {
  const p = buildSystemPrompt()
  assert.ok(p.includes('[calm]'))
  assert.ok(p.includes('凪'))
  assert.ok(!p.includes('JSON 代码块'), '原生通道不应注入 JSON 协议提示（会干扰模型选通道）')
  const p2 = buildSystemPrompt({ nativeTools: false })
  assert.ok(p2.includes('JSON 代码块'))
})

test('纯文本回复：情绪标签被解析且不进正文，事件序列完整', async () => {
  const { events, emit } = fakeEmitter()
  const callModel = async () =>
    streamOf(['[smile] ', '你好', '呀。'])
  const r = await runAgentLoop({ messages: [{ role: 'system', content: 'sys' }], supportsNative: true, callModel, emit })
  assert.equal(r.text, '你好呀。')
  assert.deepEqual(types(events).filter((t) => t === AGENT_EVENT.EMOTION), ['emotion'])
  assert.equal(events.find((e) => e.type === AGENT_EVENT.EMOTION).emotion, 'smile')
  assert.equal(events.find((e) => e.type === AGENT_EVENT.DONE).text, '你好呀。')
  assert.ok(!events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA && /\[smile\]/.test(e.text)), '标签不应出现在正文')
})

test('原生通道：工具调用 → 结果回喂 → 最终回复', async () => {
  const { events, emit } = fakeEmitter()
  const executed = []
  const executeTool = async (name, args) => {
    executed.push({ name, args })
    return { ok: true, summary: `读到 3 个文件（${args.path}）` }
  }
  let round = 0
  const callModel = async ({ messages }) => {
    round++
    if (round === 1) {
      assert.ok(messages[messages.length - 1].role === 'user')
      return streamOf([{ type: 'tool_call', toolCalls: [{ id: 't1', name: 'file_list', arguments: '{"path":"D:/work"}' }] }, { type: 'done' }])
    }
    // 第二轮：最后一条应是 tool 结果
    const last = messages[messages.length - 1]
    assert.equal(last.role, 'tool')
    assert.ok(last.content.includes('3 个文件'))
    return streamOf(['[calm] ', '列好了，共 3 个文件。'])
  }
  const r = await runAgentLoop({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: '看看那个目录' }],
    supportsNative: true,
    callModel,
    executeTool,
    emit
  })
  assert.equal(r.text, '列好了，共 3 个文件。')
  assert.equal(r.steps, 2)
  assert.deepEqual(executed, [{ name: 'file_list', args: { path: 'D:/work' } }])
  assert.ok(events.some((e) => e.type === AGENT_EVENT.TOOL_CALL && e.name === 'file_list'))
  assert.ok(events.some((e) => e.type === AGENT_EVENT.TOOL_RESULT && e.ok === true))
})

test('JSON 兜底通道：JSON 块被解析且不出现在给用户的正文里', async () => {
  const { events, emit } = fakeEmitter()
  let round = 0
  const callModel = async () => {
    round++
    if (round === 1) {
      return streamOf(['[puzzled] 我先看看。\n```json\n{"action":"web_search","args":{"query":"天气"}}\n```'])
    }
    return streamOf(['[smile] 查到了：晴。'])
  }
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: '今天天气' }],
    supportsNative: false,
    callModel,
    executeTool: async () => ({ ok: true, summary: '晴，26 度' }),
    emit
  })
  assert.equal(r.text, '查到了：晴。')
  assert.ok(!events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA && e.text.includes('json')), 'JSON 不应漏给用户')
})

test('高危工具需确认：拒绝则不执行', async () => {
  const { events, emit } = fakeEmitter()
  let executed = false
  const confirmCalls = []
  let round = 0
  const callModel = async () => {
    round++
    if (round === 1) return streamOf([{ type: 'tool_call', toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"mkdir nagi_test_dir"}' }] }, { type: 'done' }])
    return streamOf(['[worry] 好的，不执行了。'])
  }
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: '看看版本' }],
    supportsNative: true,
    callModel,
    executeTool: async () => {
      executed = true
      return { ok: true, summary: 'v22' }
    },
    confirm: async (c) => {
      confirmCalls.push(c)
      return false
    },
    emit,
    safety: { confirmHighRisk: true }
  })
  assert.equal(executed, false)
  assert.equal(confirmCalls.length, 1)
  assert.ok(events.some((e) => e.type === AGENT_EVENT.TOOL_RESULT && e.ok === false && /拒绝/.test(e.summary)))
  assert.equal(r.text, '好的，不执行了。')
})

test('白名单命令免确认直接执行', async () => {
  const { emit } = fakeEmitter()
  let confirmCalled = false
  let executed = false
  let round = 0
  const callModel = async () => {
    round++
    if (round === 1) return streamOf([{ type: 'tool_call', toolCalls: [{ id: 'w1', name: 'run_command', arguments: '{"command":"node -v"}' }] }, { type: 'done' }])
    return streamOf(['[calm] v22。'])
  }
  await runAgentLoop({
    messages: [{ role: 'user', content: '版本' }],
    supportsNative: true,
    callModel,
    executeTool: async () => {
      executed = true
      return { ok: true, summary: 'v22.2.2' }
    },
    confirm: async () => {
      confirmCalled = true
      return true
    },
    emit
  })
  assert.equal(executed, true)
  assert.equal(confirmCalled, false, '白名单命令不应弹确认')
})

test('黑名单命令被永久拒绝，不执行也不确认', async () => {
  const { events, emit } = fakeEmitter()
  let executed = false
  let confirmCalled = false
  let round = 0
  const callModel = async () => {
    round++
    if (round === 1) return streamOf([{ type: 'tool_call', toolCalls: [{ id: 'b1', name: 'run_command', arguments: '{"command":"format c:"}' }] }, { type: 'done' }])
    return streamOf(['[worry] 不行。'])
  }
  await runAgentLoop({
    messages: [{ role: 'user', content: '格式化' }],
    supportsNative: true,
    callModel,
    executeTool: async () => {
      executed = true
      return { ok: true, summary: '' }
    },
    confirm: async () => {
      confirmCalled = true
      return true
    },
    emit
  })
  assert.equal(executed, false)
  assert.equal(confirmCalled, false)
  assert.ok(events.some((e) => e.type === AGENT_EVENT.TOOL_RESULT && /黑名单/.test(e.summary)))
})

test('步数上限：一直要工具时到达 maxSteps 停止', async () => {
  const { events, emit } = fakeEmitter()
  let n = 0
  const callModel = async () => {
    n++
    return streamOf([{ type: 'tool_call', toolCalls: [{ id: 's' + n, name: 'web_search', arguments: '{"query":"x"}' }] }, { type: 'done' }])
  }
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: '搜' }],
    supportsNative: true,
    callModel,
    executeTool: async () => ({ ok: true, summary: '结果' }),
    emit,
    maxSteps: 3
  })
  assert.equal(r.steps, 3)
  assert.ok(r.text.includes('上限'))
})

describeToolCall && test('describeToolCall 给出人类可读描述', () => {
  assert.ok(describeToolCall('run_command', { command: 'dir' }).includes('dir'))
  assert.ok(describeToolCall('file_write', { path: 'D:/a.txt' }).includes('D:/a.txt'))
})
