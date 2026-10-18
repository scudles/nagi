// src/main/signals/music.js
// 媒体感知信号（只读）：凪「正在听/看什么」的唯一数据来源。
//
// 数据源两层（2026-10-17 修复）：
//   ① SMTC（Windows 媒体会话）——权威，带播放状态；browser/Spotify 等有会话的播放器走这里。
//      探针返回全会话 sessions[]，由 core/signals/music.js 的选择策略挑最值得报告的一条。
//   ② 白名单播放器窗口标题（player-title.ps1 + core/signals/players.js）——兜底：
//      网易云音乐桌面端等不注册 SMTC 会话，只能读窗口标题；状态未知、措辞注明来源。
//
// 纪律沿用信号体系：单独授权落盘（music.json）、勿扰/只陪着停采、不触发主动开口、
// 不把曲目写进共同记忆。PowerShell 调用一律走 voice/ps.js 的串行队列。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { getSettings } from '../settings-store.js'
import { runPowerShell, serialize } from '../voice/ps.js'
import { pickActiveSession, filterSelfSessions, selfSessionIds } from '../../core/signals/music.js'
import { DEFAULT_PLAYER_PROCESSES, buildFallbackObservation, mergeMediaObservations } from '../../core/signals/players.js'
import { foregroundContext } from '../../core/signals/foreground.js'
import { calendarNow } from '../clock.js'
import { signalsDocumentIo } from '../store/document-io.js'
import { MusicSignal } from '../../core/signals/music-store.js'

/** SMTC 全会话读取成功 → { ok: true, raw }；失败 → { ok: false, error } */
async function readSystemMedia() {
  const dir = join(app.getPath('userData'), 'signals')
  mkdirSync(dir, { recursive: true })
  const output = join(dir, 'music-result-' + randomUUID() + '.json')
  try {
    const result = await runPowerShell(join(resourcesDir, 'music', 'smtc.ps1'), ['-OutFile', output], { timeoutMs: 20000 })
    if (!result.ok || !existsSync(output)) {
      return { ok: false, error: 'Windows 媒体会话读取失败：' + String(result.error || result.stderr || result.code || '').slice(0, 160) }
    }
    return { ok: true, raw: JSON.parse(readFileSync(output, 'utf8')) }
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) }
  } finally {
    rmSync(output, { force: true })
  }
}

/** 白名单播放器窗口标题成功 → { ok: true, raw }；失败 → { ok: false, error } */
async function readPlayerTitles() {
  const extra = Array.isArray(getSettings().signals?.extraPlayerProcesses)
    ? getSettings().signals.extraPlayerProcesses.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const names = [...new Set([...DEFAULT_PLAYER_PROCESSES.map((p) => p.process), ...extra])].join(',')
  const dir = join(app.getPath('userData'), 'signals')
  mkdirSync(dir, { recursive: true })
  const output = join(dir, 'player-title-' + randomUUID() + '.json')
  try {
    const result = await runPowerShell(join(resourcesDir, 'music', 'player-title.ps1'), ['-OutFile', output, '-Processes', names], { timeoutMs: 20000 })
    if (!result.ok || !existsSync(output)) {
      return { ok: false, error: '播放器窗口标题读取失败：' + String(result.error || result.stderr || result.code || '').slice(0, 160) }
    }
    return { ok: true, raw: JSON.parse(readFileSync(output, 'utf8')) }
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) }
  } finally {
    rmSync(output, { force: true })
  }
}

/**
 * 一轮完整探测（返回归一化前的原始观测）：
 *   ① SMTC 与窗口标题**两层都探**——不再「SMTC 有播放中就不看播放器标题」。
 *      真机踩过（2026-10-18）：用户一边在 Edge 看视频一边用网易云听歌，
 *      旧实现在 SMTC 见到 playing 就早退，歌被完全盖掉，她以为用户只是在看视频。
 *   ② 两层结果的取舍（谁做主报告、谁并进 others）全在 core 纯函数里，可单测。
 *   ③ 两个数据源都失败 → 抛错（沿用旧行为：UI 显示读取失败、不编造观测）。
 * 两次 PowerShell 都走串行队列，避免与语音链路互相拖慢。
 */
