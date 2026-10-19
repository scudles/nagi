import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRendererHealthStore } from '../src/main/renderer-health-store.js'
import { attachRendererHealthStore, clearMaintenanceTrace, maintenanceHealth, maintenanceTrace, maintenanceRecover, reportCatch, CATCH_CLASS } from '../src/main/maintenance.js'
import { RENDERER_HEALTH_SITES } from '../src/shared/renderer-health-protocol.js'

const event = (id, site = 'main.monitorNoticeSave', action = 'fail') => ({ id, site, cls: RENDERER_HEALTH_SITES[site], action })

test('fixed ingress covers 18 audited failure positions via 17 distinct sites', () => {
  assert.equal(Object.keys(RENDERER_HEALTH_SITES).length, 17)
  assert.equal(Object.values(RENDERER_HEALTH_SITES).filter((cls) => cls === 'must-persist').length, 4)
  assert.equal(Object.values(RENDERER_HEALTH_SITES).filter((cls) => cls === 'promise').length, 5)
  assert.equal(Object.values(RENDERER_HEALTH_SITES).filter((cls) => cls === 'semantic').length, 2)
  assert.equal(Object.values(RENDERER_HEALTH_SITES).filter((cls) => cls === 'visible').length, 6)
})

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-renderer-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'renderer-health.json')
}

test('renderer failures merge into getHealth across windows, survive restart, and recover with history', (t) => {
  const file = tempFile(t)
  let clock = 100_000
  const store = createRendererHealthStore({ file, now: () => clock })
  attachRendererHealthStore(store)
  t.after(() => { attachRendererHealthStore(null); clearMaintenanceTrace() })
  assert.equal(store.report('pet', event('a', 'live2d.stopMotion')).ok, true)
  assert.equal(store.report('workbench', event('b')).ok, true)
  const health = maintenanceHealth()
  assert.equal(health.healthy, false)
  assert.equal(health.sites.length, 2)
  assert.ok(health.sites.some((s) => s.site === 'renderer:pet/live2d.stopMotion'))
  assert.ok(health.sites.some((s) => s.site === 'renderer:workbench/main.monitorNoticeSave'))
  assert.ok(maintenanceTrace(10).some((s) => s.site === 'renderer:pet/live2d.stopMotion'))

  const restarted = createRendererHealthStore({ file, now: () => clock })
  attachRendererHealthStore(restarted)
  assert.equal(maintenanceHealth().sites.length, 2)
  assert.equal(restarted.report('pet', event('a', 'live2d.stopMotion')).duplicate, true, 'idempotence survives restart')
  assert.equal(restarted.snapshot().find((s) => s.site === 'renderer:pet/live2d.stopMotion').count, 1)
  clock += 1000
  assert.equal(restarted.report('pet', event('c', 'live2d.stopMotion', 'recover')).ok, true)
  const recovered = maintenanceHealth().sites.find((s) => s.site === 'renderer:pet/live2d.stopMotion')
  assert.equal(recovered.lastClass, null)
  assert.equal(recovered.count, 1)
  assert.equal(recovered.recoveredAt, clock)
  assert.equal(maintenanceHealth().healthy, false, 'other window remains active')
  assert.equal(restarted.clear(), true)
  assert.equal(maintenanceHealth().sites.length, 0)
  assert.equal(createRendererHealthStore({ file }).snapshot().length, 0, 'clear also clears disk')
})

test('renderer payload remains fixed and bounded; event ID is idempotent and site rate is 60 s', (t) => {
  const file = tempFile(t)
  let clock = 100_000
  const store = createRendererHealthStore({ file, now: () => clock })
  const secret = 'C:\\private\\diary.txt user/model text'
  assert.throws(() => store.report('pet', { ...event('x'), message: secret }), /invalid/)
  assert.equal(store.report('pet', event('a')).ok, true)
  assert.equal(store.report('pet', event('a')).duplicate, true)
  assert.equal(store.report('pet', event('b')).deduped, true)
  assert.equal(store.snapshot()[0].count, 1)
  clock += 60_001
  assert.equal(store.report('pet', event('c')).ok, true)
  assert.equal(store.snapshot()[0].count, 2)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes('user/model text'), false, 'disk never stores Error.message content')
  assert.equal(text.includes('private'), false)
  assert.equal(store.snapshot()[0].lastAt, clock, 'main clock is authoritative')
})

test('write failure keeps the current-session state and reports through existing maintenance', (t) => {
  clearMaintenanceTrace()
  t.after(clearMaintenanceTrace)
  const file = tempFile(t)
  let fail = true
  const issues = []
  const io = { writeFileSync(...args) { if (fail) throw new Error('secret payload'); return writeFileSync(...args) } }
  const store = createRendererHealthStore({ file, io, onPersistFailure: (err) => {
    issues.push(err.message)
    reportCatch('rendererHealth.persist', CATCH_CLASS.MUST_PERSIST, err)
  }, onPersistRecovery: () => maintenanceRecover('rendererHealth.persist') })
  attachRendererHealthStore(store)
  t.after(() => attachRendererHealthStore(null))
  const result = store.report('diary', event('a', 'main.secretStatus'))
  assert.equal(result.ok, false)
  assert.equal(store.snapshot()[0].lastClass, 'visible')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].includes('secret'), false)
  assert.equal(maintenanceHealth().healthy, false)
  assert.ok(maintenanceHealth().sites.some((s) => s.site === 'rendererHealth.persist' && s.lastClass === 'must-persist'))
  assert.ok(maintenanceTrace(10).some((t) => t.site === 'rendererHealth.persist'))
  fail = false
  assert.equal(store.retryPersist(), true)
  const recovered = maintenanceHealth().sites.find((s) => s.site === 'rendererHealth.persist')
  assert.equal(recovered.lastClass, null)
  assert.ok(recovered.recoveredAt)
  assert.equal(createRendererHealthStore({ file }).snapshot().length, 1)
})

test('site and replay tables remain capped under repeated events', (t) => {
  const file = tempFile(t)
  let clock = 1_000_000
  const store = createRendererHealthStore({ file, now: () => clock })
  let i = 0
  for (const source of ['pet', 'workbench', 'diary']) {
    for (const site of Object.keys(RENDERER_HEALTH_SITES)) {
      store.report(source, event(`site_${i++}`, site))
      clock += 60_001
    }
  }
  assert.equal(store.snapshot().length, 50)
  for (let n = 0; n < 220; n++) { store.report('pet', event(`repeat_${n}`)); clock += 60_001 }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(data.sites.length <= 50)
  assert.ok(data.ids.length <= 200)
  assert.ok(data.trace.length <= 100)
})
