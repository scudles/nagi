// src/core/llm/openai-compatible.js
// 以 OpenAI Chat Completions 为统一内部协议；只换 baseURL + key + model 即可切各家模型。

import OpenAI from 'openai'

export function createClient({ apiKey, baseURL, timeout = 60000 }) {
  if (!apiKey) throw new Error('缺少 API Key')
  if (!baseURL) throw new Error('缺少 baseURL')
  return new OpenAI({
    apiKey,
    baseURL,
    timeout,
    dangerouslyAllowBrowser: false // 只在主进程创建
  })
}

/**
 * 流式对话。
 * @returns {AsyncGenerator<{type:'delta'|'tool_call'|'done', text?:string, toolCalls?:Array}>}
 */
export async function* chatStream(client, { model, messages, temperature = 0.7, tools, signal, toolChoice, reasoningEffort }) {
  const body = { model, messages, temperature, stream: true }
  // 只在调用方明确要求时传。部分端侧思考模型对 none 的实现会把推演文字混进正文。
  if (reasoningEffort) body.reasoning_effort = reasoningEffort
  if (tools && tools.length) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }

  const stream = await client.chat.completions.create(body, { signal })
  const toolAcc = new Map() // index -> { id, name, arguments }

  for await (const chunk of stream) {
    const choice = chunk.choices && chunk.choices[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (delta.content) yield { type: 'delta', text: delta.content }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        toolAcc.set(idx, cur)
      }
    }
    if (choice.finish_reason) {
      // 收尾，把累积的 tool_calls 吐出来
      if (toolAcc.size) {
        yield { type: 'tool_call', toolCalls: [...toolAcc.values()] }
      }
      yield { type: 'done', finishReason: choice.finish_reason }
      return
    }
  }
  if (toolAcc.size) yield { type: 'tool_call', toolCalls: [...toolAcc.values()] }
  yield { type: 'done' }
}

/** 非流式（用于简单判断/工具参数补全） */
export async function chat(client, { model, messages, temperature = 0.7, tools }) {
  const body = { model, messages, temperature }
  if (tools && tools.length) body.tools = tools
  const res = await client.chat.completions.create(body)
  return res.choices?.[0]?.message || null
}