let selfIdsCache = null
/** 本进程自己的会话标识（开发态 electron.exe / 打包态「凪 Nagi.exe」 + 产品名） */
function selfIds() {
  if (!selfIdsCache) {
    selfIdsCache = selfSessionIds({
      execPath: process.execPath,
      productName: typeof app.getName === 'function' ? app.getName() : ''
    })
  }
  return selfIdsCache
}

let selfLogged = 0
/**
 * 丢掉凪自己的媒体会话（她说 TTS 时 Chromium 会把她注册成播放器）。
 * 全部被丢掉时返回 no-session 形状。
 */
function dropSelfSessions(raw) {
  const all = Array.isArray(raw?.sessions) ? raw.sessions : []
  const kept = filterSelfSessions(all, selfIds())
  if (kept.length !== all.length && kept.length !== selfLogged) {
    selfLogged = kept.length
    console.log('[music] 已忽略凪自身的媒体会话 ' + (all.length - kept.length) + ' 条（AUMID=' + selfIds().join('/') + '）')
  }
  if (!kept.length && all.length) return { available: false, reason: 'no-session' }
  return { ...raw, sessions: kept }
}

async function probeMedia() {
  const smtc = await serialize(() => readSystemMedia())
  if (smtc.ok) smtc.raw = dropSelfSessions(smtc.raw)
  const fallback = await serialize(() => readPlayerTitles())
  const fallbackObs = fallback.ok
    // 窗口标题 → sessions 形状的兜底观测（白名单过滤 + 标题解析都在 core，可单测）
    ? buildFallbackObservation(fallback.raw?.windows || [], Date.now())
    : null
  if (smtc.ok) return mergeMediaObservations(smtc.raw, fallbackObs)
  if (fallbackObs) return mergeMediaObservations(null, fallbackObs)
  throw new Error(fallback.error || smtc.error || '媒体感知读取失败')
}

let music = null
let timer = null
export function getMusicSignal() {
  if (!music) music = new MusicSignal({
    io: signalsDocumentIo(app.getPath('userData')), // B7（P2-05）：落盘端口由 main 注入
    now: calendarNow,
    probe: probeMedia,
    doNotDisturb: () => Boolean(getSettings().privacy?.doNotDisturb || getSettings().privacy?.onlyPresence)
  })
  return music
}

export async function musicStatus(refresh = false) {
  return getMusicSignal().status({ refresh })
}

export async function authorizeMusic() {
  const signal = getMusicSignal()
  signal.authorize()
  try { return await signal.status({ refresh: true }) }
  catch (err) { return { authorized: true, error: err.message, observation: null } }
}

export function revokeMusic() {
  return getMusicSignal().revoke()
}

/**
 * 「她此刻知道的媒体状态」——每轮对话都会调用（agent.js 的 extra）。
 *
 * 2026-10-18 修复：原来是同步读缓存（只读 `signal.last`），缓存为空时**永远**返回空数组，
 * 于是她只会去开网页猜「你在听什么」。用户实测踩到：云音乐在放歌、窗口标题探针也能读到，
 * 但凪从没主动探过 → 她一无所知。
 *
 * 现在：缓存缺失或过期就当场探一次，但**给对话设预算**（探针最坏 20 秒，不能卡住回复）。
 *   · 预算内探到 → 用新观测；
 *   · 超预算 → 不让用户等，先返回旧缓存（可能为空），探针仍在后台补上；
 *   · 探针报错 → 如实返回空数组，绝不编造（沿用「宁可不说」契约）。
 */
const CONTEXT_BUDGET_MS = 1500

