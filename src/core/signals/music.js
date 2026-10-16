// src/core/signals/music.js
// 媒体感知的纯逻辑：把探针原始输出归一化成一条观测，再决定注入给模型的「此刻」附注。
//
// 2026-10-17 修复记录：
//   ① 旧版 smtc.ps1 只读 GetCurrentSession()（单一「当前」会话），多会话时其余丢失；
//      现在探针返回全会话 sessions[]，这里用可测的选择策略挑「最值得报告的」。
//   ② 旧版只有 playing 才注入上下文——暂停/停止/没有会话对模型完全不可见，
//      她分不清「没在放」和「读不到」。现在四态都给诚实措辞，探针失败（reason=error）不编造。
//   ③ 非 SMTC 播放器（网易云桌面端等）由 players.js 兜底，观测带 source 标记，
//      措辞注明来源与状态未知，不把窗口标题冒充成权威播放状态。

const STATUS_RANK = { playing: 0, paused: 1, stopped: 2, unknown: 3 }

const KNOWN_STATUS = new Set(['playing', 'paused', 'stopped'])

/**
 * 凪自己的媒体会话标识（小写）。
 *
 * 为什么需要（2026-10-17 真机事故，把用户「听不见」的锅甩了很久才发现）：
 *   她说 TTS 语音时，Chromium 把**本应用自己**注册成一条 Windows 媒体会话，
 *   `SourceAppUserModelId` = `electron.exe`（开发/源码态）或「凪 Nagi.exe」（打包态），标题 = 产品名。
 *   不排掉会同时出两个错：
 *     ① probeMedia 看到「有会话在 playing」就早退，真正在放歌的播放器（网易云窗口标题兜底）永远轮不到；
 *     ② 提示词里出现「正在播放：凪 Nagi」这种胡话，模型于是回答「没检测到你播放音频…检查任务栏播放状态」。
 */
export function selfSessionIds({ execPath = '', productName = '' } = {}) {
  const ids = new Set()
  const add = (value) => {
    const s = String(value || '').trim().toLowerCase()
    if (!s) return
    ids.add(s)
    const base = s.split(/[\\/]/).pop() || ''
    if (base) {
      ids.add(base)
      ids.add(base.replace(/\.exe$/, ''))
    }
  }
  add(execPath)
  add(productName)
  add('electron') // 未打包源码态 Electron 的 AUMID 固定是这个
  return [...ids]
}

/**
 * 是否是凪自己的会话。只按 AUMID 判定（标题不参与——标题可能被本地化成任意文案）。
 * 纯函数，可单测。
 */
export function isSelfSession(session, selfIds = []) {
  const app = String(session?.app || '').trim().toLowerCase()
  if (!app) return false
  const base = app.split(/[\\/]/).pop() || app
  const stem = base.replace(/\.exe$/, '')
  return selfIds.some((id) => id && (app === id || base === id || stem === id))
}

/** 过滤掉凪自己的会话（其余原样保留，顺序不变）。 */
export function filterSelfSessions(sessions, selfIds = []) {
  if (!Array.isArray(sessions)) return []
  return sessions.filter((s) => !isSelfSession(s, selfIds))
}

function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase()
  return KNOWN_STATUS.has(s) ? s : 'unknown'
}

function clip(v, n) {
  return String(v ?? '').slice(0, n)
}

/**
 * 从多个候选会话里挑一条报告：
 * 播放中优先，其次暂停/停止；同级里标题非空者优先，再按会话更新时间倒序，最后按原顺序。
 * 纯函数，可单测。
 */
export function pickActiveSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null
  const ranked = sessions.map((s, i) => {
    const status = normalizeStatus(s?.playbackStatus)
    const title = clip(s?.title, 180)
    const updated = Number(s?.updatedAt) > 0 ? Number(s.updatedAt) : 0
    return { i, status, title, updated, hasTitle: title ? 1 : 0 }
  })
  ranked.sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    (b.hasTitle - a.hasTitle) ||
    (b.updated - a.updated) ||
    (a.i - b.i)
  )
  const win = ranked[0]
  const s = sessions[win.i] || {}
  return {
    app: clip(s.app, 120),
    title: win.title,
    artist: clip(s.artist, 120),
    playbackStatus: win.status,
    source: clip(s.source || 'smtc', 40)
  }
}

/**
 * 归一化探针原始输出。
 * 接受两种形状：
 *   - 新：{ available: true, sessions: [{app,title,artist,playbackStatus,updatedAt,source?}] }
 *   - 旧（兼容测试与历史调用点）：{ available: true, app, title, artist, playbackStatus }
 * 不可用时：{ available: false, reason: 'no-session' | 'error' }
 */
export function normalizeMediaObservation(raw, at = Date.now()) {
  if (!raw || raw.available !== true) {
    return { available: false, reason: String(raw?.reason || 'no-session'), observedAt: at }
  }
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [raw]
  if (sessions.length === 0) return { available: false, reason: 'no-session', observedAt: at }
  const picked = pickActiveSession(sessions)
  return { available: true, ...picked, sessionCount: sessions.length, observedAt: at }
}

/**
 * 「此刻」附注：她知道的媒体状态。任何异常/缺字段都不抛错，最坏返回空数组。
 * 播放中保留「不能推断用户心情」护栏（既有契约，有测试断言）。
 */
export function musicContext(observation, now = Date.now()) {
  if (!observation || !Number.isFinite(now - observation.observedAt)) return []
  if (now - observation.observedAt > 120000) return []

  if (!observation.available) {
    if (observation.reason === 'error') return [] // 探针失败：宁可不说，不编造
    return ['用户授权的媒体感知报告：系统里当前没有活跃的媒体会话——他没在播放音乐或视频（或播放器不向系统报告）。']
  }

  const what = observation.title ? `「${observation.title}」` : '一个没有标题的媒体'
  const who = observation.artist ? ` / ${observation.artist}` : ''
  const where = observation.app ? `（来自${observation.app}）` : ''
  const fromTitle = observation.source && observation.source !== 'smtc'
    ? '（来源：播放器窗口标题，不是系统媒体会话，播放状态未证实，仅作参考）'
    : ''

  if (observation.playbackStatus === 'playing') {
    return ['用户授权的 Windows 媒体会话报告正在播放：' + observation.title +
      (observation.artist ? ' / ' + observation.artist : '') +
      '。这只能证明媒体会话状态，不能推断用户心情或正在认真听。']
  }
  if (observation.playbackStatus === 'paused') {
    return [`用户授权的媒体感知报告：${what}${who}${where} 已暂停。${fromTitle}`.trim()]
  }
  if (observation.playbackStatus === 'stopped') {
    return [`用户授权的媒体感知报告：${what}${who}${where} 已停止。${fromTitle}`.trim()]
  }
  return [`用户授权的媒体感知报告：${what}${who}${where} 播放状态未知，可能仍在播放。${fromTitle}`.trim()]
}
