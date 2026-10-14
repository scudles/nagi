// test/registry-files.test.js
// 工具注册表与文件边界的纯逻辑单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { planHomeService } from '../src/core/tools/registry.js'
import { resolveWithin } from '../src/core/tools/files.js'
import { summarizeHaEvent } from '../src/core/homeassistant/ha.js'

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
