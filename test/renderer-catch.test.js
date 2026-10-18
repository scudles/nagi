import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CATCH_CLASS, clearRendererMaintenance, mergeMaintenanceState, rendererMaintenanceState, reportRendererCatch } from '../src/renderer/js/catch-report.js'

test('B8 renderer degrade records a trace without a red health state; failed save becomes queryable', () => {
  clearRendererMaintenance()
  const secret = 'user-file-C:\\private\\notes.txt'
  assert.equal(reportRendererCatch('test.optionalParameter', CATCH_CLASS.DEGRADE, new Error(secret), 1000), true)
  assert.equal(rendererMaintenanceState().healthy, true)
  assert.equal(rendererMaintenanceState().trace.length, 1)
  assert.equal(reportRendererCatch('test.optionalParameter', CATCH_CLASS.DEGRADE, new Error(secret), 1001), false)
  assert.equal(rendererMaintenanceState().trace.length, 1, 'frame-local failures are bounded')

  reportRendererCatch('test.save', CATCH_CLASS.MUST_PERSIST, new Error(secret), 1000)
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
