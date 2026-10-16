export function normalizeMediaObservation(raw, at = Date.now()) {
  if (!raw || raw.available !== true) return { available: false, reason: String(raw?.reason || 'no-session'), observedAt: at }
  const status = String(raw.playbackStatus || '').toLowerCase()
  return {
    available: true,
    app: String(raw.app || '').slice(0, 120),
    title: String(raw.title || '').slice(0, 180),
    artist: String(raw.artist || '').slice(0, 120),
    playbackStatus: ['playing', 'paused', 'stopped'].includes(status) ? status : 'unknown',
    observedAt: at
  }
}

export function musicContext(observation, now = Date.now()) {
  if (!observation?.available || observation.playbackStatus !== 'playing' ||
      !observation.title || now - observation.observedAt > 120000) return []
  return ['用户授权的 Windows 媒体会话报告正在播放：' + observation.title +
    (observation.artist ? ' / ' + observation.artist : '') +
    '。这只能证明媒体会话状态，不能推断用户心情或正在认真听。']
}
