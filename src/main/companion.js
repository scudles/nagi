import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { companionConfig, mayInterrupt, normalizeBudget, noteDelivered, noteExplicitIgnore, noteUserInteraction } from '../core/companion/budget.js'
import { dateKey } from '../core/journal.js'
import { getSettings } from './settings-store.js'

let state = null
const file = () => join(app.getPath('userData'), 'companion.json')

function load() {
  if (state) return state
  let raw = {}
  try { if (existsSync(file())) raw = JSON.parse(readFileSync(file(), 'utf8')) } catch {
    const now = Date.now()
    raw = { day: dateKey(now), deliveredToday: 10, nextAllowedAt: now + 86400000 }
  }
  state = normalizeBudget(raw)
  return state
}

function save(next) {
  const temp = file() + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(next), 'utf8')
  renameSync(temp, file())
  state = next
  return next
}

export function companionStatus() {
  const settings = getSettings()
  const check = mayInterrupt(load(), { privacy: settings.privacy, config: settings.companion })
  if (JSON.stringify(check.state) !== JSON.stringify(state)) save(check.state)
  return { ...check, config: companionConfig(settings.companion) }
}

export function companionDelivered(now = Date.now()) {
  return save(noteDelivered(load(), now, getSettings().companion))
}

export function companionInteracted(now = Date.now()) {
  return save(noteUserInteraction(load(), now))
}

export function companionIgnored(now = Date.now()) {
  return save(noteExplicitIgnore(load(), now, getSettings().companion))
}
