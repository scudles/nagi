// scripts/verify-user-livefeel.mjs
//
// 真机验收：拿**用户本机那份 settings.json** 直接喂给真实的决策函数，
// 问一句「这些开关到底生不生效」，而不是只看配置值是不是 true。
//
// 为什么需要它：D49 修的是「假开」——界面勾着开关，底下概率却是 0，
// 于是界面显示「已开启」而行为上一次都不会发生。只断言 enabled===true 等于没验，
// 必须让真实函数跑一遍，看到它真的产出 defer / 真的发出语气音才算数。
//
// 用法：node scripts/verify-user-livefeel.mjs
// 退出码 0 = 全部生效；1 = 有项名开实不开。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decideOptionalFollowup } from '../src/core/presence/imperfection.js'
import { decideBackchannel, emptyBackchannelState } from '../src/core/voice/backchannel.js'

const SETTINGS = path.join(process.env.APPDATA || '', '凪 Nagi', 'settings.json')

let settings
try {
  settings = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
} catch (err) {
  console.error('读不到本机的 settings.json：', SETTINGS, err.message)
  process.exit(1)
}

const presence = settings?.presence || {}
const voice = settings?.voice || {}
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0)
const LOW = (id) => ({ id, level: 'low-risk', reason: 'optional-chat', sourceIds: [] })

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

console.log('本机配置：', SETTINGS)
console.log('')

// ---- 1. 开关是不是都开着 ----
const flags = {
  '时间感': presence.enabled,
  '昼夜节律': presence.rhythmEnabled,
  '离开独处': presence.awayEnabled,
  '归来汇报': presence.reunionEnabled,
  '语音情绪映射': presence.voiceProfileEnabled,
  '便签': presence.notesEnabled,
  '帮你做过的事': presence.tracesEnabled,
  '想起共同经历': presence.anchorsEnabled,
  '待机行为': settings?.ambient?.enabled,
  '想一下再表现': settings?.reaction?.enabled,
  '让她开口说话': voice.ttsEnabled
}
for (const [name, v] of Object.entries(flags)) check(`开关「${name}」`, v === true, String(v))

// ---- 2. 关键：勾了开关，行为真的会发生吗（假开检查）----
const imp = presence.imperfection || {}
const rHit = decideOptionalFollowup({
  id: 'verify-a', intention: LOW('verify-a'), now: T0,
  config: imp, rng: () => 0.001
})
const rMiss = decideOptionalFollowup({
  id: 'verify-b', intention: LOW('verify-b'), now: T0,
  config: imp, rng: () => 0.99
})
check(
  '不完美机制真的会发生（不是假开）',
  rHit.action === 'defer' && rMiss.action === 'deliver',
  `命中时=${rHit.action}(${rHit.reason}) / 未命中时=${rMiss.action}(${rMiss.reason})`
)

const bc = voice.backchannel || {}
const bcHit = decideBackchannel({
  phase: 'start', mood: 'calm', now: T0,
  state: emptyBackchannelState(), config: bc, rng: () => 0.01
})
const bcNight = decideBackchannel({
  phase: 'start', mood: 'calm', period: 'night', now: T0,
  state: emptyBackchannelState(), config: bc, rng: () => 0.01
})
check('语气音真的会出声（不是假开）', !!bcHit.text, `reason=${bcHit.reason}`)
check('深夜仍然闭嘴（硬约束没松）', bcNight.reason === 'quiet-night', `reason=${bcNight.reason}`)

console.log('')
console.log(failed === 0 ? `全部通过（${Object.keys(flags).length + 3} 项）` : `${failed} 项没生效`)
process.exit(failed === 0 ? 0 : 1)
