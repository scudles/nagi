import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractActions, formatToolResult } from '../src/core/agent/json-protocol.js'

test('解析 fenced json 工具调用', () => {
  const text = '好的，我来查一下。\n```json\n{"action":"web_search","args":{"query":"今晚天气"}}\n```'
  const { actions, cleanedText } = extractActions(text)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].name, 'web_search')
  assert.deepEqual(actions[0].args, { query: '今晚天气' })
  assert.match(cleanedText, /好的，我来查一下。/)
  assert.doesNotMatch(cleanedText, /web_search/)
})

test('解析裸 JSON', () => {
  const text = '{"action":"file_list","args":{"dir":"C:/tmp"}}'
  const { actions } = extractActions(text)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].name, 'file_list')
})

test('兼容 tool / arguments 别名', () => {
  const text = '```json\n{"tool":"run_command","arguments":{"command":"dir"}}\n```'
  const { actions } = extractActions(text)
  assert.equal(actions[0].name, 'run_command')
  assert.equal(actions[0].args.command, 'dir')
})

test('普通回复不误判', () => {
  const { actions, cleanedText } = extractActions('今天天气不错，不过我不想出门。')
  assert.equal(actions.length, 0)
  assert.equal(cleanedText, '今天天气不错，不过我不想出门。')
})

test('非工具 JSON 不误判', () => {
  const { actions } = extractActions('这里是配置：\n```json\n{"a":1,"b":2}\n```')
  assert.equal(actions.length, 0)
})

test('formatToolResult 成功/失败', () => {
  assert.match(formatToolResult('web_search', { ok: true, summary: '找到 3 条' }), /成功[\s\S]*找到 3 条/)
  assert.match(formatToolResult('run_command', { ok: false, summary: '权限不足' }), /失败[\s\S]*权限不足/)
})
