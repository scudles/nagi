import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HaConsent, mayControlHa } from '../src/core/signals/ha-consent.js'
import { HAClient } from '../src/core/homeassistant/ha.js'

test('HA 只读与控制分两次授权，撤销后重启不复活', () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-ha-consent-test-'))
  try {
    const first = new HaConsent(dir)
    assert.deepEqual(first.status(), { readAt: null, controlAt: null })
    assert.throws(() => first.allowControl(), /先授权只读/)
    first.allowRead(100)
    assert.deepEqual(new HaConsent(dir).status(), { readAt: 100, controlAt: null })
    first.allowControl(200)
    assert.deepEqual(new HaConsent(dir).status(), { readAt: 100, controlAt: 200 })
    assert.equal(mayControlHa(first.status()), true)
    assert.equal(mayControlHa(first.status(), true), false)
    first.revokeControl()
    assert.equal(mayControlHa(first.status()), false)
    assert.deepEqual(new HaConsent(dir).status(), { readAt: 100, controlAt: null })
    first.revokeAll()
    assert.deepEqual(new HaConsent(dir).status(), { readAt: null, controlAt: null })
    mkdirSync(join(dir, 'signals'), { recursive: true })
    writeFileSync(first.file, '{broken')
    assert.deepEqual(new HaConsent(dir).status(), { readAt: null, controlAt: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('HA 勿扰或撤销后不会被旧重连定时器重新订阅', () => {
  const client = new HAClient({ baseURL: 'http://127.0.0.1:1', token: 'fixture' })
  client.eventsEnabled = true
  client.scheduleReconnect()
  assert.ok(client.wsTimer)
  client.stopEvents()
  assert.equal(client.wsTimer, null)
  client.scheduleReconnect()
  assert.equal(client.wsTimer, null)
})
