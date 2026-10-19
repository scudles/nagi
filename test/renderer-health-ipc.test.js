import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'nagi-health-ipc-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
const channels = new Map()
const windows = new Map()
const pet = { isDestroyed: () => false }
const workbench = { isDestroyed: () => false }
const diary = { isDestroyed: () => false }
const entry = pathToFileURL(join(dir, 'index.html')).toString()
let exposed = null
mock.module('electron', { exports: {
  app: { getPath: () => dir },
  ipcMain: { handle: (channel, fn) => channels.set(channel, fn) },
  ipcRenderer: { invoke: async (channel, payload) => ({ channel, payload }) },
  contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } }
} })
mock.module('../src/main/windows.js', { exports: {
  findWindowByWebContents: (sender) => windows.get(sender) || null,
  rendererEntryUrl: () => entry,
  getPetWindow: () => pet,
  getWorkbenchWindow: () => workbench
} })

const { registerRendererHealthIpc } = await import('../src/main/ipc/renderer-health.js')
const { registerMaintenanceIpc } = await import('../src/main/ipc/maintenance.js')
const { RENDERER_HEALTH_IPC } = await import('../src/shared/renderer-health-protocol.js')

function source(win, url = entry) {
  const frame = { url }
  const sender = { mainFrame: frame }
  windows.set(sender, win)
  return { sender, senderFrame: frame }
}
const payload = (id, site = 'main.secretStatus', cls = 'visible', action = 'fail') => ({ id, site, cls, action })

test('trusted IPC identifies all three windows, aggregates into existing health, and clears disk', () => {
  registerRendererHealthIpc()
  registerMaintenanceIpc()
  assert.ok(channels.has(RENDERER_HEALTH_IPC))
  const report = channels.get(RENDERER_HEALTH_IPC)
  assert.equal(report(source(pet), payload('a', 'live2d.stopMotion', 'semantic')).ok, true)
  assert.equal(report(source(workbench), payload('b')).ok, true)
  assert.equal(report(source(diary), payload('c', 'main.monitorNoticeSave', 'must-persist')).ok, true)
  const health = channels.get('maintenance:health')(source(workbench))
  assert.equal(health.healthy, false)
  assert.ok(health.sites.some((s) => s.site === 'renderer:pet/live2d.stopMotion'))
  assert.ok(health.sites.some((s) => s.site === 'renderer:diary/main.monitorNoticeSave'))
  assert.ok(health.sites.some((s) => s.site === 'renderer:workbench/main.secretStatus'))
  assert.equal(channels.get('maintenance:clear')(source(workbench)).ok, true)
  assert.equal(channels.get('maintenance:health')(source(pet)).sites.length, 0)
  assert.equal(JSON.parse(readFileSync(join(dir, 'renderer-health.json'), 'utf8')).sites.length, 0)
})

test('invalid frame, unregistered window, site, class, or extra text/path fields are rejected', () => {
  const report = channels.get(RENDERER_HEALTH_IPC)
  const valid = source(pet)
  assert.throws(() => report({ ...valid, senderFrame: { url: entry } }, payload('d')), /未授权|rejected/)
  assert.throws(() => report(source(pet, 'https://evil.example/'), payload('d')), /未授权|rejected/)
  assert.throws(() => report(source(null), payload('d')), /未授权|rejected/)
  assert.throws(() => report(valid, payload('d', 'live2d.poseRelease')), /rejected/)
  assert.throws(() => report(valid, payload('d', 'main.secretStatus', 'degrade')), /rejected/)
  for (const extra of [
    { message: 'user/model text' }, { path: 'C:\\private\\file' },
    { payload: { secret: 1 } }, { windowId: 'workbench' }, { at: 123 }
  ]) assert.throws(() => report(valid, { ...payload('d'), ...extra }), /rejected/)
  assert.throws(() => report(valid, payload('x'.repeat(65))), /rejected/)
})

test('preload exposes exactly one fixed renderer health write method', async () => {
  await import('../src/preload/index.js')
  assert.deepEqual(Object.keys(exposed.maintenance).sort(), ['clear', 'health', 'reportRenderer'])
  const result = await exposed.maintenance.reportRenderer(payload('safe'))
  assert.equal(result.channel, RENDERER_HEALTH_IPC)
  assert.deepEqual(result.payload, payload('safe'))
  assert.equal('ipcRenderer' in exposed, false)
})
