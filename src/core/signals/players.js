// src/core/signals/players.js
// 非 SMTC 播放器的兜底感知：
// 网易云音乐、QQ 音乐等桌面端（Qt/Win32 实现）不向 Windows 注册 SMTC 媒体会话，
// 唯一稳定可见的线索是「窗口标题」（网易云：约定 - 王菲）。
//
// 隐私边界：只读白名单播放器进程的窗口标题，不枚举/不读取任何其他窗口。
// 诚实边界：标题无法区分播放中与暂停，播放状态一律标 unknown，措辞注明来源。
// 纯逻辑、可单测；进程白名单可经 settings.signals.extraPlayerProcesses 追加。
import { pickActiveSession } from './music.js'

/** 默认白名单：进程名 → 展示名。进程名大小写不敏感匹配 */
export const DEFAULT_PLAYER_PROCESSES = [
  { process: 'cloudmusic', name: '网易云音乐' },
  { process: 'qqmusic', name: 'QQ音乐' },
  { process: 'spotify', name: 'Spotify' },
  { process: 'applemusic', name: 'Apple Music' },
  { process: 'itunes', name: 'iTunes' },
  { process: 'kwmusic', name: '酷我音乐' },
  { process: 'kugou', name: '酷狗音乐' },
  { process: 'potplayer', name: 'PotPlayer' },
  { process: 'vlc', name: 'VLC' },
  { process: 'foobar2000', name: 'foobar2000' }
]

/** 标题末尾要剥掉的播放器名/站点名后缀（大小写不敏感） */
const PLAYER_SUFFIXES = /[-–—\s|·]*(qq音乐|网易云音乐|酷狗音乐|酷我音乐|spotify|apple\s*music|itunes|potplayer|vlc|foobar2000|哔哩哔哩|bilibili)\s*$/i

const SEPARATOR = /\s+[-–—]\s+/

function clean(s) {
  return String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 去掉「1. 」「01 」这类曲目序号前缀（限两位数字，避免误伤「1984 歌名」） */
function stripTrackNumber(s) {
  return s.replace(/^\d{1,2}\s*[.、\-\s]\s*/, '')
}

/**
 * 解析播放器窗口标题 → { title, artist } | null
 * 约定（与网易云/QQ 音乐实测一致）：标题形如「歌名 - 艺人 [ - 播放器名]」。
 * 只有一段时视为歌名、艺人未知；不分「艺人 - 歌名」顺序（各播放器不统一，
 * 宁可少报艺人也别报反；需要按进程定制时在此函数加白名单分支）。
 */
export function parsePlayerTitle(rawTitle) {
  const text = clean(rawTitle)
  if (!text) return null
  const stripped = stripTrackNumber(text).replace(PLAYER_SUFFIXES, '').trim()
  if (!stripped) return null
  const parts = stripped.split(SEPARATOR).map((p) => clean(p)).filter(Boolean)
  if (parts.length === 0) return null
  if (parts.length === 1) return { title: parts[0].slice(0, 180), artist: '' }
  return { title: parts[0].slice(0, 180), artist: parts.slice(1).join(' / ').slice(0, 120) }
}

/** 按进程名（大小写不敏感）查白名单展示名 */
export function playerDisplayName(processName, processes = DEFAULT_PLAYER_PROCESSES) {
  const key = String(processName || '').toLowerCase()
  const hit = processes.find((p) => p.process.toLowerCase() === key)
  return hit ? hit.name : String(processName || '').slice(0, 40)
}

/**
 * 把探针读到的窗口数组 → 兜底观测原始输出（sessions 形状，来源 window-title）。
 * 纵深防御：这里再次按白名单过滤进程（探针脚本已过滤过一道）。
 * windows: [{ process, title }]
 */
export function buildFallbackObservation(windows = [], at = Date.now(), { processes = DEFAULT_PLAYER_PROCESSES } = {}) {
  const sessions = []
  for (const w of Array.isArray(windows) ? windows : []) {
    const known = processes.find((p) => p.process.toLowerCase() === String(w?.process || '').toLowerCase())
    if (!known) continue
    const parsed = parsePlayerTitle(w?.title)
    if (!parsed || !parsed.title) continue
    sessions.push({
      app: known.name,
      title: parsed.title,
      artist: parsed.artist,
      playbackStatus: 'unknown',
      source: 'window-title',
      updatedAt: at
    })
  }
  if (!sessions.length) return { available: false, reason: 'no-session' }
  return { available: true, sessions }
}

/**
 * 合并 SMTC 观测与窗口标题兜底（选择策略，纯函数可单测）：
 *   ① SMTC 有「播放中」会话 → 以 SMTC 为准（权威、有播放状态）；
 *   ② 否则有白名单播放器标题 → 用兜底（状态 unknown、来源已标注，措辞诚实）；
 *   ③ 再否则用 SMTC 的 paused/stopped（至少「刚才在放的那个已暂停」是事实）；
 *   ④ 都没有 → no-session。
 */
export function mergeMediaObservations(smtcRaw, fallbackRaw) {
  const smtcBest = smtcRaw?.available && Array.isArray(smtcRaw.sessions) ? pickActiveSession(smtcRaw.sessions) : null
  if (smtcBest?.playbackStatus === 'playing') return { available: true, sessions: smtcRaw.sessions }
  if (fallbackRaw?.available && fallbackRaw.sessions?.length) {
    return { available: true, sessions: fallbackRaw.sessions }
  }
  if (smtcRaw?.available) return { available: true, sessions: smtcRaw.sessions }
  return { available: false, reason: smtcRaw?.reason || fallbackRaw?.reason || 'no-session' }
}
