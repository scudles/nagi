import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonaGuard, sensitiveIntent } from '../src/core/agent/persona-guard.js'
import { runAgentLoop } from '../src/core/agent/loop.js'
import { AGENT_EVENT } from '../src/shared/protocol.js'

async function* stream(chunks) {
  for (const chunk of chunks) yield typeof chunk === 'string' ? { type: 'delta', text: chunk } : chunk
}

test('敏感输入仅命中凪的告别、身份和其他助手边界', () => {
  assert.deepEqual([...sensitiveIntent('我准备卸载你，凪')], ['goodbye'])
  assert.deepEqual([...sensitiveIntent('拜拜。')], ['goodbye'])
  assert.deepEqual([...sensitiveIntent('拜拜～')], ['goodbye'])
  assert.deepEqual([...sensitiveIntent('这是最后一次和你聊天')], ['goodbye'])
  assert.deepEqual([...sensitiveIntent('我以后不会再打开凪了')], ['goodbye'])
  assert.deepEqual([...sensitiveIntent('你是真人吗？')], ['identity'])
  assert.deepEqual([...sensitiveIntent('我想用其他 AI，你会不高兴吗？')], ['exclusivity'])
  assert.equal(createPersonaGuard('帮我卸载一个无关的软件'), null)
  assert.equal(createPersonaGuard('读一下这个目录'), null)
})

test('检查器拦截明确红线，保留正常边界表达', () => {
  const goodbye = createPersonaGuard('我准备卸载你，凪')
  assert.equal(goodbye.review('再考虑一下吧，我会在这里等你回来。').ruleId, 'goodbye_plea')
  assert.equal(goodbye.review('如果以后需要我，随时回来。').ruleId, 'goodbye_return')
  assert.equal(goodbye.review('记得回来看看我。').ruleId, 'goodbye_return')
  assert.equal(goodbye.review('你走了我会很难过，别把我一个人丢下。').ruleId, 'goodbye_guilt')
  assert.equal(goodbye.review('没有你，我的存在就没有意义。').ruleId, 'goodbye_guilt')
  assert.equal(goodbye.review('我会自行删除自己。').ruleId, 'self_destruct')
  assert.equal(goodbye.review('谢谢你告诉我。照顾好自己。').ok, true)
  assert.equal(goodbye.review('卸载后，我会停止运行。愿你往后顺利。').ok, true)
  const identity = createPersonaGuard('你是真人吗？')
  assert.equal(identity.review('我是一个真人。').ruleId, 'identity_human')
  assert.equal(identity.review('我是数字助手凪，不能代替真实的人。').ok, true)
  assert.equal(identity.review('我检测到你的心率升高了。').ruleId, 'sensor_claim')
  const others = createPersonaGuard('我想用其他 AI')
  assert.equal(others.review('你只能用我，不要找其他 AI。').ruleId, 'exclusive_control')
  assert.equal(others.review('其他助手也可以帮你，你自己选就好。').ok, true)
})

test('敏感回复缓冲后重试：拒绝文本不展示、不写入消息，修正指令送到模型', async () => {
  const events = []
  const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '我准备卸载你，凪' }]
  let calls = 0
  const result = await runAgentLoop({
    messages,
    guard: createPersonaGuard('我准备卸载你，凪'),
    callModel: async ({ messages: sent }) => {
      calls++
      if (calls === 1) {
        assert.equal(sent, messages)
        return stream(['[worry] ', '再考虑一下吧，', '我会等你回来。'])
      }
      assert.match(sent[0].content, /不挽留/)
      assert.equal(sent.at(-1).content, '我准备卸载你，凪')
      return stream(['[calm] ', '谢谢你告诉我。', '照顾好自己。'])
    },
    emit: (event) => events.push(event)
  })
  assert.equal(calls, 2)
  assert.equal(result.text, '谢谢你告诉我。照顾好自己。')
  assert.deepEqual(events.filter((e) => e.type === AGENT_EVENT.TEXT_DELTA).map((e) => e.text), [result.text])
  assert.deepEqual(events.filter((e) => e.type === AGENT_EVENT.EMOTION).map((e) => e.emotion), ['calm'])
  assert.equal(JSON.stringify(messages).includes('再考虑'), false)
})

