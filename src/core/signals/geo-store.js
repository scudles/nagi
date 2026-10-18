// src/core/signals/geo-store.js
// 坐标感知信号（只读）的纯逻辑：授权落盘、勿扰停采、TTL 缓存、归一化与「此刻」附注。
//
// 与 music 信号的纪律一致：默认不读、单独授权（geo.json，撤销即删）、
// 不触发主动开口、不写入共同记忆。位置属敏感数据，附注里注明来源与精度，
// 并要求她不主动提位置。
//
// 数据源（main 侧组装）：Windows 定位 API 优先，失败回退 IP 定位（城市级）。
//
// B7（P2-05）：本文件不再引用 node:fs / node:crypto，也不读全局时钟——
//   落盘走文档端口（io）、「此刻」走注入的 now()。temps 文件名由 io 侧负责，
//   因此 core 里连 randomUUID 都不需要。
import { assertPorts } from '../store/document-io.js'

/** 授权文件的文档键；真实路径由 main 侧 src/main/store/document-io.js 登记 */
export const GEO_CONSENT_KEY = 'geo-consent'

/** 坐标缓存有效期：30 分钟内不重复探测 */
export const GEO_TTL_MS = 30 * 60 * 1000

/** 归一化探针原始输出：{ available, lat, lon, city, country, accuracyMeters, source, observedAt } */
export function normalizeGeoObservation(raw, at) {
  if (!raw || raw.available !== true) {
    return { available: false, reason: String(raw?.reason || 'unavailable'), observedAt: at }
  }
  const lat = Number(raw.lat)
  const lon = Number(raw.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { available: false, reason: 'bad-coordinates', observedAt: at }
  }
  return {
    available: true,
    lat,
    lon,
    city: String(raw.city || '').slice(0, 60),
    country: String(raw.country || '').slice(0, 60),
    accuracyMeters: Number(raw.accuracyMeters) > 0 ? Number(raw.accuracyMeters) : null,
    source: raw.source === 'windows-api' ? 'windows-api' : 'ip',
    observedAt: at
  }
}

/**
 * 「此刻」附注：她知道的他的大致位置。
 * 过期（超过 TTL）或不可用 → 空数组；措辞必须守住「粗定位、别主动提」。
 */
export function geoContext(observation, now) {
  if (!observation || !Number.isFinite(now - observation.observedAt)) return []
  if (now - observation.observedAt > GEO_TTL_MS) return []
  if (!observation.available) return []
  const where = [observation.city, observation.country].filter(Boolean).join('，')
  const kind = observation.source === 'windows-api' ? '系统定位' : 'IP 粗定位'
  return [`他授权过的位置感知显示他大概在${where || '某个地方'}（${observation.lat.toFixed(4)}, ${observation.lon.toFixed(4)}，${kind}）。` +
    '这只是大致位置，别说得像在精确跟踪；他没问起就别主动提位置。']
}

export class GeoSignal {
  constructor({ io, now, probe, doNotDisturb = () => false } = {}) {
    assertPorts('GeoSignal', { io, now }, ['io', 'now'])
    this.io = io
    this.now = now
    this.probe = probe
    this.doNotDisturb = doNotDisturb
    this.last = null
    this.generation = 0
    this.inflight = null
  }

  authorized() {
    const raw = this.io.read(GEO_CONSENT_KEY)
    if (raw === null || raw === undefined) return false
    try { return Number(JSON.parse(raw).authorizedAt) > 0 }
    catch { return false }
  }

  authorize(at = this.now()) {
    this.io.write(GEO_CONSENT_KEY, JSON.stringify({ version: 1, authorizedAt: at }))
    this.generation++
    this.inflight = null
    return { authorized: true, authorizedAt: at }
  }

  revoke() {
    this.generation++
    this.inflight = null
    this.io.remove(GEO_CONSENT_KEY)
    this.last = null
    return { authorized: false }
  }

  async status({ refresh = false, now = this.now() } = {}) {
    if (!this.authorized()) return { authorized: false, observation: null }
    const authorizedAt = JSON.parse(this.io.read(GEO_CONSENT_KEY)).authorizedAt
    if (this.doNotDisturb()) {
      this.last = null
      return { authorized: true, authorizedAt, paused: 'do-not-disturb', observation: null }
    }
    if (refresh || !this.last || now - this.last.observedAt > GEO_TTL_MS) {
      if (!this.inflight) {
        const generation = this.generation
        const task = Promise.resolve().then(() => this.probe()).then((raw) => {
          if (generation === this.generation && this.authorized()) {
            this.last = normalizeGeoObservation(raw, now)
          }
        })
        this.inflight = task
        const clear = () => { if (this.inflight === task) this.inflight = null }
        task.then(clear, clear)
      }
      try { await this.inflight } catch (err) { this.last = null; throw err }
    }
    return this.authorized() ? { authorized: true, authorizedAt, observation: this.last } : { authorized: false, observation: null }
  }

  context(now = this.now()) {
    if (!this.authorized() || this.doNotDisturb()) return []
    return geoContext(this.last, now)
  }
}
