// test/registry-files.test.js
// 工具注册表与文件边界的纯逻辑单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { planHomeService, TOOL_SCHEMAS, createToolRunner } from '../src/core/tools/registry.js'
import { resolveWithin } from '../src/core/tools/files.js'
import { summarizeHaEvent } from '../src/core/homeassistant/ha.js'
import { getToolRisk } from '../src/core/safety/policy.js'
import { RISK } from '../src/shared/protocol.js'
import { describeToolCall } from '../src/core/agent/loop.js'

/* ---------------- home_set → HA 服务 ---------------- */
test('home_set：开关灯', () => {
  assert.deepEqual(planHomeService({ entity_id: 'light.bedroom', state: 'on' }), {
    domain: 'light',
    service: 'turn_on',
    data: { entity_id: 'light.bedroom' }
  })
  assert.equal(planHomeService({ entity_id: 'switch.tv', state: 'off' }).service, 'turn_off')
})

test('home_set：亮度与温度', () => {
  const r = planHomeService({ entity_id: 'light.x', brightness_pct: 120 })
  assert.equal(r.data.brightness_pct, 100) // 越界收敛
  const c = planHomeService({ entity_id: 'climate.ac', temperature: 26 })
  assert.equal(c.service, 'set_temperature')
  assert.equal(c.data.temperature, 26)
})

test('home_set：场景与兜底 toggle', () => {
  assert.equal(planHomeService({ entity_id: 'scene.movie' }).domain, 'scene')
  assert.equal(planHomeService({ entity_id: 'fan.x' }).service, 'toggle')
})

/* ---------------- 文件路径边界 ---------------- */
test('resolveWithin：放行目录内路径，拦截越权', () => {
  const root = 'E:/授权目录'
  assert.ok(resolveWithin(root, 'a/b.txt').toLowerCase().includes('授权目录'))
  // ../ 试图逃出根目录 → 抛错
  assert.throws(() => resolveWithin(root, '../其他'), /越界|授权/)
  assert.throws(() => resolveWithin(root, 'C:/Windows/System32/config'), /越界|授权/)
  assert.throws(() => resolveWithin('', 'x'), /fileRoot|授权/)
})

test('resolveWithin：绝对路径在根内也放行', () => {
  const root = 'E:/授权目录'
  const p = resolveWithin(root, 'E:/授权目录/子/文件.txt')
  assert.ok(p.includes('子'))
})

/* ---------------- HA 事件摘要 ---------------- */
test('summarizeHaEvent：只挑值得说的事', () => {
  assert.equal(
    summarizeHaEvent({ event_type: 'state_changed', data: { entity_id: 'light.lamp', new_state: { state: 'on', attributes: { friendly_name: '台灯' } }, old_state: { state: 'off' } } }),
    '台灯 已打开'
  )
  assert.equal(
    summarizeHaEvent({ event_type: 'state_changed', data: { entity_id: 'sensor.temp', new_state: { state: '26', attributes: { friendly_name: '温度', unit_of_measurement: '°C' } }, old_state: { state: '25' } } }),
    '温度：26°C'
  )
  // 状态没变 → null
  assert.equal(
    summarizeHaEvent({ event_type: 'state_changed', data: { entity_id: 'light.x', new_state: { state: 'on', attributes: {} }, old_state: { state: 'on' } } }),
    null
  )
  // 非状态事件 → null
  assert.equal(summarizeHaEvent({ event_type: 'zha_event', data: {} }), null)
})

/* ---------------- 日程提醒工具接线（M4） ---------------- */

test('工具表含日程提醒三件套，且风险为 low', () => {
  const names = TOOL_SCHEMAS.map((s) => s.function.name)
  for (const n of ['reminder_add', 'reminder_list', 'reminder_cancel']) {
    assert.ok(names.includes(n), `工具表缺 ${n}`)
    assert.equal(getToolRisk(n), RISK.LOW, `${n} 的风险等级仍为 low`)
  }
  // schema 必填字段：add 至少要 text
  const add = TOOL_SCHEMAS.find((s) => s.function.name === 'reminder_add')
  assert.deepEqual(add.function.parameters.required, ['text'])
})

test('describeToolCall：提醒类工具给人话', () => {
  assert.ok(describeToolCall('reminder_add', { text: '开会', when: '10分钟后' }).includes('开会'))
  assert.ok(describeToolCall('reminder_cancel', { text: '开会' }).includes('开会'))
})

test('createToolRunner：把 reminder_* 派发给注入的 deps.reminders', async () => {
  const calls = []
  const run = createToolRunner({
    files: {},
    system: {},
    browser: {},
    native: {},
    reminders: {
      add: async (a) => (calls.push(['add', a]), { ok: true, summary: 'ok' }),
      list: async () => (calls.push(['list']), { ok: true, summary: 'ok' }),
      cancel: async (a) => (calls.push(['cancel', a]), { ok: true, summary: 'ok' })
    }
  })
  await run('reminder_add', { text: '喝水', when: '10分钟后' })
  await run('reminder_list', {})
  await run('reminder_cancel', { text: '喝水' })
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'list', 'cancel'])
  assert.equal(calls[0][1].text, '喝水')
})

test('createToolRunner：没有 reminders 依赖时按未知工具处理', async () => {
  const run = createToolRunner({ files: {}, system: {}, browser: {}, native: {} })
  const r = await run('reminder_add', { text: 'x', when: '10分钟后' })
  assert.equal(r.ok, false)
})
