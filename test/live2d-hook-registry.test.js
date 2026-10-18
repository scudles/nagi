import test from 'node:test'
import assert from 'node:assert/strict'
import { checkFinalFrame, createFrameHookRegistry, live2dHookSpecs, orderHookSpecs } from '../src/core/face/hook-registry.js'

function fixture() {
  const listeners = new Set()
  const emitter = {
    on(event, fn) { assert.equal(event, 'beforeModelUpdate'); listeners.add(fn) },
    off(event, fn) { assert.equal(event, 'beforeModelUpdate'); listeners.delete(fn) },
    frame() { for (const fn of [...listeners]) fn() },
    count() { return listeners.size }
  }
  const ids = ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeBallX', 'ParamAngleX']
  const values = new Map(ids.map((id) => [id, 0]))
  const limits = ids.map((id) => id === 'ParamAngleX' ? [-30, 30] : id === 'ParamEyeBallX' ? [-1, 1] : [0, 1])
  const core = {
    _model: { parameters: { minimumValues: limits.map((v) => v[0]), maximumValues: limits.map((v) => v[1]) } },
    getParameterIndex(id) { return ids.indexOf(id) },
    getParameterValueById(id) { return values.get(id) },
    setParameterValueById(id, value) { values.set(id, value) },
    addParameterValueById(id, value) { values.set(id, values.get(id) + value) },
    multiplyParameterValueById(id, value) { values.set(id, values.get(id) * value) }
  }
  return { emitter, core }
}

test('B6: late emotion activation keeps fixed order and one listener per model', () => {
  const { emitter } = fixture()
  const registry = createFrameHookRegistry(emitter)
  const seen = []
  registry.add('autoBlink', () => seen.push('blink'))
  registry.add('depth', () => seen.push('depth'))
  registry.add('emotion', () => seen.push('emotion'))
  registry.add('turn', () => seen.push('turn'))
  assert.equal(emitter.count(), 1)
  emitter.frame()
  assert.deepEqual(seen, ['emotion', 'turn', 'depth', 'blink'])
  assert.throws(() => registry.add('emotion', () => {}), /duplicate hook/)
  registry.destroy()
  assert.equal(emitter.count(), 0)
  const next = createFrameHookRegistry(emitter)
  assert.equal(emitter.count(), 1, 'model reload gets one fresh dispatcher')
  next.destroy()
})

test('B6: emotion + speech + blink final values give speech mouth and multiplicative lids', () => {
  const { emitter, core } = fixture()
  const registry = createFrameHookRegistry(emitter)
  // Deliberately activate in reverse order: listener timing must not change ownership.
  registry.add('autoBlink', () => {
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) core.multiplyParameterValueById(id, 0.5)
  })
  registry.add('tremor', () => {
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) core.addParameterValueById(id, 0.1)
  })
  registry.add('viseme', () => core.setParameterValueById('ParamMouthForm', 0.6))
  registry.add('mouthOpen', () => core.setParameterValueById('ParamMouthOpenY', 0.8))
  registry.add('emotion', () => {
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) core.setParameterValueById(id, 0.7)
    core.setParameterValueById('ParamMouthOpenY', 0.2)
    core.setParameterValueById('ParamMouthForm', 0.1)
  })
  emitter.frame()
  const final = checkFinalFrame(core, ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm'])
  assert.equal(final.ok, true)
  assert.ok(Math.abs(final.values.ParamEyeLOpen - 0.4) < 1e-9)
  assert.ok(Math.abs(final.values.ParamEyeROpen - 0.4) < 1e-9)
  assert.equal(final.values.ParamMouthOpenY, 0.8)
  assert.equal(final.values.ParamMouthForm, 0.6)
  registry.destroy()
})

test('B6: thinking pose owns gaze; eye wandering yields before pose add', () => {
  const { emitter, core } = fixture()
  const registry = createFrameHookRegistry(emitter)
  let thinking = true
  registry.add('turn', () => core.setParameterValueById('ParamEyeBallX', 0.1))
  registry.add('eyeWander', () => { if (!thinking) core.setParameterValueById('ParamEyeBallX', -0.2) })
  registry.add('pose', () => core.addParameterValueById('ParamEyeBallX', 0.35))
  registry.add('idleHead', () => core.addParameterValueById('ParamEyeBallX', 0.05))
  emitter.frame()
  assert.ok(Math.abs(checkFinalFrame(core, ['ParamEyeBallX']).values.ParamEyeBallX - 0.5) < 1e-9)
  thinking = false
  emitter.frame()
  assert.ok(Math.abs(checkFinalFrame(core, ['ParamEyeBallX']).values.ParamEyeBallX - 0.2) < 1e-9)
  registry.destroy()
})

test('B6: turn set + crossfade head + depth add survive in final frame', () => {
  const { emitter, core } = fixture()
  const registry = createFrameHookRegistry(emitter)
  registry.add('depth', () => core.addParameterValueById('ParamAngleX', -3))
  registry.add('idleHead', () => core.addParameterValueById('ParamAngleX', 2 * (1 - 0.8)))
  registry.add('turn', () => core.setParameterValueById('ParamAngleX', 20))
  emitter.frame()
  assert.ok(Math.abs(checkFinalFrame(core, ['ParamAngleX']).values.ParamAngleX - 17.4) < 1e-9)
  assert.equal(checkFinalFrame(core, ['ParamAngleX']).ok, true)
  registry.destroy()
})

test('B9: tenfold wrong angle fails independent model range check', () => {
  const { emitter, core } = fixture()
  const registry = createFrameHookRegistry(emitter)
  registry.add('turn', () => core.setParameterValueById('ParamAngleX', 200))
  emitter.frame()
  const final = checkFinalFrame(core, ['ParamAngleX'])
  assert.equal(final.ok, false)
  assert.deepEqual(final.failures.map((f) => f.id), ['ParamAngleX'])
  registry.destroy()
})

test('B6: dependency cycle and unordered same-parameter setters fail assembly', () => {
  assert.throws(() => orderHookSpecs([
    { id: 'a', operation: 'set', writes: [], after: ['b'] },
    { id: 'b', operation: 'add', writes: [], after: ['a'] }
  ]), /cycle/)
  assert.throws(() => orderHookSpecs([
    { id: 'a', operation: 'set', writes: ['ParamAngleX'] },
    { id: 'b', operation: 'set', writes: ['ParamAngleX'] }
  ]), /unordered absolute writers/)
  const order = orderHookSpecs(live2dHookSpecs()).map((s) => s.id)
  assert.ok(order.indexOf('turn') < order.indexOf('depth'))
  assert.ok(order.indexOf('tremor') < order.indexOf('autoBlink'))
  assert.ok(order.indexOf('emotion') < order.indexOf('viseme'))
})
