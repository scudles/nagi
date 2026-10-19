import test, { mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, AGENT_EVENT } from '../src/shared/protocol.js'

const userData = mkdtempSync(join(tmpdir(), 'nagi-hint-turn-'))
let settings = structuredClone(DEFAULT_SETTINGS)
let responses = []
let calls = []
let onCall = null

const app = {
  getPath: (kind) => kind === 'userData' ? userData : userData,
  getAppPath: () => process.cwd(),
  isReady: () => true,
  whenReady: async () => {},
  on: () => {}, quit: () => {}
}
const noOp = () => {}
mock.module('electron', { exports: {
  app, ipcMain: { handle: noOp, on: noOp, removeHandler: noOp },
  Notification: class { show() {} },
  BrowserWindow: class { static getAllWindows() { return [] } },
  dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
  clipboard: { readText: () => '' },
  nativeImage: { createFromPath: () => null },
  globalShortcut: { register: () => false, unregisterAll: noOp },
  powerMonitor: { on: noOp },
  session: { defaultSession: {} },
  desktopCapturer: { getSources: async () => [] },
  Menu: class {}, Tray: class {}, nativeTheme: { on: noOp }, systemPreferences: {}
} })
mock.module('../src/main/settings-store.js', { exports: {
  getSettings: () => settings,
  loadSettings: () => settings,
  saveSettings: (patch) => { settings = { ...settings, ...patch }; return settings },
  settingsPath: () => join(userData, 'settings.json')
} })
mock.module('../src/main/keystore.js', { exports: {
  getSecret: () => 'test-key', hasSecret: () => true,
  setSecret: noOp, deleteSecret: noOp, secretStatus: () => ({})
} })
mock.module('../src/core/llm/openai-compatible.js', { exports: {
  createClient: () => ({}),
  chat: async () => ({ choices: [{ message: { content: '' } }] }),
  chatStream: async ({}, args) => {
    calls.push({ messages: structuredClone(args.messages), tools: args.tools })
    onCall?.(calls.length)
    const next = responses.shift() || []
    const { events, wait } = Array.isArray(next) ? { events: next } : next
    return (async function* () {
      if (wait) await wait
      for (const event of events) yield event
    })()
  }
} })

const { runTurn, intentState, disposeAgent } = await import('../src/main/agent.js')
const { flushPersist } = await import('../src/main/persist.js')
after(async () => {
  await disposeAgent()
  flushPersist()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
})

const answer = (text) => [{ type: 'delta', text }, { type: 'done' }]
const historyText = () => {
  flushPersist()
  const file = join(userData, 'history.json')
  assert.ok(existsSync(file), 'runTurn must persist the accepted final answer')
  return readFileSync(file, 'utf8')
}
function selectProvider(provider) {
  settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    llm: { provider, model: 'test', baseURL: 'http://localhost/v1' },
    presence: { enabled: false }
  }
  calls = []
  onCall = null
}
for (const provider of ['openai', 'custom']) {
  test(`D2-WIRE-BEHAV-${provider}: real runTurn ${provider === 'openai' ? 'native' : 'JSON'} rejects candidate before UI/history/disk`, async () => {
    selectProvider(provider)
    responses = [answer('[calm|solve]嗯。'), answer('[calm|listen]先检查配置，再按错误位置修复。')]
    const events = []
    const result = await runTurn('嗯', (event) => events.push(event), `hint-${provider}`)
    const visible = events.filter((event) => event.type === AGENT_EVENT.TEXT_DELTA).map((event) => event.text).join('')
    assert.equal(calls.length, 2, 'candidate mismatch gets exactly one same-turn rewrite')
    assert.equal(Boolean(calls[0].tools), provider === 'openai', 'exercise the requested provider branch')
    assert.equal(result.text, '先检查配置，再按错误位置修复。')
    assert.equal(visible, result.text, 'unreviewed candidate must never reach UI events')
    assert.equal(intentState().kind, 'solve')
    assert.doesNotMatch(JSON.stringify(events), /\[calm\|(?:solve|listen)\]|嗯。/)
    assert.doesNotMatch(historyText(), /\[calm\|(?:solve|listen)\]|嗯。/)
  })
}

test('D2-WIRE-BEHAV-OVERLAP: next user turn begins with null hint while prior model stream is pending', async () => {
  selectProvider('openai')
  let releaseFirst
  const wait = new Promise((resolve) => { releaseFirst = resolve })
  let reachedFirst
  const firstStarted = new Promise((resolve) => { reachedFirst = resolve })
  onCall = (count) => { if (count === 1) reachedFirst() }
  responses = [
    { wait, events: answer('[calm|solve]先检查配置。') },
    answer('[calm]好。')
  ]
  const first = runTurn('嗯', () => {}, 'hint-overlap-first')
  await firstStarted
  const secondEvents = []
  const second = await runTurn('哦', (event) => secondEvents.push(event), 'hint-overlap-second')
  assert.equal(second.text, '好。')
  assert.equal(calls.length, 2)
  assert.match(calls[1].messages[0].content, /【本轮怎么回应】本轮只做简短确认/)
  assert.doesNotMatch(calls[1].messages[0].content, /【本轮表达意图复核】/)
  assert.equal(intentState().kind, 'brief-ack')
  releaseFirst()
  await first
  assert.equal(intentState().kind, 'brief-ack', 'late old turn cannot overwrite the newer intent')
  assert.doesNotMatch(JSON.stringify(secondEvents), /\[calm\|solve\]/)
})
