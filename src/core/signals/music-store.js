import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { musicContext, normalizeMediaObservation } from './music.js'

export class MusicSignal {
  constructor(userDataDir, { probe, doNotDisturb = () => false } = {}) {
    this.dir = join(userDataDir, 'signals')
    this.consentFile = join(this.dir, 'music.json')
    this.probe = probe
    this.doNotDisturb = doNotDisturb
    this.last = null
    this.lastError = null
    this.generation = 0
    this.inflight = null
  }

  authorized() {
    if (!existsSync(this.consentFile)) return false
    try { return Number(JSON.parse(readFileSync(this.consentFile, 'utf8')).authorizedAt) > 0 }
    catch { return false }
  }

  authorize(at = Date.now()) {
    mkdirSync(this.dir, { recursive: true })
    const temp = this.consentFile + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, authorizedAt: at }), 'utf8')
    renameSync(temp, this.consentFile)
    this.generation++
    this.inflight = null
    return { authorized: true, authorizedAt: at }
  }

  revoke() {
    this.generation++
    this.inflight = null
    rmSync(this.consentFile, { force: true })
    this.last = null
    return { authorized: false }
  }

  async status({ refresh = false, now = Date.now() } = {}) {
    if (!this.authorized()) return { authorized: false, observation: null }
    const authorizedAt = JSON.parse(readFileSync(this.consentFile, 'utf8')).authorizedAt
    if (this.doNotDisturb()) {
      this.last = null
      return { authorized: true, authorizedAt, paused: 'do-not-disturb', observation: null }
    }
    if (refresh || !this.last || now - this.last.observedAt > 60000) {
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

  context(now = Date.now()) {
    if (!this.authorized() || this.doNotDisturb()) return []
    return musicContext(this.last, now)
  }

  /**
   * 缓存是否够新（够新就不必再探一次 PowerShell）。
   * 与 status() 内部的复用阈值（60 秒）保持一致，改一处必须改另一处。
   */
  fresh(now = Date.now()) {
    return Boolean(this.last) && Number.isFinite(now - this.last.observedAt) &&
      now - this.last.observedAt <= 60000
  }
}
