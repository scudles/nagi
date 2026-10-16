import { spawn } from 'node:child_process'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'

const root=resolve(import.meta.dirname,'..')
const data=mkdtempSync(join(tmpdir(),'nagi-presence-e2e-'))
writeFileSync(join(data,'settings.json'),JSON.stringify({
  llm:{provider:'custom',model:'fixture'},tools:{fileRoot:data},voice:{ttsEnabled:false,asrEngine:'sapi'},
  privacy:{noticeShown:true,monitorEnabled:false,doNotDisturb:false},presence:{persistActivities:false}
}))
const env={...process.env,NAGI_SELFTEST:'1',NAGI_SELFTEST_PRESENCE:'1',NAGI_FAKE_LLM:'1',NAGI_FAKE_DIARY:'1',
  NAGI_NO_PREWARM:'1',NAGI_SELFTEST_MONITOR:'1',NAGI_MODE:'workbench'}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),['.',`--user-data-dir=${data}`],
  {cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true})
let output='',timedOut=false
child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
const timer=setTimeout(()=>{timedOut=true;child.kill()},30000)
const result=await new Promise(resolve=>{child.on('error',e=>resolve({error:e.message}));child.on('close',code=>resolve({code}))})
clearTimeout(timer)
const line=output.split(/\r?\n/).find(l=>l.startsWith('[presence:selftest] '))
let report
try {report=JSON.parse(line?.slice('[presence:selftest] '.length)||'null')}catch{}
if(report?.checks)for(const check of report.checks)console.log(`${check.ok?'PASS':'FAIL'} ${check.name}`)
const ok=result.code===0&&!timedOut&&report?.ok
console.log(JSON.stringify({ok:!!ok,exitCode:result.code,timedOut,checks:report?.checks?.length||0,error:report?.error||result.error||null}))
if(!ok)console.log(output.slice(-7000))
// 只删除本脚本创建并验证仍在临时根下的目录，不使用另一 shell 拼接路径。
if(resolve(data).startsWith(resolve(tmpdir())+sep))try{rmSync(data,{recursive:true,force:true})}catch(e){console.warn('临时目录待清理：'+data+' '+e.code)}
process.exitCode=ok?0:1
