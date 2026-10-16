// 仅由双 SELFTEST 开关调用；用独立虚拟服务验证时间，不改生产 Date.now。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createPresenceService,getPresenceSnapshot,presenceInput,refreshPresence } from './presence.js'
import { createPresenceStore } from './presence-store.js'
import { presenceHooks } from './presence-hooks.js'
import { handleChatSend,stopActivityMonitor } from './agent.js'
import { companionStatus } from './companion.js'
import { getPetWindow,getWorkbenchWindow } from './windows.js'
import { getSettings } from './settings-store.js'

export async function runPresenceSelftest(directory) {
  const checks=[]
  const check=(name,ok)=>checks.push({name,ok:!!ok})
  const configuredNow=Number(process.env.NAGI_SELFTEST_PRESENCE_NOW)
  let now=Number.isFinite(configuredNow)?configuredNow:new Date(2026,9,16,9).getTime()
  let settings={presence:{},privacy:{}},events=[],reunions=[]
  const create=()=>createPresenceService({now:()=>now,getSettings:()=>settings,
    createStore:()=>createPresenceStore(join(directory,'presence-fixture')),
    onEvent:e=>events.push(e),onReunion:e=>reunions.push(e)})
  const s=create();s.start();s.observe({kind:'lock'})
  const advance=ms=>{for(let left=ms;left>0;){const step=Math.min(15000,left);now+=step;left-=step;s.tick()}}
  advance(600000);s.observe({kind:'unlock'})
  check('10min/runtime-simulation',reunions.at(-1)?.tier==='minutes'&&s.snapshot().activities.length===2)
  check('default-no-file',!existsSync(join(directory,'presence-fixture','presence.json')))
  settings.presence.persistActivities=true;s.refresh();s.observe({kind:'lock'});advance(7200000)
  s.observe({kind:'unlock'});s.flush()
  check('2hours',reunions.at(-1)?.tier==='hours')
  check('opt-in-file',existsSync(join(directory,'presence-fixture','presence.json')))
  const count=s.snapshot().activities.length;now+=86400000
  const restarted=create();restarted.start();restarted.observe({kind:'focus'})
  check('restart-no-backfill',restarted.snapshot().activities.length===count&&reunions.at(-1)?.tier==='cross-day')
  settings.presence.persistActivities=false;restarted.refresh()
  check('revoke-removes-file',!existsSync(join(directory,'presence-fixture','presence.json')))
  check('actual-runtime-rhythm',getPresenceSnapshot()?.rhythm?.awake===true)

  // 隔离此链路：启动时关闭采样，避免 M3 自测规则先消耗真实打扰预算。
  // 只给真实 presence 服务注入下方明确的测试输入，不重置/绕过 companion 预算。
  stopActivityMonitor()
  getSettings().privacy.monitorEnabled=true
  refreshPresence()
  const readyUntil=Date.now()+5000
  while(![getPetWindow(),getWorkbenchWindow()].some(w=>w?.isVisible())&&Date.now()<readyUntil)
    await new Promise(resolve=>setTimeout(resolve,100))
  check('actual-proactive-budget-available',companionStatus().allowed)

  const actions=[]
  const stopActions=presenceHooks.subscribeActionTraces(e=>actions.push(e))
  try {
    const result=await handleChatSend('检查当前授权的隔离测试目录')
    check('actual-agent-action-hook',result.ok&&actions.some(a=>a.tool==='file_list'&&a.status==='returned'&&!a.completionVerified))
  } finally {stopActions()}
  let timer
  const stopProvider=presenceHooks.registerProactiveProvider('selftest-reunion',()=>({text:'（自测）归来通道已连通。',mood:'calm'}))
  let stopEvent=()=>{}
  try {
    const delivered=new Promise(resolve=>{
      stopEvent=presenceHooks.subscribePresenceEvents(e=>{if(e.kind==='proactive-delivered')resolve(e)})
      timer=setTimeout(()=>resolve(null),3000)
    })
    presenceInput({kind:'idle',idleSec:600});presenceInput({kind:'idle',idleSec:0})
    check('actual-reunion-saySomething',!!await delivered)
    check('actual-default-no-file',!existsSync(join(directory,'presence.json')))
  } finally {clearTimeout(timer);stopProvider();stopEvent()}
  return {ok:checks.every(c=>c.ok),checks}
}
