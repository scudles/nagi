import {test,mock} from 'node:test'
import assert from 'node:assert/strict'
const calls=[]
let settings={presence:{voiceProfileEnabled:true},voice:{ttsEngine:'edge',voiceByEngine:{edge:'unchanged-voice'},rate:0,volume:85}}
mock.module('electron',{exports:{app:{getPath:()=>''}}})
mock.module('../src/main/settings-store.js',{exports:{getSettings:()=>settings}})
mock.module('../src/main/voice/edge.js',{exports:{EDGE_DEFAULT_VOICE:'fallback',edgeSpeakOnce:async args=>{calls.push(args);return {ok:true,bytes:Buffer.from('audio')}}}})
mock.module('../src/main/voice/sapi.js',{exports:{sapiSpeak:async()=>({ok:false}),sapiRecognize:()=>{},listSapiVoices:()=>[],listRecognizers:()=>[],sapiAsrAvailable:()=>false}})
mock.module('../src/main/voice/sherpa.js',{exports:Object.fromEntries(['recognizeWithSherpa','sherpaStatus','sherpaServerState','stopSherpaServer','prewarmSherpa','downloadSherpa','downloadSherpaCli','downloadSherpaModel'].map(k=>[k,()=>({})]))})
const voice=await import('../src/main/voice/index.js')
test('真实语音编排：provider 成功应用，异常/null/关闭回退既有参数，试听覆盖优先',async()=>{
  await voice.synthesizeOnce('验证声音',{mood:'calm'})
  const baseline={...calls.at(-1)}
  const remove=voice.registerVoiceParamsProvider(()=>({voice:'',rate:12,pitch:4,volume:70}))
  await voice.synthesizeOnce('验证声音',{mood:'calm'})
  assert.equal(calls.at(-1).rate,12);assert.equal(calls.at(-1).voice,'unchanged-voice')
  await voice.synthesizeOnce('验证声音',{mood:'calm',rate:3,volume:80,voice:'explicit'})
  assert.equal(calls.at(-1).voice,'explicit');assert.equal(calls.at(-1).volume,80)
  remove()
  voice.registerVoiceParamsProvider(()=>{throw Error('mapping error')})
  await voice.synthesizeOnce('验证声音',{mood:'calm'});assert.deepEqual(calls.at(-1),baseline)
  voice.registerVoiceParamsProvider(()=>({voice:'different',rate:12,pitch:4,volume:70}))
  settings={...settings,presence:{voiceProfileEnabled:false}}
  await voice.synthesizeOnce('验证声音',{mood:'calm'});assert.deepEqual(calls.at(-1),baseline)
})
