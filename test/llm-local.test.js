// M6：本机 Ollama 必须无需云端 Key、只连 loopback，并沿用 Agent 的流式工具协议。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiKeyForLlm, isLocalLlm, resolveLlm, supportsNativeTools } from '../src/core/llm/providers.js'
import { checkOllama, modelInstalled, ollamaTagsUrl } from '../src/core/llm/ollama.js'
import { chatStream } from '../src/core/llm/openai-compatible.js'

test('Ollama 只能指向本机 /v1；本地通道不读取已保存的云端 Key', () => {
  for (const baseURL of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1/', 'http://[::1]:11434/v1']) {
    assert.match(ollamaTagsUrl(baseURL), /\/api\/tags$/)
  }
  for (const baseURL of ['https://ollama.com/v1', 'http://192.168.1.5:11434/v1', 'http://localhost:11434/api', 'http://user:pass@localhost:11434/v1']) {
    assert.equal(ollamaTagsUrl(baseURL), null)
  }
  const llm = resolveLlm({ provider: 'ollama' })
  assert.equal(isLocalLlm(llm), true)
  assert.equal(apiKeyForLlm(llm, 'saved-cloud-secret'), 'ollama')
  assert.equal(apiKeyForLlm({ provider: 'openai', baseURL: 'https://api.openai.com/v1' }, 'saved-cloud-secret'), 'saved-cloud-secret')
  assert.throws(() => apiKeyForLlm({ provider: 'ollama', baseURL: 'https://example.com/v1' }), /本机/)
  assert.equal(supportsNativeTools(llm), true)
})

test('本地探测区分服务不可达、未装模型、型号不匹配和就绪', async () => {
  const baseURL = 'http://localhost:11434/v1'
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://localhost:11434/api/tags')
    return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:latest' }, { name: 'qwen3:4b' }] }) }
  }
  assert.equal(modelInstalled('qwen2.5', ['qwen2.5:latest']), true)
  assert.equal(modelInstalled('qwen3:4b', ['qwen3:4b']), true)
  assert.equal(modelInstalled('gemma4:cloud', ['gemma4:cloud']), false)
  assert.equal((await checkOllama({ baseURL, model: 'qwen2.5', fetchImpl })).ok, true)
  const missing = await checkOllama({ baseURL, model: 'missing', fetchImpl })
  assert.equal(missing.reason, 'model-missing')
  assert.deepEqual(missing.models, ['qwen2.5:latest', 'qwen3:4b'])
  assert.equal((await checkOllama({ baseURL, model: 'qwen2.5', fetchImpl: async () => { throw new Error('down') } })).reason, 'offline')
  assert.equal((await checkOllama({ baseURL, model: 'qwen2.5', fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) })).reason, 'no-models')
  assert.equal((await checkOllama({ baseURL, model: 'gemma4:cloud', fetchImpl })).reason, 'cloud-model')
})

test('本地模型沿用流式工具事件格式，工具参数跨片合并', async () => {
  let request
  const client = {
    chat: { completions: { create: async (body) => {
      request = body
      return (async function* () {
        yield { choices: [{ delta: { content: '[calm] 我先看一下。' } }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_list', arguments: '{"path":' } }] } }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] }, finish_reason: 'tool_calls' }] }
      })()
    } } }
  }
  const events = []
  for await (const event of chatStream(client, {
    model: 'qwen2.5', messages: [{ role: 'user', content: '列出目录' }], tools: [{ type: 'function', function: { name: 'file_list' } }]
  })) events.push(event)
  assert.equal(request.stream, true)
  assert.equal(request.tools.length, 1)
  assert.equal(events[0].text, '[calm] 我先看一下。')
  assert.deepEqual(events[1].toolCalls, [{ id: 'call_1', name: 'file_list', arguments: '{"path":"."}' }])
  assert.equal(events[2].type, 'done')
})
