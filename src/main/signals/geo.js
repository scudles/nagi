// src/main/signals/geo.js
// 坐标感知信号（只读）：凪「他在哪」的数据来源。
//
// 数据源两级（2026-10-17 新增）：
//   ① Windows 定位 API（geo.ps1，WinRT Geolocator）——需系统「位置」权限，
//      本机实测可能直接加载失败（类型不存在/服务未开）；
//   ② IP 定位（ipwho.is，备用 ip-api.com）——城市级粗定位，有网即可。
// 两条都失败 → 抛错，与 music 一致的失败语义（UI 显示读取失败，不编造坐标）。
//
// 纪律：单独授权落盘（geo.json）、勿扰停采、30 分钟 TTL（不频繁探测、不频繁外网请求）、
// 不触发主动开口、坐标不进共同记忆。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { calendarNow } from '../clock.js'
import { signalsDocumentIo } from '../store/document-io.js'
import { getSettings } from '../settings-store.js'
import { runPowerShell } from '../voice/ps.js'
import { GeoSignal } from '../../core/signals/geo-store.js'

/** Windows 定位 API 成功 → { ok: true, raw }；失败/不可用 → { ok: true, raw:{available:false} } 或 { ok:false, error } */
async function readWindowsGeo() {
  const dir = join(app.getPath('userData'), 'signals')
  mkdirSync(dir, { recursive: true })
  const output = join(dir, 'geo-result-' + randomUUID() + '.json')
  try {
    const result = await runPowerShell(join(resourcesDir, 'geo', 'geo.ps1'), ['-OutFile', output], { timeoutMs: 12000 })
    if (!result.ok || !existsSync(output)) {
      return { ok: false, error: 'Windows 定位读取失败：' + String(result.error || result.stderr || result.code || '').slice(0, 160) }
    }
    return { ok: true, raw: JSON.parse(readFileSync(output, 'utf8')) }
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) }
  } finally {
    rmSync(output, { force: true })
  }
}

/** IP 定位：ipwho.is 优先，ip-api.com 备用；都失败 → { available: false } */
async function readIpGeo() {
  try {
    const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(6000) })
    const j = await res.json()
    if (j && j.success === true && Number.isFinite(Number(j.latitude))) {
      return {
        available: true,
        lat: Number(j.latitude),
        lon: Number(j.longitude),
        city: String(j.city || ''),
        country: String(j.country || ''),
        source: 'ip'
      }
    }
  } catch{ /* B8:degrade — 主源失败正在尝试备用源 */ }
  try {
    const res = await fetch('http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon,isp,query', { signal: AbortSignal.timeout(6000) })
    const j = await res.json()
    if (j && j.status === 'success' && Number.isFinite(Number(j.lat))) {
      return { available: true, lat: Number(j.lat), lon: Number(j.lon), city: String(j.city || ''), country: String(j.country || ''), source: 'ip' }
    }
  } catch{ /* B8:degrade — 离线属预期 */ }
  return { available: false, reason: 'ip-unavailable' }
}

/** 一轮完整探测：Windows 定位优先，失败回退 IP；都失败 → { available: false } */
async function probeGeo() {
  const win = await readWindowsGeo()
  if (win.ok && win.raw?.available === true) return win.raw
  const ip = await readIpGeo()
  if (ip.available === true) return ip
  if (win.ok) return win.raw // { available:false, reason } —— 可能是权限未开
  return { available: false, reason: win.error || 'geo-unavailable' }
}

let geo = null
let timer = null
export function getGeoSignal() {
  if (!geo) geo = new GeoSignal({
    io: signalsDocumentIo(app.getPath('userData')), // B7（P2-05）：落盘端口由 main 注入
    now: calendarNow,
    probe: probeGeo,
    doNotDisturb: () => Boolean(getSettings().privacy?.doNotDisturb || getSettings().privacy?.onlyPresence)
  })
  return geo
}

export async function geoStatus(refresh = false) {
  return getGeoSignal().status({ refresh })
}

export async function authorizeGeo() {
  const signal = getGeoSignal()
  signal.authorize()
  try { return await signal.status({ refresh: true }) }
  catch (err) { return { authorized: true, error: err.message, observation: null } }
}

export function revokeGeo() {
  return getGeoSignal().revoke()
}

export function currentGeoContext() {
  return getGeoSignal().context()
}

export function startGeoMonitor() {
  if (timer) return
  // 60s 轻轮询；真正探测与否由 core 的 30 分钟 TTL 决定，不会频繁外网请求
  timer = setInterval(() => {
    const signal = getGeoSignal()
    if (!signal.authorized()) return
    signal.status({}).catch((err) => console.warn('[geo] 读取失败：', err.message))
  }, 60000)
  timer.unref?.()
}

export function stopGeoMonitor() {
  if (timer) clearInterval(timer)
  timer = null
}
