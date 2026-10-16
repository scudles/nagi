import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MusicSignal } from '../src/core/signals/music-store.js'

test('音乐信号默认不读取；授权、勿扰和撤销各自生效', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-music-test-'))
  let calls = 0
  let dnd = false
  try {
    const signal = new MusicSignal(dir, {
      probe: async () => { calls++; return { available: true, title: '测试歌曲', artist: '测试歌手',
        app: 'test-player', playbackStatus: 'Playing' } },
      doNotDisturb: () => dnd
    })
    assert.equal((await signal.status({ refresh: true })).authorized, false)
    assert.equal(calls, 0)
    signal.authorize(100)
    const active = await signal.status({ refresh: true, now: 200 })
    assert.equal(active.observation.playbackStatus, 'playing')
    assert.equal(calls, 1)
    assert.match(signal.context(200)[0], /不能推断用户心情/)
    dnd = true
    assert.equal((await signal.status({ refresh: true, now: 300 })).paused, 'do-not-disturb')
    assert.equal(calls, 1)
    assert.deepEqual(signal.context(300), [])
    dnd = false
    signal.revoke()
    assert.equal((await signal.status({ refresh: true })).authorized, false)
    assert.equal(calls, 1)
    assert.deepEqual(signal.context(300), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('撤销发生在异步媒体读取中时，旧结果不能重新进入上下文', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-music-test-'))
  let finish
  try {
    const signal = new MusicSignal(dir, { probe: () => new Promise((resolve) => { finish = resolve }) })
    signal.authorize()
    const pending = signal.status({ refresh: true, now: 100 })
    await new Promise((resolve) => setImmediate(resolve))
    signal.revoke()
    finish({ available: true, title: '撤销前歌曲', playbackStatus: 'Playing' })
    assert.equal((await pending).authorized, false)
    assert.deepEqual(signal.context(101), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
