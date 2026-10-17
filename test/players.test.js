import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMediaObservation, musicContext } from '../src/core/signals/music.js'
import {
  DEFAULT_PLAYER_PROCESSES,
  buildFallbackObservation,
  mergeMediaObservations,
  parsePlayerTitle,
  playerDisplayName
} from '../src/core/signals/players.js'

test('播放器窗口标题解析：网易云/QQ音乐常见形态', () => {
  assert.deepEqual(parsePlayerTitle('约定 - 王菲'), { title: '约定', artist: '王菲' })
  assert.deepEqual(parsePlayerTitle('约定 - 王菲 - QQ音乐'), { title: '约定', artist: '王菲' })
  assert.deepEqual(parsePlayerTitle('01 约定 - 王菲'), { title: '约定', artist: '王菲' })
  assert.deepEqual(parsePlayerTitle('约定 – 王菲'), { title: '约定', artist: '王菲' })
  assert.deepEqual(parsePlayerTitle('某首歌'), { title: '某首歌', artist: '' })
  assert.equal(parsePlayerTitle(''), null)
  assert.equal(parsePlayerTitle('   '), null)
  // 剥掉播放器名后缀后为空 → 认为没有曲目
  assert.equal(parsePlayerTitle('网易云音乐'), null)
})

test('进程展示名：大小写不敏感，未登记的原样返回', () => {
  assert.equal(playerDisplayName('cloudmusic'), '网易云音乐')
  assert.equal(playerDisplayName('CloudMusic'), '网易云音乐')
  assert.equal(playerDisplayName('Spotify'), 'Spotify')
  assert.equal(playerDisplayName('weirdproc'), 'weirdproc')
})

test('兜底观测构造：只收白名单进程且能解析出曲名的窗口', () => {
  const raw = buildFallbackObservation([
    { process: 'cloudmusic', title: '约定 - 王菲' },
    { process: 'CloudMusic', title: '网易云音乐' }, // 剥完为空，丢弃
    { process: 'notaplayer', title: '某个窗口' }, // 不在白名单，丢弃
    { process: 'qqmusic', title: '歌 - 手 - QQ音乐' }
  ], 1234)
  assert.equal(raw.available, true)
  assert.equal(raw.sessions.length, 2)
  assert.deepEqual(raw.sessions[0], {
    app: '网易云音乐', title: '约定', artist: '王菲',
    playbackStatus: 'unknown', source: 'window-title', updatedAt: 1234
  })
  assert.equal(raw.sessions[1].app, 'QQ音乐')
  // 一个都不成 → 不可用
  assert.equal(buildFallbackObservation([{ process: 'cloudmusic', title: '网易云音乐' }], 1).available, false)
  assert.equal(buildFallbackObservation([], 1).available, false)
  assert.ok(DEFAULT_PLAYER_PROCESSES.length > 0)
})

test('同时开着两个媒体：SMTC 播放中时，兜底里的另一个播放器不能被丢（2026-10-18 真机）', () => {
  // 用户实况：Edge 在放视频（SMTC，Playing）+ 网易云在听歌（只有窗口标题）。
  // 旧实现在 SMTC 见到 playing 就早退，歌被完全盖掉 → 她以为用户只是在看视频。
  const smtcPlayingEdge = { available: true, sessions: [
    { app: 'MSEdge', title: '某游戏杂谈', artist: '', playbackStatus: 'Playing' }
  ] }
  const fallback = buildFallbackObservation([{ process: 'cloudmusic', title: 'fake ur face - s0rrow' }], 10)

  const merged = mergeMediaObservations(smtcPlayingEdge, fallback)
  assert.equal(merged.sessions.length, 2, '两个媒体都要留着')
  const obs = normalizeMediaObservation(merged, 20)
  assert.equal(obs.app, 'MSEdge', '主报告仍以 SMTC 为准（有权威播放状态）')
  assert.equal(obs.playbackStatus, 'playing')
  assert.equal(obs.others.length, 1, '落选的那个必须出现在 others 里')
  assert.equal(obs.others[0].app, '网易云音乐')
  assert.equal(obs.others[0].title, 'fake ur face')

  // 措辞层：主报告不变，但要多一句并列事实
  const line = musicContext(obs, 30)[0]
  assert.match(line, /正在播放「某游戏杂谈」/, '主报告要说出标题（含书名号便于模型识别）')
  assert.match(line, /来自MSEdge/, '主报告必须带来源应用，否则模型不知道是哪个播放器')
  assert.match(line, /另外，同时还有/, '必须告诉模型还开着别的媒体')
  assert.match(line, /fake ur face/, '歌名要出现，否则她仍然只知道视频')
  assert.match(line, /用户可能同时开着好几个媒体/)
})

