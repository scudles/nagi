import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CATCH_CLASS, clearRendererMaintenance, flushRendererHealth, mergeMaintenanceState, recoverRendererCatch, rendererMaintenanceState, reportRendererCatch } from '../src/renderer/js/catch-report.js'

function browser(t, reportRenderer) {
  const entries = new Map()
  globalThis.window = {
    location: { search: '?mode=workbench' },
    localStorage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value)
    },
    nagi: { maintenance: { reportRenderer } }
  }
  t.after(() => { clearRendererMaintenance(); delete globalThis.window })
  return entries
}

test('B8 renderer degrade records a trace without a red health state; failed save becomes queryable', async (t) => {
  browser(t, async () => ({ ok: true }))
  clearRendererMaintenance()
  const secret = 'user-file-C:\\private\\notes.txt'
  assert.equal(reportRendererCatch('test.optionalParameter', CATCH_CLASS.DEGRADE, new Error(secret), 1000), true)
  assert.equal(rendererMaintenanceState().healthy, true)
  assert.equal(rendererMaintenanceState().trace.length, 1)
  assert.equal(reportRendererCatch('test.optionalParameter', CATCH_CLASS.DEGRADE, new Error(secret), 1001), false)
  assert.equal(rendererMaintenanceState().trace.length, 1, 'frame-local failures are bounded')

  reportRendererCatch('test.save', CATCH_CLASS.MUST_PERSIST, new Error(secret), 1000)
  await flushRendererHealth()
  const local = rendererMaintenanceState()
  assert.equal(local.healthy, false)
  assert.equal(local.sites.find((s) => s.site === 'renderer.test.save')?.lastClass, CATCH_CLASS.MUST_PERSIST)
  assert.equal(JSON.stringify(local).includes(secret), false, 'maintenance state must not contain the failed payload')
  const combined = mergeMaintenanceState({ healthy: true, sites: [{ site: 'main.ok' }], trace: [] }, local)
  assert.equal(combined.healthy, false)
  assert.equal(combined.sites.length, 3)
  clearRendererMaintenance()
  assert.equal(rendererMaintenanceState().trace.length, 0)
  assert.equal(rendererMaintenanceState().healthy, true)
})

test('IPC outage keeps sanitized events locally and retries on refresh; recovery merges without double count', async (t) => {
  const sent = []
  const entries = browser(t, async () => { throw new Error('network secret') })
  clearRendererMaintenance()
  reportRendererCatch('main.monitorNoticeSave', CATCH_CLASS.MUST_PERSIST, new Error('C:\\secret\\user-text'), 100_000)
  assert.equal(await flushRendererHealth(), false)
  assert.ok(rendererMaintenanceState().sites.some((s) => s.site === 'renderer.healthTransport'))
  assert.equal(JSON.stringify([...entries]).includes('user-text'), false)
  assert.equal(JSON.parse(entries.get('nagi.rendererHealth.pending.v1:workbench')).length, 1)
  window.nagi.maintenance.reportRenderer = async () => ({ ok: false })
  assert.equal(await flushRendererHealth(), false, 'main accepted in memory but could not persist')
  assert.equal(JSON.parse(entries.get('nagi.rendererHealth.pending.v1:workbench')).length, 1)
  window.nagi.maintenance.reportRenderer = async (event) => { sent.push(event); return { ok: true } }
  assert.equal(await flushRendererHealth(), true)
  assert.equal(sent.length, 1)
  assert.deepEqual(Object.keys(sent[0]).sort(), ['action', 'cls', 'id', 'site'])
  const main = { healthy: false, sites: [{ site: 'renderer:workbench/main.monitorNoticeSave', count: 1, lastClass: 'must-persist', lastAt: Date.now() }], trace: [] }
  const merged = mergeMaintenanceState(main, rendererMaintenanceState(), 'workbench')
  assert.equal(merged.sites.filter((s) => s.site === 'renderer:workbench/main.monitorNoticeSave').length, 1)
  const clearedElsewhere = mergeMaintenanceState({ healthy: true, sites: [], trace: [] }, rendererMaintenanceState(), 'workbench')
  assert.equal(clearedElsewhere.sites.some((s) => s.site.includes('main.monitorNoticeSave')), false, 'a remote clear cannot resurrect acknowledged local state')
  recoverRendererCatch('main.monitorNoticeSave')
  await flushRendererHealth()
  assert.equal(sent.at(-1).action, 'recover')
  assert.equal(rendererMaintenanceState().sites.find((s) => s.site === 'renderer.main.monitorNoticeSave').lastClass, null)
})

test('retry queue has a cap and records observable overflow', async (t) => {
  const entries = browser(t, async () => { throw new Error('offline') })
  clearRendererMaintenance()
  const oldWarn = console.warn
  console.warn = () => {}
  t.after(() => { console.warn = oldWarn })
  for (let n = 0; n < 70; n++) reportRendererCatch('main.poke', CATCH_CLASS.VISIBLE, new Error('offline'), 200_000 + n * 60_001)
  await flushRendererHealth()
  assert.equal(JSON.parse(entries.get('nagi.rendererHealth.pending.v1:workbench')).length, 64)
  assert.ok(rendererMaintenanceState().sites.some((s) => s.site === 'renderer.healthQueueOverflow'))
})

test('startup loads an unacknowledged event and resends its original ID', async (t) => {
  const entries = browser(t, async () => { throw new Error('offline') })
  clearRendererMaintenance()
  reportRendererCatch('main.secretStatus', CATCH_CLASS.VISIBLE, new Error('sensitive token'), 900_000)
  await flushRendererHealth()
  const queued = JSON.parse(entries.get('nagi.rendererHealth.pending.v1:workbench'))[0]
  const fresh = await import('../src/renderer/js/catch-report.js?startup-replay-test')
  await new Promise((resolve) => setImmediate(resolve))
  const sent = []
  window.nagi.maintenance.reportRenderer = async (value) => { sent.push(value); return { ok: true } }
  assert.equal(await fresh.flushRendererHealth(), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, queued.id)
  assert.equal(JSON.parse(entries.get('nagi.rendererHealth.pending.v1:workbench')).length, 0)
})

function assertRequiredReports(source) {
  for (const site of ['main.clearHistory', 'main.monitorNoticeSave', 'main.maintenanceClear', 'main.poke', 'main.voicePreview']) {
    assert.ok(source.includes(`reportRendererCatch('${site}'`), `${site} failure must be reported`)
  }
  assert.match(source, /main\.clearHistory[\s\S]{0,180}return[\s\S]{0,160}messages/, 'failed clear must stop before success UI')
}

test('B9 sabotage: swallowing a required renderer failure turns the audit red', () => {
  const source = readFileSync(new URL('../src/renderer/js/main.js', import.meta.url), 'utf8')
  assertRequiredReports(source)
  const sabotaged = source.replace("reportRendererCatch('main.clearHistory'", "discardedFailure('main.clearHistory'")
  assert.notEqual(sabotaged, source)
  assert.throws(() => assertRequiredReports(sabotaged), /main\.clearHistory failure must be reported/)
})

test('B9 sabotage: replacing the IPC send with a swallowed success turns the channel audit red', () => {
  const source = readFileSync(new URL('../src/renderer/js/catch-report.js', import.meta.url), 'utf8')
  const required = /const result = await send\(pending\[0\]\)/
  assert.match(source, required)
  const sabotaged = source.replace('await send(pending[0])', 'await Promise.resolve({ ok: true })')
  assert.notEqual(sabotaged, source)
  assert.doesNotMatch(sabotaged, required)
})
