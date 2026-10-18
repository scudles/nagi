// src/core/signals/music-store.js
// 「他在听什么」的授权型信号：单独授权落盘、勿扰停采、60 秒缓存。
// 纯逻辑：不碰 fs、不读全局时钟——io 端口与 now() 由调用方注入（B7 P2-05）。
import { assertPorts } from '../store/document-io.js'
import { musicContext, normalizeMediaObservation } from './music.js'

/** 授权文件的文档键；真实路径由 main 侧 src/main/store/document-io.js 登记 */
export const MUSIC_CONSENT_KEY = 'music-consent'

/** 观测复用阈值：60 秒内不重复探测 PowerShell；与 fresh() 必须同改 */
export const MEDIA_TTL_MS = 60000

export class MusicSignal {
  constructor({ io, now, probe, doNotDisturb = () => false } = {}) {
    assertPorts('MusicSignal', { io, now }, ['io', 'now'])
    this.io = io
    this.now = now
    this.probe = probe
    this.doNotDisturb = doNotDisturb
    this.last = null
    this.lastError = null
    this.generation = 0
    this.inflight = null
  }

  authorized() {
    const raw = this.io.read(MUSIC_CONSENT_KEY)
    if (raw === null || raw === undefined) return false
    try { return Number(JSON.parse(raw).authorizedAt) > 0 }
    catch { return false }
  }

  authorize(at = this.now()) {
    this.io.write(MUSIC_CONSENT_KEY, JSON.stringify({ version: 1, authorizedAt: at }))
    this.generation++
    this.inflight = null
    return { authorized: true, authorizedAt: at }
  }

  revoke() {
    this.generation++
    this.inflight = null
    this.io.remove(MUSIC_CONSENT_KEY)
    this.last = null
    return { authorized: false }
  }

  async status({ refresh = false, now = this.now() } = {}) {
    if (!this.authorized()) return { authorized: false, observation: null }
    const authorizedAt = JSON.parse(this.io.read(MUSIC_CONSENT_KEY)).authorizedAt
    if (this.doNotDisturb()) {
      this.last = null
      return { authorized: true, authorizedAt, paused: 'do-not-disturb', observation: null }
    }
    if (refresh || !this.last || now - this.last.observedAt > MEDIA_TTL_MS) {
      if (!this.inflight) {
        const generation = this.generation
        const task = Promise.resolve().then(() => this.probe()).then((raw) => {
          if (generation === this.generation && this.authorized()) {
            this.last = normalizeMediaObservation(raw, now)
          }
        })
        this.inflight = task
        const clear = () => { if (this.inflight === task) this.inflight = null }
        task.then(clear, clear)
      }
      // 探针失败**不清空**上一次的成功观测：一次瞬时读取失败（PowerShell 在负载高时
      // 被误判超时、或播放器正切歌）不该让她这一分钟变成"什么都不知道"。
      // 观测本身有 120 秒 TTL，过期自然失效，所以保留旧值不会变成"编造"。
      try { await this.inflight; this.lastError = null }
      catch (err) { this.lastError = String(err?.message || err).slice(0, 200); throw err }
    }
    return this.authorized()
      ? { authorized: true, authorizedAt, observation: this.last, lastError: this.lastError }
      : { authorized: false, observation: null }
  }

  context(now = this.now()) {
    if (!this.authorized() || this.doNotDisturb()) return []
    return musicContext(this.last, now)
  }

  /**
   * 缓存是否够新（够新就不必再探一次 PowerShell）。
   * 与 status() 内部的复用阈值保持一致，改一处必须改另一处。
   */
  fresh(now = this.now()) {
    return Boolean(this.last) && Number.isFinite(now - this.last.observedAt) &&
      now - this.last.observedAt <= MEDIA_TTL_MS
  }
}