test('同一应用不重复计入 others（SMTC 与窗口标题指向同一个播放器时）', () => {
  const smtc = { available: true, sessions: [
    { app: 'Spotify', title: 'A', artist: '', playbackStatus: 'Playing' }
  ] }
  // 兜底读到同名应用的另一个窗口标题：不能既当主报告又当「另一个媒体」
  const fallback = { available: true, sessions: [
    { app: 'Spotify', title: 'A', artist: '', playbackStatus: 'unknown', source: 'window-title' }
  ] }
  const merged = mergeMediaObservations(smtc, fallback)
  assert.equal(merged.sessions.length, 1, '同一 app 不重复并入')
  assert.equal(normalizeMediaObservation(merged, 10).others.length, 0)
})

test('兜底为主时，SMTC 里正在播放的会话也要带上', () => {
  // SMTC 只有暂停的 Edge，兜底命中云音乐 → 主报告云音乐，但 Edge 的暂停态不必再报
  const smtcPaused = { available: true, sessions: [
    { app: 'MSEdge', title: '视频', artist: '', playbackStatus: 'Paused' }
  ] }
  const fallback = buildFallbackObservation([{ process: 'cloudmusic', title: '约定 - 王菲' }], 10)
  const merged = mergeMediaObservations(smtcPaused, fallback)
  const obs = normalizeMediaObservation(merged, 20)
  assert.equal(obs.app, '网易云音乐', '兜底命中时以播放器为主')
  // 暂停的 Edge 不并进来（避免噪音：没在放的东西不必并列）
  assert.equal(obs.others.length, 0)
})

test('合并策略：SMTC 播放中优先；其暂停/无会话时用兜底；都没有才沿用 SMTC 暂停态', () => {
  const smtcPlaying = { available: true, sessions: [
    { app: 'Spotify', title: 'A', artist: '', playbackStatus: 'Playing' }
  ] }
  const smtcPaused = { available: true, sessions: [
    { app: 'MSEdge', title: '视频', artist: '', playbackStatus: 'Paused' }
  ] }
  const fallback = buildFallbackObservation([{ process: 'cloudmusic', title: '约定 - 王菲' }], 10)

  // ① SMTC 有播放中 → 以 SMTC 为准
  const mergedPlaying = mergeMediaObservations(smtcPlaying, fallback)
  assert.equal(mergedPlaying.sessions[0].title, 'A')

  // ② SMTC 只有暂停 → 用兜底（网易云才是他真正在听的）
  const mergedFallback = mergeMediaObservations(smtcPaused, fallback)
  assert.equal(mergedFallback.sessions[0].title, '约定')
  assert.equal(mergedFallback.sessions[0].source, 'window-title')

  // ③ 兜底也没有 → 沿用 SMTC 的暂停态（至少「刚才那个已暂停」是事实）
  const mergedPaused = mergeMediaObservations(smtcPaused, { available: false })
  assert.equal(normalizeMediaObservation(mergedPaused, 100).playbackStatus, 'paused')

  // ④ 都没有 → 不可用，且保留原因
  const nothing = mergeMediaObservations({ available: false, reason: 'no-session' }, null)
  assert.equal(nothing.available, false)
  assert.equal(nothing.reason, 'no-session')

  // ⑤ SMTC 读取失败但兜底成功 → 仍给出兜底观测
  const onlyFallback = mergeMediaObservations(null, fallback)
  assert.equal(onlyFallback.available, true)
  assert.equal(onlyFallback.sessions[0].app, '网易云音乐')
})
