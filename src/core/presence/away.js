import { ACTIVITY_TYPES } from '../../shared/presence-protocol.js'
import { EMOTIONS } from '../../shared/protocol.js'
import { presenceConfig } from './circadian.js'

const MAX_GAP = 120000
export function createAway({ now = Date.now, getConfig = () => ({}) } = {}) {
  let state = 'present', since = null, source = null, lastTickAt = now(), sliceStart = now(), sequence = 0
  let activities = [], jumps = []
  const id = () => `presence-${now()}-${++sequence}`
  function prune() {
    const cfg = presenceConfig(getConfig()), cutoff = now()-cfg.retainDays*86400000
    activities = activities.filter(a => a.endedAt >= cutoff && a.endedAt <= now()).slice(-cfg.maxActivities)
    jumps = jumps.slice(-16)
  }
  function gap(from, reason) {
    const e = {kind:'time-jump',id:id(),from,to:now(),deltaMs:now()-from,reason,observed:false,activitiesBackfilled:false}
    jumps.push(e); jumps = jumps.slice(-16); sliceStart = now(); lastTickAt = now()
    return e
  }
  function leave({since: start = now(),source: why = 'idle'} = {}) {
    if (state !== 'present') return null
    state = 'away'; since = Math.min(now(),Number.isFinite(start)?start:now()); source = why
    sliceStart = now(); lastTickAt = now()
    return {kind:'away',id:id(),at:now(),since,source}
  }
  function tick(mood = {}) {
    prune()
    const delta = now()-lastTickAt
    if (delta < 0) { const event = gap(lastTickAt,'clock-backward'); state='present'; since=null; return [event] }
    if (state === 'suspended') return []
    if (delta > MAX_GAP) {
      const from = lastTickAt
      if (state === 'present') leave({since:from,source:'sampling-gap'})
      return [gap(from,'sampling-gap')]
    }
    lastTickAt = now()
    if (state !== 'away' || now()-sliceStart < presenceConfig(getConfig()).activitySliceMs) return []
    const entry = {id:id(),type:ACTIVITY_TYPES[(sequence-1)%ACTIVITY_TYPES.length],startedAt:sliceStart,endedAt:now(),
      mood:{mood:EMOTIONS.includes(mood.mood)?mood.mood:'calm',intensity:Number.isFinite(mood.intensity)?Math.max(0,Math.min(1,mood.intensity)):0},
      provenance:'simulation',canReference:true,deletedAt:null}
    sliceStart=now(); activities.push(entry); prune()
    return [{kind:'activity',at:now(),activity:structuredClone(entry)}]
  }
  function returnNow(why) {
    if (state === 'present') return null
    const segment = {since,until:now(),source:why,activityIds:activities.filter(a=>!a.deletedAt && a.startedAt>=since).map(a=>a.id),
      observationGap:jumps.some(j=>j.to>=since)}
    state='present'; since=null; source=null; lastTickAt=now(); sliceStart=now()
    return segment
  }
  function interrupt(reason = 'pause') {
    if (reason === 'suspend') {
      if (state === 'present') leave({source:'suspend'})
      state='suspended'; lastTickAt=now(); sliceStart=now()
    } else { state='present'; since=null; source=null; lastTickAt=now(); sliceStart=now() }
  }
  function serialize() { prune(); return structuredClone({state,since,source,lastTickAt,sliceStart,sequence,activities,jumps}) }
  function restore(data, savedAt = now()) {
    if (!data || !Number.isFinite(savedAt)) return []
    sequence = Math.max(0, Math.min(1e9,Number(data.sequence)||0))
    activities = (Array.isArray(data.activities)?data.activities:[]).slice(-96).filter(a=>
      typeof a?.id==='string' && a.id.length<=100 && ACTIVITY_TYPES.includes(a.type) && a.provenance==='simulation' &&
      Number.isFinite(a.startedAt) && Number.isFinite(a.endedAt) && a.startedAt<=a.endedAt && a.endedAt<=savedAt
    ).map(a=>({id:a.id,type:a.type,startedAt:a.startedAt,endedAt:a.endedAt,
      mood:{mood:EMOTIONS.includes(a.mood?.mood)?a.mood.mood:'calm',intensity:Math.max(0,Math.min(1,Number(a.mood?.intensity)||0))},
      provenance:'simulation',canReference:!a.deletedAt,deletedAt:Number.isFinite(a.deletedAt)?a.deletedAt:null}))
    jumps=(Array.isArray(data.jumps)?data.jumps:[]).slice(-16).filter(j=>
      typeof j?.id==='string'&&j.id.length<=100&&Number.isFinite(j.from)&&Number.isFinite(j.to)&&
      ['restart','suspend','sampling-gap','clock-backward'].includes(j.reason)
    ).map(j=>({kind:'time-jump',id:j.id,from:j.from,to:j.to,deltaMs:j.to-j.from,reason:j.reason,observed:false,activitiesBackfilled:false}))
    prune(); state='present'; since=null; lastTickAt=now(); sliceStart=now()
    if (savedAt>now()) return [gap(savedAt,'clock-backward')]
    if (now()-savedAt>0) {
      leave({since:Number.isFinite(data.since)?Math.min(savedAt,data.since):savedAt,source:'restart'})
      return [gap(savedAt,'restart')]
    }
    return []
  }
  function resume() { return state==='suspended' ? (state='away',[gap(lastTickAt,'suspend')]) : [] }
  return {leave,tick,returnNow,interrupt,resume,serialize,restore,
    snapshot:serialize,
    forget(key) { const a=activities.find(a=>a.id===key); if(!a)return false; a.deletedAt=now();a.canReference=false;return true },
    clear() { activities=[];jumps=[];interrupt() }
  }
}
