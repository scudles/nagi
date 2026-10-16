import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-companion-test-'))
mock.module('electron', { exports: { app: { getPath: () => userData } } })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  privacy: { doNotDisturb: false, onlyPresence: false },
  companion: { maxDaily: 2, minGapMinutes: 30 }
}))

test('打扰预算落盘，重新装载后仍按同一天次数和间隔拦截', async (t) => {
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  const first = await import('../src/main/companion.js?first')
  first.companionDelivered()
  first.companionIgnored()
  const disk = JSON.parse(readFileSync(join(userData, 'companion.json'), 'utf8'))
  assert.equal(disk.deliveredToday, 1)
  assert.equal(disk.ignoredStreak, 1)
  const restarted = await import('../src/main/companion.js?restarted')
  const status = restarted.companionStatus()
  assert.equal(status.state.deliveredToday, 1)
  assert.equal(status.state.ignoredStreak, 1)
  assert.equal(status.reason, 'backoff')
  assert.equal(status.config.maxDaily, 2)
})
