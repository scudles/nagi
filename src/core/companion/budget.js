import { dateKey } from '../journal.js'

const IGNORE_AFTER_MS = 20 * 60000

export function companionConfig(raw = {}) {
  const maxDaily = Number(raw.maxDaily)
  const minGapMinutes = Number(raw.minGapMinutes)
  return {
    maxDaily: Number.isFinite(maxDaily) ? Math.max(0, Math.min(10, Math.floor(maxDaily))) : 3,
    minGapMinutes: Number.isFinite(minGapMinutes) ? Math.max(15, Math.min(720, Math.floor(minGapMinutes))) : 90
  }
}

export function normalizeBudget(raw = {}, now = Date.now()) {
  const day = dateKey(now)
  return {
    day,
    deliveredToday: raw.day === day && Number.isFinite(raw.deliveredToday) ? Math.max(0, raw.deliveredToday) : 0,
    ignoredStreak: Number.isFinite(raw.ignoredStreak) ? Math.max(0, Math.min(6, raw.ignoredStreak)) : 0,
    awaitingAt: Number.isFinite(raw.awaitingAt) ? raw.awaitingAt : null,
    lastUserAt: Number.isFinite(raw.lastUserAt) ? raw.lastUserAt : null,
    lastProactiveAt: Number.isFinite(raw.lastProactiveAt) ? raw.lastProactiveAt : null,
    nextAllowedAt: Number.isFinite(raw.nextAllowedAt) ? raw.nextAllowedAt : 0
  }
}

export function settleIgnored(raw, now = Date.now(), cfg = companionConfig()) {
  const state = normalizeBudget(raw, now)
  if (state.awaitingAt && now - state.awaitingAt >= IGNORE_AFTER_MS &&
      (!state.lastUserAt || state.lastUserAt <= state.awaitingAt)) {
    state.ignoredStreak = Math.min(6, state.ignoredStreak + 1)
    state.nextAllowedAt = Math.max(state.nextAllowedAt,
      state.awaitingAt + cfg.minGapMinutes * 60000 * 2 ** state.ignoredStreak)
    state.awaitingAt = null
  }
  return state
}

export function mayInterrupt(raw, { now = Date.now(), privacy = {}, config = {}, busy = false } = {}) {
  const cfg = companionConfig(config)
  const state = settleIgnored(raw, now, cfg)
  if (privacy.doNotDisturb === true) return { allowed: false, reason: 'dnd', state }
  if (privacy.onlyPresence === true) return { allowed: false, reason: 'only-presence', state }
  if (busy) return { allowed: false, reason: 'busy', state }
  if (state.deliveredToday >= cfg.maxDaily) return { allowed: false, reason: 'daily-budget', state }
  if (now < state.nextAllowedAt) return { allowed: false, reason: 'backoff', state }
  return { allowed: true, reason: '', state }
}

export function noteDelivered(raw, now = Date.now(), config = {}) {
  const cfg = companionConfig(config)
  const state = settleIgnored(raw, now, cfg)
  state.deliveredToday++
  state.lastProactiveAt = now
  state.awaitingAt = now
  state.nextAllowedAt = now + cfg.minGapMinutes * 60000 * 2 ** state.ignoredStreak
  return state
}

export function noteUserInteraction(raw, now = Date.now()) {
  const state = normalizeBudget(raw, now)
  state.lastUserAt = now
  state.awaitingAt = null
  state.ignoredStreak = 0
  return state
}

export function noteExplicitIgnore(raw, now = Date.now(), config = {}) {
  const cfg = companionConfig(config)
  const state = normalizeBudget(raw, now)
  if (!state.awaitingAt) return state
  state.ignoredStreak = Math.min(6, state.ignoredStreak + 1)
  state.nextAllowedAt = Math.max(state.nextAllowedAt,
    now + cfg.minGapMinutes * 60000 * 2 ** state.ignoredStreak)
  state.awaitingAt = null
  return state
}
