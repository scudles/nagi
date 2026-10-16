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
      try { await this.inflight } catch (err) { this.last = null; throw err }
    }
    return this.authorized() ? { authorized: true, authorizedAt, observation: this.last } : { authorized: false, observation: null }
  }

  context(now = Date.now()) {
    if (!this.authorized() || this.doNotDisturb()) return []
    return musicContext(this.last, now)
  }
}
