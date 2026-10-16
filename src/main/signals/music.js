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
 *   ① SMTC 有「播放中」会话 → 直接以 SMTC 为准（省一次进程）；
 *   ② SMTC 没有播放中会话（no-session / paused / stopped / 读取失败）→ 查窗口标题兜底；
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
 * 全部被丢掉时返回 no-session 形状，好让调用方继续走窗口标题兜底。
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
  if (smtc.ok && pickActiveSession(smtc.raw.sessions || [])?.playbackStatus === 'playing') {
    return mergeMediaObservations(smtc.raw, null)
  }
  const fallback = await serialize(() => readPlayerTitles())
  if (fallback.ok) {
    // 窗口标题 → sessions 形状的兜底观测（白名单过滤 + 标题解析都在 core，可单测）
    const fallbackObs = buildFallbackObservation(fallback.raw?.windows || [], Date.now())
    return mergeMediaObservations(smtc.ok ? smtc.raw : null, fallbackObs)
  }
  if (smtc.ok) return mergeMediaObservations(smtc.raw, null)
  throw new Error(fallback.error || smtc.error || '媒体感知读取失败')
}

let music = null
let timer = null
export function getMusicSignal() {
  if (!music) music = new MusicSignal(app.getPath('userData'), {
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

export function currentMusicContext() {
  return getMusicSignal().context()
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
