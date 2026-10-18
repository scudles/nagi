import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicSignal } from '../src/core/signals/music-store.js'
import { createMemoryDocumentIo } from '../src/core/store/document-io.js'
import { normalizeMediaObservation, musicContext, pickActiveSession, selfSessionIds, isSelfSession, filterSelfSessions } from '../src/core/signals/music.js'
import { buildFallbackObservation, mergeMediaObservations } from '../src/core/signals/players.js'

test('音乐信号默认不读取；授权、勿扰和撤销各自生效', async () => {
  let calls = 0
  let dnd = false
  const signal = new MusicSignal({
    io: createMemoryDocumentIo(),
    now: () => 1000, // B7（P2-05）：时钟注入
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
})

test('撤销发生在异步媒体读取中时，旧结果不能重新进入上下文', async () => {
  let finish
  const signal = new MusicSignal({
    io: createMemoryDocumentIo(),
    now: () => 1000,
    probe: () => new Promise((resolve) => { finish = resolve })
  })
  signal.authorize()
  const pending = signal.status({ refresh: true, now: 100 })
  await new Promise((resolve) => setImmediate(resolve))
  signal.revoke()
  finish({ available: true, title: '撤销前歌曲', playbackStatus: 'Playing' })
  assert.equal((await pending).authorized, false)
  assert.deepEqual(signal.context(101), [])
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

test('窗口标题兜底来源：必须挡住「正在播放」的越界断言（2026-10-18 她凭它胡说「播放器还开着呢」）', () => {
  const obs = normalizeMediaObservation({ available: true, sessions: [
    { app: '网易云音乐', title: '约定', artist: '王菲', playbackStatus: 'unknown', source: 'window-title' }
  ] }, 1000)
  assert.equal(obs.source, 'window-title')
  const line = musicContext(obs, 1500)[0]
  assert.match(line, /播放器窗口里显示着/)
  assert.match(line, /无法判断是正在播放还是已暂停/, '不能把「窗口标题存在」当成「正在播放」')
  assert.match(line, /得问他/, '要引导她去问，而不是自己猜')
  // 反向断言：绝不能出现断言式措辞
  assert.doesNotMatch(line, /正在播放「/, '兜底来源不得冒充播放状态')
  assert.doesNotMatch(line, /还开着呢/, '不得推断播放器仍在播放')
})

test('缓存新鲜度：fresh() 与 status() 复用阈值一致（60 秒）', async () => {
  let calls = 0
  const signal = new MusicSignal({
    io: createMemoryDocumentIo(),
    now: () => 1000,
    probe: async () => { calls++; return { available: true, sessions: [
      { app: 'cloudmusic', title: '约定', artist: '王菲', playbackStatus: 'unknown', source: 'window-title' }
    ] } }
  })
  signal.authorize(1) // authorizedAt 必须 > 0 才算已授权（authorize(0) 会被 authorized() 判为未授权）
  assert.equal(signal.fresh(0), false, '没探过之前不算新鲜')
  await signal.status({ refresh: true, now: 1010 })
  assert.equal(signal.fresh(1010), true)
  assert.equal(signal.fresh(1010 + 59999), true, '60 秒内视为新鲜')
  assert.equal(signal.fresh(1010 + 60001), false, '超过 60 秒必须重新探')
  assert.equal(calls, 1)
})

test('用户实测场景：SMTC 只有一条 Edge 暂停会话，网易云靠窗口标题兜底仍要知道在放什么', () => {
  // 2026-10-18 真实探针输出（脱敏）：SMTC 里只有 MSEdge 的 Paused，cloudmusic 根本没注册会话。
  const smtcRaw = { available: true, sessions: [
    { app: 'MSEdge', title: '某某游戏杂谈', artist: '', playbackStatus: 'Paused', updatedAt: 0 }
  ] }
  const titleRaw = { available: true, windows: [
    { process: 'cloudmusic', title: 'fake ur face - s0rrow' },
    { process: 'msedge', title: '某某游戏杂谈 和另外 10 个页面' }
  ] }
  const fallbackObs = buildFallbackObservation(titleRaw.windows, 5000)
  const merged = mergeMediaObservations(smtcRaw, fallbackObs)
  const obs = normalizeMediaObservation(merged, 5000)
  assert.equal(obs.available, true, '不能因为 SMTC 只有暂停就说「没在播放」')
  assert.equal(obs.app, '网易云音乐')
  assert.equal(obs.title, 'fake ur face')
  assert.equal(obs.artist, 's0rrow')
  assert.equal(obs.playbackStatus, 'unknown')
  const line = musicContext(obs, 6000)[0]
  assert.match(line, /fake ur face/, '必须说出歌名，否则她只能去开网页猜')
  assert.match(line, /无法判断是正在播放还是已暂停/, '标题推断不出播放状态，措辞必须挡住「正在播放」这个越界断言')
  assert.match(line, /得问他/, '要引导她去问，而不是自己猜')
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
