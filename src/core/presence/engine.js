import { createCircadian, presenceConfig } from './circadian.js'
import { createAway } from './away.js'
import { createReunion } from './reunion.js'

export function createPresenceEngine({ now=Date.now, getConfig=()=>({}) }={}) {
  const deps={now,getConfig}, rhythm=createCircadian(deps), away=createAway(deps), reunion=createReunion(deps)
  function enabled() {const c=presenceConfig(getConfig());return c.enabled&&c.awayEnabled}
  return {
    tick(mood) { if(!enabled()){away.interrupt();return []}return away.tick(mood) },
    observe(input, mood) {
      if (!enabled() || !input || input.kind==='pause') {away.interrupt();return []}
      const events=[]
      if (input.kind==='suspend') {away.interrupt('suspend');return events}
      if (['resume','unlock','focus'].includes(input.kind) && away.snapshot().state==='suspended') events.push(...away.resume())
      else events.push(...away.tick(mood))
      if (input.kind==='lock' || (input.kind==='idle' && Number.isFinite(input.idleSec) && input.idleSec*1000>=presenceConfig(getConfig()).idleAfterMs)) {
        const e=away.leave({since:input.kind==='idle'?now()-Math.min(input.idleSec*1000,86400000):now(),source:input.kind})
        if(e)events.push(e)
      } else if (['idle','unlock','focus','resume'].includes(input.kind) && (input.kind!=='idle'||Number.isFinite(input.idleSec))) {
        const e=reunion.consider(away.returnNow(input.kind==='idle'?'idle-end':input.kind))
        if(e)events.push(e)
      }
      return events
    },
    snapshot() { const data=away.snapshot();return {rhythm:rhythm.current(),away:{state:data.state,since:data.since,source:data.source},activities:data.activities,jumps:data.jumps} },
    serialize:()=>({version:1,savedAt:now(),away:away.serialize(),reunion:reunion.serialize()}),
    restore(data) {if(data?.version!==1)return [];reunion.restore(data.reunion);return away.restore(data.away,data.savedAt)},
    pause:()=>away.interrupt(), forget:away.forget,
    clear() {away.clear();reunion.clear()}
  }
}
