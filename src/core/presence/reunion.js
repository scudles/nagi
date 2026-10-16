import { dayKey, presenceConfig } from './circadian.js'
export function createReunion({ now = Date.now, getConfig = () => ({}) } = {}) {
  let state={dayKey:null,count:0,lastAt:null}
  return {
    consider(segment) {
      const cfg=presenceConfig(getConfig()), at=now()
      if (!segment || !cfg.enabled || !cfg.reunionEnabled || !Number.isFinite(segment.since)) return null
      const durationMs=at-segment.since
      if (durationMs<cfg.reunionMinMs) return null
      // 时钟倒拨不重置日额度或间隔。
      if (state.lastAt!==null && at-state.lastAt<cfg.reunionCooldownMs) return null
      const day=dayKey(at)
      if (state.dayKey!==day) {state.dayKey=day;state.count=0}
      if (state.count>=cfg.dailyReunionLimit) return null
      state.count++;state.lastAt=at
      const tier=dayKey(segment.since)!==day?'cross-day':durationMs>=cfg.reunionHoursMs?'hours':durationMs>=cfg.reunionLongMs?'tens-of-minutes':'minutes'
      return {kind:'reunion',id:`reunion-${at}-${state.count}`,at,tier,durationMs,source:segment.source,
        activityIds:segment.activityIds||[],observationGap:!!segment.observationGap}
    },
    serialize:()=>({...state}),
    restore(data) { if(data && typeof data.dayKey==='string')state={dayKey:data.dayKey,count:Math.max(0,Math.min(3,Number(data.count)||0)),lastAt:Number.isFinite(data.lastAt)?data.lastAt:null} },
    clear() {state={dayKey:null,count:0,lastAt:null}}
  }
}
