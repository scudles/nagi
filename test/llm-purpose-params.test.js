// test/llm-purpose-params.test.js
// D2「按模型/用途存参数」：purposeParams 只覆盖参数，不改通道语义。
//
// 关键不变量（这也是"收口"前必须钉住的）：
//   1) **没配置时行为与加这个字段之前完全一致**——日记仍是 0.9、主对话仍是 1.3；
//   2) 非法值（>2 / <0 / 字符串）一律忽略，不静默改成怪值；
//   3) 不改入参 cfg（返回新对象），否则设置对象会被后续调用污染；
//   4) 用途覆盖只影响该用途，不串到别的用途。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LLM_PURPOSE_LABELS, LLM_PURPOSES, resolveLlm } from '../src/core/llm/providers.js'

const base = { provider: 'deepseek', model: 'deepseek-chat', temperature: 1.3 }

test('没配置 purposeParams：主对话 1.3、日记缺省 0.9，与改造前一致', () => {
  assert.equal(resolveLlm(base, 'chat').temperature, 1.3)
  assert.equal(resolveLlm(base, 'diary', { defaultTemperature: 0.9 }).temperature, 0.9)
  // 不传 purpose 等价于 chat
  assert.equal(resolveLlm(base).temperature, 1.3)
})

test('按用途覆盖温度：只影响该用途', () => {
  const cfg = { ...base, purposeParams: { diary: { temperature: 1.0 } } }
  assert.equal(resolveLlm(cfg, 'diary', { defaultTemperature: 0.9 }).temperature, 1.0)
  assert.equal(resolveLlm(cfg, 'chat').temperature, 1.3, '不能串到主对话')
  assert.equal(resolveLlm(cfg, 'proactive', { defaultTemperature: 0.9 }).temperature, 0.9)
})

test('非法温度被忽略（不静默改成怪值）', () => {
  for (const bad of [3, -1, 2.5, '1.0', null, NaN]) {
    const cfg = { ...base, purposeParams: { diary: { temperature: bad } } }
    assert.equal(resolveLlm(cfg, 'diary', { defaultTemperature: 0.9 }).temperature, 0.9, String(bad))
  }
  // 边界值 0 / 2 合法
  assert.equal(resolveLlm({ ...base, purposeParams: { diary: { temperature: 0 } } }, 'diary').temperature, 0)
  assert.equal(resolveLlm({ ...base, purposeParams: { diary: { temperature: 2 } } }, 'diary').temperature, 2)
})

test('按用途覆盖模型：trim 后生效，空串忽略', () => {
  const cfg = { ...base, purposeParams: { extract: { model: '  deepseek-reasoner  ' } } }
  assert.equal(resolveLlm(cfg, 'extract').model, 'deepseek-reasoner')
  const empty = { ...base, purposeParams: { extract: { model: '   ' } } }
  assert.equal(resolveLlm(empty, 'extract').model, 'deepseek-chat')
})

test('按用途覆盖 baseURL：去掉尾部斜杠', () => {
  const cfg = { ...base, purposeParams: { chat: { baseURL: 'https://example.com/v1///' } } }
  assert.equal(resolveLlm(cfg, 'chat').baseURL, 'https://example.com/v1')
})

test('不改入参：返回新对象，原 cfg 保持原样', () => {
  const cfg = { ...base, purposeParams: { diary: { temperature: 1.0 } } }
  const snapshot = JSON.stringify(cfg)
  const out = resolveLlm(cfg, 'diary', { defaultTemperature: 0.9 })
  assert.notEqual(out, cfg)
  assert.equal(JSON.stringify(cfg), snapshot)
})

test('用途枚举与标签齐全（设置页/文档引用它们）', () => {
  assert.deepEqual([...LLM_PURPOSES], ['chat', 'diary', 'proactive', 'extract'])
  for (const p of LLM_PURPOSES) assert.ok(LLM_PURPOSE_LABELS[p], p)
})
