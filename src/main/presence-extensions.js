import { registerVoiceParamsProvider,registerProactiveProvider,subscribePresenceEvents,subscribeActionTraces } from './presence-hooks.js'
import { getPresenceSnapshot } from './presence.js'

// 蓝区只需添加 extensions/*.js 的 install(api)，不必修改红区编排文件。
export function installPresenceExtensions() {
  const modules=import.meta.glob('./extensions/*.js',{eager:true})
  const disposers=[]
  const api=Object.freeze({registerVoiceParamsProvider,registerProactiveProvider,subscribePresenceEvents,subscribeActionTraces,getPresenceSnapshot})
  for(const key of Object.keys(modules).sort()) {
    try {const stop=modules[key].install?.(api);if(typeof stop==='function')disposers.push(stop)}
    catch(e) {console.warn('[presence] 扩展注册失败',key,e.message)}
  }
  return ()=>{for(const stop of disposers.reverse())try{stop()}catch{ /* B8:degrade — 退出时卸载扩展失败 */ }}
}
