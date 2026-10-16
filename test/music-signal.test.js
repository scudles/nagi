import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MusicSignal } from '../src/core/signals/music-store.js'
import { normalizeMediaObservation, musicContext, pickActiveSession, selfSessionIds, isSelfSession, filterSelfSessions } from '../src/core/signals/music.js'

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

test('多会话选择：播放中优先，其次暂停；同级标题非空优先，再按更新时间', () => {
  const raw = { available: true, sessions: [
    { app: 'MSEdge', title: '视频', artist: '', playbackStatus: 'Paused', updatedAt: 100 },
    { app: 'Spotify', title: '', artist: '', playbackStatus: 'Playing', updatedAt: 200 },
    { app: 'cloudmusic', title: '约定', artist: '王菲', playbackStatus: 'Playing', updatedAt: 50 }
  ] }
  const obs = normalizeMediaObservation(raw, 1000)
  assert.equal(obs.playbackStatus, 'playing')
  assert.equal(obs.title, '约定')
  assert.equal(obs.artist, '王菲')
  assert.equal(obs.app, 'cloudmusic')
  assert.equal(obs.sessionCount, 3)
  // 没有 playing 时退到 paused（有标题的那条）
  const pausedFirst = normalizeMediaObservation({ available: true, sessions: [
    { app: 'a', title: '', playbackStatus: 'Paused' },
    { app: 'b', title: '旧视频', playbackStatus: 'Paused' }
  ] }, 1000)
  assert.equal(pausedFirst.playbackStatus, 'paused')
  assert.equal(pausedFirst.title, '旧视频')
})

test('上下文四态：播放中带护栏，暂停/停止/没有会话各有诚实措辞，超时与失败不编造', () => {
  const now = 1000
  const playing = normalizeMediaObservation({ available: true, sessions: [
    { app: 'Spotify', title: '歌', artist: '手', playbackStatus: 'Playing' }
  ] }, now)
  assert.match(musicContext(playing, now + 1000)[0], /正在播放/)
  assert.match(musicContext(playing, now + 1000)[0], /不能推断用户心情/)
  const paused = normalizeMediaObservation({ available: true, sessions: [
    { app: 'MSEdge', title: '视频', playbackStatus: 'Paused' }
  ] }, now)
  assert.match(musicContext(paused, now + 1000)[0], /已暂停/)
  const stopped = normalizeMediaObservation({ available: true, sessions: [
    { app: 'x', title: 'y', playbackStatus: 'Stopped' }
  ] }, now)
  assert.match(musicContext(stopped, now + 1000)[0], /已停止/)
  const none = normalizeMediaObservation({ available: false, reason: 'no-session' }, now)
  assert.match(musicContext(none, now + 1000)[0], /没在播放/)
  const failed = normalizeMediaObservation({ available: false, reason: 'error' }, now)
  assert.deepEqual(musicContext(failed, now + 1000), [])
  // 超过 120 秒的旧观测不再注入
  assert.deepEqual(musicContext(paused, now + 130000), [])
})

test('窗口标题兜底来源的观测：措辞注明来源与状态未知', () => {
  const obs = normalizeMediaObservation({ available: true, sessions: [
    { app: '网易云音乐', title: '约定', artist: '王菲', playbackStatus: 'unknown', source: 'window-title' }
  ] }, 1000)
  assert.equal(obs.source, 'window-title')
  const line = musicContext(obs, 1500)[0]
  assert.match(line, /播放状态未知/)
  assert.match(line, /播放器窗口标题/)
  assert.match(line, /不是系统媒体会话/)
})

test('自身媒体会话：凪说 TTS 时被 Chromium 注册的会话必须排除（否则会盖住真正在放歌的播放器）', () => {
  // 事故复现（2026-10-17）：SMTC 里出现 { app: 'electron.exe', title: '凪 Nagi', playbackStatus: 'playing' }
  // → probeMedia 见「有会话在 playing」直接早退，网易云那条窗口标题兜底永远轮不到。
  const ids = selfSessionIds({ execPath: 'E://凪//...//node_modules//electron//dist//electron.exe', productName: '凪 Nagi' })
  assert.ok(isSelfSession({ app: 'electron.exe' }, ids))
  assert.ok(isSelfSession({ app: 'ELECTRON.EXE' }, ids), '大小写不敏感')
  assert.ok(isSelfSession({ app: 'E://app//凪 Nagi.exe' }, ids), '打包态按可执行文件名匹配')
  assert.ok(isSelfSession({ app: '凪 Nagi' }, ids), '产品名也认')
  assert.ok(!isSelfSession({ app: 'cloudmusic' }, ids))
  assert.ok(!isSelfSession({ app: 'MSEdge' }, ids))
  assert.ok(!isSelfSession({ app: '' }, ids), '空 AUMID 不误伤')

  const kept = filterSelfSessions([
    { app: 'electron.exe', title: '凪 Nagi', playbackStatus: 'playing' },
    { app: 'cloudmusic', title: '约定', playbackStatus: 'unknown', source: 'window-title' }
  ], ids)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].app, 'cloudmusic')
  // 排掉自己之后，选择策略才会轮到真正的播放器
  assert.equal(pickActiveSession(kept).title, '约定')
  // 全被排掉时选择策略返回 null（调用方据此落到窗口标题兜底）
  assert.equal(pickActiveSession(filterSelfSessions([{ app: 'electron.exe' }], ids)), null)
})
