import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'
import { createPresenceService } from '../src/main/presence.js'
import { createPresenceStore } from '../src/main/presence-store.js'

function directory(t) {
  const dir=mkdtempSync(join(tmpdir(),'nagi-presence-'))
  t.after(()=>{if(resolve(dir).startsWith(resolve(tmpdir())+sep))rmSync(dir,{recursive:true,force:true})})
  return dir
}
test('默认仅内存；开启不回填；开启后持久化可跨重启；关闭删除本模块文件',t=>{
  const dir=directory(t);let now=new Date(2026,9,16,9).getTime(),settings={presence:{},privacy:{}},opened=0
  const make=()=>createPresenceService({now:()=>now,getSettings:()=>settings,
    createStore:()=>{opened++;return createPresenceStore(dir)}})
  const s=make();s.start();s.observe({kind:'lock'})
  for(let i=0;i<40;i++){now+=15000;s.tick()}
  assert.equal(s.snapshot().activities.length,2);assert.equal(opened,0);assert.equal(existsSync(join(dir,'presence.json')),false)
  settings.presence.persistActivities=true;s.refresh()
  assert.equal(s.snapshot().activities.length,0)
  s.observe({kind:'lock'});for(let i=0;i<40;i++){now+=15000;s.tick()}s.flush()
  const saved=JSON.parse(readFileSync(join(dir,'presence.json'),'utf8'));assert.equal(saved.away.activities.length,2)
  now+=86400000;const next=make();next.start();assert.equal(next.snapshot().activities.length,2)
  assert.equal(next.snapshot().jumps.at(-1).reason,'restart')
  settings.presence.persistActivities=false;next.refresh();assert.equal(existsSync(join(dir,'presence.json')),false)
  assert.equal(next.snapshot().activities.length,0)
})
test('默认不开旧文件；损坏文件报告错误；关闭后不重放旧归来',t=>{
  const dir=directory(t);writeFileSync(join(dir,'presence.json'),'broken')
  let settings={presence:{},privacy:{}};let opens=0
  const create=()=>createPresenceService({getSettings:()=>settings,createStore:()=>{opens++;return createPresenceStore(dir)}})
  const off=create();off.start();assert.equal(opens,0)
  settings.presence.persistActivities=true;const on=create();on.start()
  // 加载失败不得静默声称已恢复；由状态 IPC 交给 UI 展示。
  assert.equal(on.snapshot().activities.length,0)
  assert.ok(on.snapshot().persistenceError)
  assert.equal(readFileSync(join(dir,'presence.json'),'utf8'),'broken')
  settings.privacy.doNotDisturb=true;on.refresh();assert.equal(on.observe({kind:'unlock'}).length,0)
})
test('写失败报告在快照，默认不进行任何磁盘调用；clear 同步报告失败',()=>{
  const s=createPresenceService({getSettings:()=>({presence:{persistActivities:true}}),
    createStore:()=>({load:()=>null,save:()=>{throw Error('disk full')},clear:()=>{throw Error('locked')}})})
  s.start();assert.match(s.snapshot().persistenceError,/disk full/)
  assert.equal(s.clear().ok,false);assert.match(s.snapshot().persistenceError,/locked/)
})
test('core/service 无自建周期 timer；隐私禁止后不新增活动',()=>{
  let now=1000000000,settings={presence:{},privacy:{}}
  const s=createPresenceService({now:()=>now,getSettings:()=>settings,createStore:()=>{throw Error('unexpected IO')}})
  s.start();s.observe({kind:'lock'});settings.privacy.onlyPresence=true
  for(let i=0;i<1000;i++){now+=15000;s.tick()}
  assert.equal(s.snapshot().activities.length,0);assert.equal(s.snapshot().away.state,'present')
})
test('隐私暂停、再离开和配置撤销让已取走的归来快照失效',()=>{
  let settings={presence:{},privacy:{monitorEnabled:true}}
  const service=createPresenceService({getSettings:()=>settings})
  service.start()
  let epoch=service.snapshot().epoch
  service.observe({kind:'pause'});assert.ok(service.snapshot().epoch>epoch)
  epoch=service.snapshot().epoch
  service.observe({kind:'lock'});assert.ok(service.snapshot().epoch>epoch)
  epoch=service.snapshot().epoch
  settings.presence.awayEnabled=false;service.refresh()
  assert.ok(service.snapshot().epoch>epoch);assert.equal(service.snapshot().away.state,'present')
  epoch=service.snapshot().epoch;service.tick();assert.equal(service.snapshot().epoch,epoch)
})
