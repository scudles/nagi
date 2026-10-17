import test from 'node:test'
import assert from 'node:assert/strict'
import { createCircadian, presenceConfig } from '../src/core/presence/circadian.js'
import { createPresenceEngine } from '../src/core/presence/engine.js'
import { createPresenceHooks } from '../src/core/presence/hooks.js'
import { createMood } from '../src/core/emotion/mood.js'
import { buildContextBlock } from '../src/core/context.js'
import { buildDiaryMessages } from '../src/core/diary.js'
import { createMonitorEngine } from '../src/core/monitor/engine.js'

const minute=60000
const at=(day,hour,min=0)=>new Date(2026,9,day,hour,min).getTime()
function fixture(start=at(16,9),config={}) {
  let time=start
  const engine=createPresenceEngine({now:()=>time,getConfig:()=>config})
  return {engine,now:()=>time,set:t=>time=t,
    advance(ms) {const events=[];for(let left=ms;left>0;) {const step=Math.min(15000,left);time+=step;left-=step;events.push(...engine.tick({mood:'calm',intensity:0.1}))}return events}}
}

test('节律遍历整周全部分钟：覆盖无空洞，周末早晨延后，永不生理困倦',()=>{
  let time=0;const rhythm=createCircadian({now:()=>time})
  const seen=new Set()
  for(let day=16;day<23;day++)for(let m=0;m<1440;m++) {
    time=at(day,0,m);const s=rhythm.current();seen.add(s.period)
    assert.equal(s.awake,true);assert.equal(s.physiologicalSleepiness,false);assert.equal(s.simulated,true)
    if(m===450)assert.equal(s.period,[17,18].includes(day)?'night':'morning')
  }
  assert.deepEqual([...seen].sort(),['afternoon','evening','morning','night','noon'])
})
test('时段配置损坏安全回退；自定义时段和总开关有效',()=>{
  const invalid={weekdaySchedule:[[30,1440,'morning']],dailyReunionLimit:999,maxActivities:999}
  assert.equal(presenceConfig(invalid).weekdaySchedule[0][0],0)
  assert.equal(presenceConfig(invalid).dailyReunionLimit,3)
  assert.equal(presenceConfig(invalid).maxActivities,96)
  const r=createCircadian({now:()=>at(16,14),getConfig:()=>({weekdaySchedule:[[0,1440,'evening']]})})
  assert.equal(r.current().period,'evening')
  assert.equal(createCircadian({getConfig:()=>({enabled:false})}).current().enabled,false)
})
for(const [duration,tier] of [[4,'none'],[10,'minutes'],[30,'tens-of-minutes'],[120,'hours']]) {
  test(`离开 ${duration} 分钟：${tier}；有效运行才产生模拟活动`,()=>{
    const f=fixture();f.engine.observe({kind:'lock'});const events=f.advance(duration*minute)
    const reunion=f.engine.observe({kind:'unlock'}).find(e=>e.kind==='reunion')
    assert.equal(reunion?.tier,tier==='none'?undefined:tier)
    assert.equal(events.filter(e=>e.kind==='activity').length,Math.floor(duration/5))
    for(const a of f.engine.snapshot().activities) {assert.equal(a.provenance,'simulation');assert.equal(a.canReference,true)}
    assert.equal(f.engine.observe({kind:'focus'}).filter(e=>e.kind==='reunion').length,0)
  })
}
test('idle 的历史空闲时间不补造活动；有效后续时间片才可引用',()=>{
  const f=fixture();f.engine.observe({kind:'idle',idleSec:600})
  assert.equal(f.engine.snapshot().activities.length,0)
  f.advance(5*minute)
  const r=f.engine.observe({kind:'idle',idleSec:0}).find(e=>e.kind==='reunion')
  assert.equal(r.durationMs,15*minute);assert.equal(r.activityIds.length,1)
})
test('关机跨日只产生时间缺口，跨重启归来引用既有记录且不回填',()=>{
  const f=fixture(at(16,22));f.engine.observe({kind:'lock'});f.advance(10*minute)
  const saved=f.engine.serialize();const g=fixture(at(17,9))
  const events=g.engine.restore(saved)
  assert.equal(events[0].kind,'time-jump');assert.equal(events[0].reason,'restart')
  assert.equal(events[0].activitiesBackfilled,false)
  assert.equal(g.engine.snapshot().activities.length,2)
  const r=g.engine.observe({kind:'focus'}).find(e=>e.kind==='reunion')
  assert.equal(r.tier,'cross-day');assert.equal(r.observationGap,true)
})
test('休眠/长停顿/时钟倒拨：不生成虚构时间片',()=>{
  const f=fixture();f.engine.observe({kind:'lock'});f.advance(5*minute)
  f.engine.observe({kind:'suspend'});f.set(at(16,12))
  f.engine.tick();assert.equal(f.engine.snapshot().activities.length,1)
  const resume=f.engine.observe({kind:'unlock'})
  assert.equal(resume.find(e=>e.kind==='time-jump').reason,'suspend')
  assert.equal(resume.find(e=>e.kind==='reunion').tier,'hours')
  f.set(at(16,8));const rewind=f.engine.tick()
  assert.equal(rewind[0].reason,'clock-backward');assert.equal(f.engine.snapshot().away.state,'present')
  assert.equal(f.engine.observe({kind:'focus'}).length,0)
})
test('归来间隔和每日上限跨装载有效；不会因重复信号叠加',()=>{
  const f=fixture();let count=0
  for(let i=0;i<5;i++) {f.engine.observe({kind:'lock'});f.advance(31*minute);count+=f.engine.observe({kind:'unlock'}).filter(e=>e.kind==='reunion').length}
  assert.equal(count,3)
  const g=fixture(f.now()+31*minute);g.engine.restore(f.engine.serialize())
  assert.equal(g.engine.observe({kind:'focus'}).filter(e=>e.kind==='reunion').length,0)
  const short=fixture();short.engine.observe({kind:'lock'});short.advance(10*minute);short.engine.observe({kind:'unlock'})
  short.engine.observe({kind:'lock'});short.advance(10*minute)
  assert.equal(short.engine.observe({kind:'unlock'}).filter(e=>e.kind==='reunion').length,0)
})
test('活动上限/保留期/忘记；权限暂停后的离开不补报',()=>{
  const f=fixture(at(16,9),{maxActivities:2,retainDays:1});f.engine.observe({kind:'lock'});f.advance(30*minute)
  const list=f.engine.snapshot().activities;assert.equal(list.length,2)
  f.engine.forget(list[0].id);assert.equal(f.engine.snapshot().activities[0].canReference,false)
  f.engine.observe({kind:'pause'});assert.equal(f.engine.observe({kind:'unlock'}).length,0)
  f.set(at(18,9));f.engine.tick();assert.equal(f.engine.snapshot().activities.length,0)
})
test('情绪节律注入不伪造互动、不覆盖强情绪；context/日记明确清醒与模拟边界',()=>{
  let time=at(16,13);const mood=createMood({now:()=>time});const r=createCircadian({now:()=>time}).current()
  const before=mood.serialize().lastInteraction;mood.applyRhythm(r);time+=15000;mood.tick()
  assert.equal(mood.serialize().lastInteraction,before)
  mood.propose('joy',1);mood.applyRhythm({...r,period:'night',moodPush:{mood:'worry',weight:0.45}});mood.tick()
  assert.equal(mood.current().mood,'joy')
  const content=buildContextBlock({rhythm:r,activities:[{id:'x',type:'quiet-wait',startedAt:1,endedAt:2,provenance:'simulation',canReference:true}]})
  assert.match(content,/仍清醒/);assert.match(content,/不是外界感知/)
  assert.match(buildDiaryMessages({rhythm:r})[1].content,/没有生理困倦/)
})
test('M3 观察出口只带闲置秒数与活动分类，标题/应用名不外传',async()=>{
  let privacy={monitorEnabled:true},got=[]
  const engine=createMonitorEngine({sampler:{sample:async()=>({ts:1,idleSec:600,title:'private-title',app:'Code'})},getPrivacy:()=>privacy,
    onPresenceSample:s=>got.push(s),rules:[]})
  await engine.tickOnce()
  const s=got[0]
  assert.equal(s.ts,1)
  assert.equal(s.idleSec,600)
  // 2026-10-17 增：多了一个活动分类（「她想一下再表现」要用），
  // 但它只能是 6 个枚举之一 —— 分类是"在工作/看视频"这个级别，不含任何可识别内容。
  assert.ok(['work','video','gaming','social','browser','other'].includes(s.category),`分类必须是枚举值，实际 ${s.category}`)
  // 实质检查：出口上不能出现标题、应用名，也不能出现它们的原文
  assert.equal('title' in s,false,'观察出口不该带窗口标题')
  assert.equal('app' in s,false,'观察出口不该带应用名')
  const dumped=JSON.stringify(s)
  assert.equal(dumped.includes('private-title'),false,'标题原文泄露到观察出口')
  assert.equal(dumped.includes('Code'),false,'应用名泄露到观察出口')
  assert.deepEqual(Object.keys(s).sort(),['category','idleSec','ts'],`出口字段应恰好是这三项，实际 ${Object.keys(s).join(',')}`)
  privacy={doNotDisturb:true};await engine.tickOnce();assert.equal(got.at(-1),null)
})
test('voice hook 不含映射：null/异常/Promise/非法值安全回退，注销不误删新提供者',()=>{
  const h=createPresenceHooks();assert.equal(h.resolveVoiceParams({}),null)
  for(const fn of [()=>null,()=>{throw Error('x')},()=>Promise.reject(Error('x')),()=>({voice:'x',rate:99,pitch:0,volume:90})]) {
    h.registerVoiceParamsProvider(fn);assert.equal(h.resolveVoiceParams({}),null)
  }
  const old=h.registerVoiceParamsProvider(()=>null)
  h.registerVoiceParamsProvider(()=>({voice:'',rate:0,pitch:0,volume:100}));old()
  assert.equal(h.resolveVoiceParams({}).volume,100)
})
test('主动提供者取消/异常与订阅者隔离；无提供者不生成业务内容',async()=>{
  const h=createPresenceHooks();assert.equal(await h.provideProactiveContent({event:{},context:''}),null)
  h.registerProactiveProvider('broken',()=>{throw Error('broken')})
  h.registerProactiveProvider('ok',()=>({text:'fixture'}))
  assert.equal((await h.provideProactiveContent({event:{},context:''})).text,'fixture')
  const c=new AbortController();c.abort();assert.equal(await h.provideProactiveContent({event:{},context:'',signal:c.signal}),null)
  const seen=[];h.subscribeActionTraces(e=>{e.ok=false;throw Error('listener')});h.subscribeActionTraces(e=>seen.push(e))
  h.emitAction({ok:true});assert.deepEqual(seen,[{ok:true}])
})
test('主动提供者悬挂时取消立即结束',async()=>{
  const h=createPresenceHooks(),c=new AbortController()
  h.registerProactiveProvider('pending',()=>new Promise(()=>{}))
  const pending=h.provideProactiveContent({event:{},context:'',signal:c.signal});c.abort()
  assert.equal(await pending,null)
})
