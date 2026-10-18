import { createPresenceEngine } from '../core/presence/engine.js'
import { presenceConfig } from '../core/presence/circadian.js'
import { collectionAllowed } from '../core/monitor/privacy.js'

let active=null
export function setPresenceService(service) {active=service}
export function getPresenceSnapshot() {return active?.snapshot()||null}
export function clearPresence() {return active?.clear()||{ok:true}}
export function refreshPresence() {active?.refresh()}
export function presenceInput(input) {return active?.observe(input)}

export function createPresenceService({now=Date.now,getSettings=()=>({}),getMood=()=>({}),createStore,
  onEvent=()=>{},onReunion=()=>{},onRhythm=()=>{},onChange=()=>{}}={}) {
  const getConfig=()=>getSettings().presence||{}
  const engine=createPresenceEngine({now,getConfig})
  let started=false, persistent=false, store=null, lastSave=0, error=null, epoch=0, writeBlocked=false, lastGuard=''
  const disk=()=>store||(store=createStore())
  const allowed=()=>presenceConfig(getConfig()).enabled && collectionAllowed(getSettings().privacy||{})
  function guardIO(fn) {try{fn();error=null;return true}catch(e){error=e.message;return false}}
  function save(force=false) {
    if(persistent&&!writeBlocked&&(force||now()-lastSave>=60000))if(guardIO(()=>disk().save(engine.serialize())))lastSave=now()
  }
  function snapshot() {return {...engine.snapshot(),mood:getMood(),persistent,persistenceError:error,epoch}}
  function refresh() {
    if(!started)return
    const config=presenceConfig(getConfig()), privacy=getSettings().privacy||{}
    // C4：titleOutbound 也是授权开关，改了必须让 epoch 变——否则采样之后、
    // 出站之前的那一跳会拿旧授权把标题发出去（契约 §6.3）。
    const guard=JSON.stringify([config.enabled,config.awayEnabled,config.reunionEnabled,privacy.monitorEnabled,privacy.titleOutbound,privacy.doNotDisturb,privacy.onlyPresence,privacy.blacklist])
    if(guard!==lastGuard) {epoch++;lastGuard=guard}
    const next=config.persistActivities
    if(next!==persistent) {
      epoch++;engine.clear();persistent=next
      if(next) {writeBlocked=false;save(true)}
      else if(guardIO(()=>disk().clear()))writeBlocked=false
    }
    if(!allowed()||!config.awayEnabled) engine.pause()
    onRhythm(engine.snapshot().rhythm)
  }
  function dispatch(events) {
    for(const event of events) {
      onEvent(event)
      if(event.kind==='reunion')Promise.resolve(onReunion(event)).catch(()=>{})
    }
    save(events.length>0)
    onChange(snapshot())
    return events
  }
  return {
    start() {
      if(started)return
      started=true;persistent=presenceConfig(getConfig()).persistActivities
      const events=[]
      if(persistent)writeBlocked=!guardIO(()=>events.push(...engine.restore(disk().load())))
      refresh();dispatch(events)
    },
    tick() {refresh();return dispatch(allowed()?engine.tick(getMood()):[])},
    observe(input) {
      refresh()
      if(!allowed())return []
      const events=engine.observe(input,getMood())
      // 新离开/休眠或黑名单样本使正在生成的归来内容失效。
      if(input?.kind==='pause'||input?.kind==='suspend'||events.some(e=>e.kind==='away'))epoch++
      return dispatch(events)
    },
    refresh, snapshot, allowed,
    flush:()=>save(true),
    clear() {epoch++;engine.clear();const ok=guardIO(()=>disk().clear());if(ok)writeBlocked=false;onChange(snapshot());return {ok,...(!ok?{error}:{} )}},
    forget(id) {const changed=engine.forget(id);if(changed){epoch++;save(true);onEvent({kind:'activity-forgotten',id,at:now()});onChange(snapshot())}return changed}
  }
}
