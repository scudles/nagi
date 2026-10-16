export function createPresenceHooks() {
  let voiceProvider=null
  const providers=new Map(), presence=new Set(), actions=new Set()
  function subscribe(set,fn) {
    if(typeof fn!=='function'||set.size>=16)throw new Error('无效订阅或订阅过多')
    set.add(fn);return ()=>set.delete(fn)
  }
  function emit(set,event) {
    for(const fn of set) try { Promise.resolve(fn(structuredClone(event))).catch(()=>{}) } catch { /* 订阅者不能中断工具/状态机 */ }
  }
  return {
    registerVoiceParamsProvider(fn) {
      if(typeof fn!=='function')throw new Error('参数提供者必须为函数')
      voiceProvider=fn;return ()=>{if(voiceProvider===fn)voiceProvider=null}
    },
    resolveVoiceParams(input) {
      try {
        const r=voiceProvider?.(structuredClone(input))
        if(r?.then) {Promise.resolve(r).catch(()=>{});return null}
        if(!r||typeof r.voice!=='string'||r.voice.length>200||/[\x00-\x1f<>&"']/.test(r.voice))return null
        if(!Number.isFinite(r.rate)||Math.abs(r.rate)>50||!Number.isFinite(r.pitch)||Math.abs(r.pitch)>50||!Number.isFinite(r.volume)||r.volume<0||r.volume>100)return null
        return {voice:r.voice,rate:r.rate,pitch:r.pitch,volume:r.volume}
      } catch {return null}
    },
    registerProactiveProvider(id,fn) {
      if(typeof id!=='string'||!id||typeof fn!=='function'||providers.has(id)||providers.size>=4)throw new Error('主动提供者无效、重复或过多')
      providers.set(id,fn);return ()=>{if(providers.get(id)===fn)providers.delete(id)}
    },
    async provideProactiveContent({event,context,signal}) {
      for(const fn of providers.values()) {
        if(signal?.aborted)return null
        const controller=new AbortController()
        let timer
        const abort=()=>controller.abort()
        signal?.addEventListener('abort',abort,{once:true})
        try {
          const r=await Promise.race([
            Promise.resolve().then(()=>controller.signal.aborted?null:fn({event:structuredClone(event),context:structuredClone(context),signal:controller.signal})),
            new Promise(resolve=>{
              controller.signal.addEventListener('abort',()=>resolve(null),{once:true})
              timer=setTimeout(()=>controller.abort(),1000)
            })
          ])
          if(!signal?.aborted && r && typeof r.text==='string' && r.text.trim())return {text:r.text.trim().slice(0,500),mood:r.mood}
        } catch { /* 候选失败，继续下一个 */ }
        finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort)}
      }
      return null
    },
    subscribePresenceEvents:fn=>subscribe(presence,fn),
    subscribeActionTraces:fn=>subscribe(actions,fn),
    emitPresence:event=>emit(presence,event), emitAction:event=>emit(actions,event)
  }
}
