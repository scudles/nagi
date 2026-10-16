import { PERIODS, PRESENCE_DEFAULTS as D } from '../../shared/presence-protocol.js'

export function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function schedule(value, fallback) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) return fallback
  let end = 0
  for (const row of value) {
    if (!Array.isArray(row) || row[0] !== end || !Number.isInteger(row[1]) || row[1] <= end || row[1] > 1440 || !PERIODS.includes(row[2])) return fallback
    end = row[1]
  }
  return end === 1440 ? value : fallback
}
export function presenceConfig(raw = {}) {
  raw ||= {}
  const cfg = structuredClone(D)
  for (const key of Object.keys(cfg)) if (typeof cfg[key] === 'boolean' && typeof raw[key] === 'boolean') cfg[key] = raw[key]
  const bounded = (key, min, max) => { if (Number.isFinite(raw[key])) cfg[key] = Math.max(min, Math.min(max, Math.floor(raw[key]))) }
  bounded('idleAfterMs',120000,3600000); bounded('activitySliceMs',300000,3600000)
  bounded('reunionMinMs',300000,1800000); bounded('reunionLongMs',1800000,5400000)
  bounded('reunionHoursMs',5400000,86400000); bounded('reunionCooldownMs',1800000,86400000)
  bounded('dailyReunionLimit',0,3); bounded('retainDays',1,7); bounded('maxActivities',1,96)
  if (cfg.reunionMinMs >= cfg.reunionLongMs || cfg.reunionLongMs >= cfg.reunionHoursMs) {
    for (const key of ['reunionMinMs','reunionLongMs','reunionHoursMs']) cfg[key] = D[key]
  }
  for (const key of ['weekdaySchedule','weekendSchedule']) cfg[key] = schedule(raw[key],cfg[key])
  return cfg
}
export function createCircadian({ now = Date.now, getConfig = () => ({}) } = {}) {
  return { current() {
    const at = now(), d = new Date(at), cfg = presenceConfig(getConfig())
    const dayType = [0,6].includes(d.getDay()) ? 'weekend' : 'weekday'
    const minute = d.getHours()*60 + d.getMinutes()
    const period = cfg[dayType+'Schedule'].find(([from,to]) => minute >= from && minute < to)[2]
    const enabled = cfg.enabled && cfg.rhythmEnabled
    const night = enabled && period === 'night', afternoon = enabled && period === 'afternoon'
    return { version:1, at, enabled, dayKey:dayKey(at), dayType, period,
      simulated:true, awake:true, physiologicalSleepiness:false,
      behavior:{pace:night?'quiet':afternoon?'unhurried':'steady',replyLength:night?'short':'normal',proactiveScale:night?0.5:1},
      recommendations:{rate:night||afternoon?'slower':'default',volume:night?'lower':'default',expression:night?'worry':'calm',motion:night?'quiet':afternoon?'unhurried':'neutral'},
      moodPush:night?{mood:'worry',weight:0.45}:afternoon?{mood:'calm',weight:0.15}:null }
  } }
}
