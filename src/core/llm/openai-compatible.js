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
export async function* chatStream(client, { model, messages, temperature = 1.3, tools, signal, toolChoice, reasoningEffort }) {
  // 2026-10-18：temperature 缺省 0.7 → 1.3（DeepSeek 通用对话推荐值）。
  //
  // frequency_penalty 曾短暂加到 0.3 用来压"这点/确实/不装"的重复，**已撤掉**：
  // 实测出现整段词语崩坏（"先它保你一稳值终我突早认不了一"这种）。
  // 原因是中文一个词常对应多个 token，频率惩罚会累积着逼模型避开刚用过的**字**，
  // 越到后面越只能挑生僻搭配——英文里温和的值，放到中文就是破坏性的。
  // 要压重复请用 prompt 层（"换一种说法"），不要用 frequency_penalty。
  //
  // top_p 保留 0.95：配合 1.3 的温度温和收窄长尾，不做强截断。
  const body = { model, messages, temperature, stream: true, top_p: 0.95 }
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