/**
 * 媒体上下文（2026-10-18 扩展）：媒体会话 + 前台窗口两条来源。
 *
 * 为什么必须加前台窗口：SMTC 只认识「注册了媒体会话」的播放器。
 * 用户的实际场景是「Edge 看视频 + 网易云听歌」——SMTC 里可能只有 Edge（还常因切标签报 Paused），
 * 而网易云的歌名只在窗口标题里。前台窗口是唯一同时覆盖两者的信号，
 * 也只有它才能回答「在看什么视频」（媒体会话给的是网页标题）。
 *
 * 顺序：媒体状态在前（她最常被问的），前台在后（"他在干什么"的兜底）。
 * 前台拿不到（监测没开/勿扰/黑名单命中）就静默跳过，绝不影响媒体那条。
 */
export async function currentMusicContext(now = Date.now()) {
  const { media, foreground } = await currentObservationContext(now)
  return [...media, ...foreground]
}

/**
 * C4：把媒体与前台**分开返回**，让出站处能分别裁决（契约 §6.3）。
 * 标题那条要不要发，由 agent.js 在真正调用模型前用 titleOutboundAllowed() 再验一次；
 * 这里只负责"在开关关掉时干脆不采"。
 * @returns {Promise<{media:string[], foreground:string[]}>}
 */
export async function currentObservationContext(now = Date.now()) {
  const media = await mediaContext(now)
  let foreground = []
  // 独立开关：关掉即不进这条链（不采、不拼、不发）
  if (getSettings().privacy?.titleOutbound === false) return { media, foreground }
  try {
    const { foregroundSample } = await import('../monitor/index.js')
    const sample = await foregroundSample()
    foreground = sample ? foregroundContext(sample, Date.now(), { enabled: true }) : []
  } catch (err) {
    // 前台感知是加分项，任何异常都不能让媒体那条一起消失
    console.warn('[music] 前台窗口上下文不可用：', err?.message || err)
  }
  return { media, foreground }
}

async function mediaContext(now = Date.now()) {
  const signal = getMusicSignal()
  // 未授权 / 勿扰：沿用原语义，静默返回空（不探测、不留痕）
  if (!signal.authorized() || signal.doNotDisturb()) return []
  // 缓存新鲜（60 秒内）直接用，省一次 PowerShell
  if (signal.fresh(now)) return signal.context(now)
  try {
    let timer = null
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CONTEXT_BUDGET_MS)
      timer.unref?.()
    })
    // status({refresh:true}) 内部对 inflight 去重，对话连发也不会并发起多轮 PowerShell
    const probed = signal.status({ refresh: true, now }).catch((err) => {
      console.warn('[music] 对话前刷新媒体状态失败：', err?.message || err)
      return null
    })
    const winner = await Promise.race([probed, budget])
    if (timer) clearTimeout(timer)
    if (winner === 'timeout') return signal.context(Date.now()) // 有旧缓存就先用旧的
    return signal.context(Date.now())
  } catch {
    return []
  }
}

// 平时 60 秒刷新一次就够；**失败时 10 秒后重试**——启动那一两分钟里
// PowerShell 可能正被语音预热占着（会误判超时），旧实现一等就是 60 秒，
// 用户恰好在这段时间问「我在听什么」就必然什么都拿不到（2026-10-17 踩到）。
const OK_INTERVAL_MS = 60000
const RETRY_INTERVAL_MS = 10000

export function startMusicMonitor() {
  if (timer) return
  const tick = async () => {
    const signal = getMusicSignal()
    let failed = false
    if (signal.authorized()) {
      try { await signal.status({ refresh: true }) }
      catch (err) {
        failed = true
        console.warn('[music] 读取失败：', err.message)
      }
    }
    timer = setTimeout(tick, failed ? RETRY_INTERVAL_MS : OK_INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(tick, 0)
  timer.unref?.()
}

export function stopMusicMonitor() {
  if (timer) clearTimeout(timer)
  timer = null
}