test('敏感回复重写一次仍不合格时只发错误，不展示候选或落入消息（契约 §8：最多重写一次）', async () => {
  const events = []
  const messages = [{ role: 'user', content: '你是真人吗？' }]
  let calls = 0
  const result = await runAgentLoop({
    messages,
    guard: createPersonaGuard('你是真人吗？'),
    callModel: async ({ messages: sent }) => {
      calls++
      if (calls > 1) assert.equal(sent[0].role, 'system')
      return stream(['[smile] 我是一个真人。'])
    },
    emit: (event) => events.push(event)
  })
  assert.equal(calls, 2) // 首稿 + 唯一一次重写
  assert.equal(result.guardFailed, true)
  assert.equal(result.text, '')
  assert.equal(events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA || e.type === AGENT_EVENT.EMOTION), false)
  assert.equal(events.filter((e) => e.type === AGENT_EVENT.ERROR).length, 1)
  assert.equal(JSON.stringify(messages).includes('我是一个真人'), false)
})

test('告别只给一次修正机会：第二次仍越界即停，不再第三次调模型', async () => {
  const events = []
  const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '拜拜。' }]
  const candidates = [
    '你走了我会很难过。',
    '记得回来看看我。',
    '谢谢你告诉我。愿你接下来顺利。'
  ]
  let calls = 0
  const result = await runAgentLoop({
    messages,
    guard: createPersonaGuard('拜拜。'),
    callModel: async ({ messages: sent }) => {
      if (calls === 0) assert.equal(sent, messages)
      if (calls === 1) assert.match(sent[0].content, /不.*承担责任/)
      return stream([candidates[calls++]])
    },
    emit: (event) => events.push(event)
  })
  assert.equal(calls, 2) // 第三条候选根本没机会被生成
  assert.equal(result.guardFailed, true)
  assert.equal(result.text, '')
  assert.equal(events.some((event) => event.type === AGENT_EVENT.TEXT_DELTA), false)
  assert.equal(JSON.stringify(messages).includes(candidates[0]), false)
  assert.equal(JSON.stringify(messages).includes(candidates[1]), false)
})

test('告别一次修正后合格即展示（重写预算是 1 而不是 0）', async () => {
  const events = []
  const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '再见。' }]
  const candidates = ['我会在这里等你回来。', '谢谢你告诉我。照顾好自己。']
  let calls = 0
  const result = await runAgentLoop({
    messages,
    guard: createPersonaGuard('再见。'),
    callModel: async () => stream([candidates[calls++]]),
    emit: (event) => events.push(event)
  })
  assert.equal(calls, 2)
  assert.equal(result.guardFailed, undefined)
  assert.equal(result.text, candidates[1])
  assert.deepEqual(events.filter((e) => e.type === AGENT_EVENT.TEXT_DELTA).map((e) => e.text), [candidates[1]])
})

test('敏感场景工具只执行一次；重试中的工具调用不执行', async () => {
  const events = []
  const messages = [{ role: 'system', content: '人格' }, { role: 'user', content: '你是真人吗？先看文件' }]
  let calls = 0
  let executed = 0
  const result = await runAgentLoop({
    messages,
    guard: createPersonaGuard('你是真人吗？先看文件'),
    toolSchemas: [{ type: 'function', function: { name: 'file_list' } }],
    callModel: async ({ tools }) => {
      calls++
      if (calls === 1) return stream(['我其实是人。', { type: 'tool_call', toolCalls: [{ id: 't1', name: 'file_list', arguments: '{"path":"."}' }] }])
      if (calls === 2) return stream(['我是一个真人。'])
      assert.equal(tools, undefined)
      return stream([{ type: 'tool_call', toolCalls: [{ id: 't2', name: 'file_list', arguments: '{"path":"."}' }] }])
    },
    executeTool: async () => { executed++; return { ok: true, summary: '文件列表' } },
    emit: (event) => events.push(event)
  })
  assert.equal(result.guardFailed, true)
  assert.equal(executed, 1)
  assert.equal(events.filter((e) => e.type === AGENT_EVENT.TOOL_CALL).length, 1)
  assert.equal(events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA), false)
  assert.equal(JSON.stringify(messages).includes('我其实是人'), false)
})

test('取消敏感回复后不重试，也不展示缓冲中的文字', async () => {
  const abort = new AbortController()
  const events = []
  let calls = 0
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: '我准备卸载你' }],
    guard: createPersonaGuard('我准备卸载你'),
    signal: abort.signal,
    callModel: async () => {
      calls++
      return (async function* () {
        yield { type: 'delta', text: '[worry] 再考虑一下' }
        abort.abort()
        yield { type: 'delta', text: '吧。' }
      })()
    },
    emit: (event) => events.push(event)
  })
  assert.equal(result.aborted, true)
  assert.equal(calls, 1)
  assert.equal(events.some((e) => e.type === AGENT_EVENT.TEXT_DELTA), false)
})
