// B6: one beforeModelUpdate listener per model; hook activation never changes frame order.
const PARAM = Object.freeze({
  angles: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'],
  eyes: ['ParamEyeBallX', 'ParamEyeBallY'],
  lids: ['ParamEyeLOpen', 'ParamEyeROpen'],
  mouth: ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm']
})

const sequence = [
  ['emotion', 'set', []], ['outfit', 'set', []], ['turn', 'set', [...PARAM.angles, ...PARAM.eyes]],
  ['eyeWander', 'set', PARAM.eyes], ['mouthOpen', 'set', PARAM.mouth],
  ['viseme', 'set', PARAM.mouth], ['blinkCover', 'set', PARAM.lids],
  ['rhythm', 'add', PARAM.angles], ['pose', 'add', [...PARAM.angles, ...PARAM.eyes]],
  ['headNudge', 'add', PARAM.angles], ['idleHead', 'add', [...PARAM.angles, ...PARAM.eyes]],
  ['tremor', 'add', PARAM.eyes], ['micro', 'add', []], ['ear', 'add', ['Param78', 'Param79']],
  ['depth', 'add', PARAM.angles], ['autoBlink', 'multiply', PARAM.lids],
  ['redGuard', 'set', []], ['angleProbe', 'set', PARAM.angles],
  ['idleFreeze', 'set', [...PARAM.angles, ...PARAM.lids]], ['frameGuard', 'observe', []]
]

export function live2dHookSpecs({ face = null, outfit = null, micro = null } = {}) {
  const faceIds = [...new Set(Object.values(face?.emotions || {}).flatMap((v) => Object.keys(v || {})))]
  const visemeIds = [...new Set(Object.values(face?.visemes || {}).flatMap((v) => Object.keys(v || {})))]
  const tremorIds = (face?.tremor?.channels || []).map((c) => c.param)
  const outfitIds = [
    ...Object.keys(outfit?.base || {}),
    ...(outfit?.slots || []).flatMap((s) => (s.options || []).flatMap((o) => Object.keys(o.params || {})))
  ]
  const microIds = (micro?.pool || []).flatMap((p) => Object.keys(p.params || {}))
  const dynamic = { emotion: faceIds, viseme: visemeIds, tremor: tremorIds, outfit: outfitIds, micro: microIds }
  return sequence.map(([id, operation, writes], index) => ({
    id, phase: id, operation, writes: [...new Set([...writes, ...(dynamic[id] || [])])],
    after: index ? [sequence[index - 1][0]] : [], before: []
  }))
}

/** Stable topological order. Same-parameter absolute writers require a declared path. */
export function orderHookSpecs(specs) {
  const byId = new Map()
  for (const spec of specs) {
    if (!spec?.id || byId.has(spec.id)) throw new Error(`duplicate hook id: ${spec?.id}`)
    if (!['set', 'add', 'multiply', 'observe'].includes(spec.operation)) throw new Error(`invalid hook operation: ${spec.id}`)
    byId.set(spec.id, spec)
  }
  const edges = new Map([...byId.keys()].map((id) => [id, new Set()]))
  for (const spec of specs) {
    for (const id of spec.after || []) {
      if (!byId.has(id)) throw new Error(`missing hook dependency: ${id}`)
      edges.get(id).add(spec.id)
    }
    for (const id of spec.before || []) {
      if (!byId.has(id)) throw new Error(`missing hook dependency: ${id}`)
      edges.get(spec.id).add(id)
    }
  }
  const ordered = []
  const remaining = new Set(byId.keys())
  while (remaining.size) {
    const ready = [...remaining].filter((id) => ![...edges].some(([from, to]) => remaining.has(from) && to.has(id))).sort()
    if (!ready.length) throw new Error('hook dependency cycle')
    const id = ready[0]
    ordered.push(byId.get(id))
    remaining.delete(id)
  }
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    return [...edges.get(from)].some((next) => reaches(next, target, seen))
  }
  for (let i = 0; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) {
    const a = specs[i], b = specs[j]
    if (a.operation !== 'set' || b.operation !== 'set') continue
    if (!(a.writes || []).some((id) => (b.writes || []).includes(id))) continue
    if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
      throw new Error(`unordered absolute writers: ${a.id}, ${b.id}`)
    }
  }
  return ordered
}

export function createFrameHookRegistry(emitter, specs = live2dHookSpecs()) {
  const order = orderHookSpecs(specs).map((s) => s.id)
  const known = new Set(order)
  const active = new Map()
  const observers = new Set()
  let disposed = false
  const run = () => {
    for (const id of order) active.get(id)?.()
    for (const fn of [...observers]) { observers.delete(fn); fn() }
  }
  emitter.on('beforeModelUpdate', run)
  return {
    add(id, fn) {
      if (disposed || !known.has(id) || typeof fn !== 'function') throw new Error(`unknown hook: ${id}`)
      if (active.has(id) && active.get(id) !== fn) throw new Error(`duplicate hook: ${id}`)
      active.set(id, fn)
    },
    remove(id, fn) { if (!fn || active.get(id) === fn) active.delete(id) },
    observeOnce(fn) {
      if (disposed) return () => {}
      observers.add(fn)
      return () => observers.delete(fn)
    },
    order: () => [...order],
    active: () => [...active.keys()],
    destroy() {
      if (disposed) return
      disposed = true
      emitter.off('beforeModelUpdate', run)
      active.clear()
      observers.clear()
    }
  }
}

/** Read the whole composed frame, against independent model limits. */
export function checkFinalFrame(core, ids) {
  const failures = []
  const values = {}
  const params = core?._model?.parameters
  for (const id of ids) {
    let index
    try { index = core.getParameterIndex(id) } catch { continue }
    if (index < 0) continue
    let value
    try { value = core.getParameterValueById(id) } catch { continue }
    const min = params?.minimumValues?.[index]
    const max = params?.maximumValues?.[index]
    values[id] = value
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || value < min - 1e-4 || value > max + 1e-4) {
      failures.push({ id, value, min, max })
    }
  }
  return { values, failures, ok: failures.length === 0 }
}
