#!/usr/bin/env node
// scripts/verify-media-context.mjs
// 验收：用户此刻的真实播放器，能不能变成「她上下文里的一句话」。
//
// 背景（2026-10-18）：用户实测「凪不知道我在听什么」，她自己跑去开网页猜。
// 根因是 currentMusicContext() 只读缓存、从不主动探；缓存为空就永远空。
// 本脚本零 mock 走真实链路：ps1 探针 → 兜底构造 → 合并 → 归一化 → musicContext 文本。
//
// 用法（必须在 Windows 上、且至少有一个白名单播放器在放歌才有意义）：
//   node --experimental-test-module-mocks scripts/verify-media-context.mjs
// 产出：逐层打印实际数据 + 最终注入文本；全链路有内容 → 退出码 0。
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { normalizeMediaObservation, musicContext, pickActiveSession, selfSessionIds, filterSelfSessions } from '../src/core/signals/music.js'
import { buildFallbackObservation, mergeMediaObservations, DEFAULT_PLAYER_PROCESSES } from '../src/core/signals/players.js'

const execFileAsync = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PS = join(root, 'resources', 'music')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  ✔ ' + name) }
  else { fail++; console.log('  ✘ ' + name + (detail ? '\n      ' + detail : '')) }
}

async function runProbe(script, args) {
  const out = join(tmpdir(), 'nagi-verify-' + Math.random().toString(36).slice(2) + '.json')
  try {
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PS, script), '-OutFile', out, ...args], { timeout: 25000 })
    // 凪真实读法：UTF-8 无 BOM（ps1 用 UTF8Encoding($false) 写）
    return JSON.parse(await readFile(out, 'utf8'))
  } finally {
    await rm(out, { force: true })
  }
}

console.log('\n=== 1. SMTC（Windows 媒体会话）===')
let smtc = null
try {
  const raw = await runProbe('smtc.ps1', [])
  const kept = filterSelfSessions(raw.sessions || [], selfSessionIds({ execPath: process.execPath, productName: '凪 Nagi' }))
  const dropped = (raw.sessions || []).length - kept.length
  smtc = kept.length || !(raw.sessions || []).length ? { ...raw, sessions: kept } : { available: false, reason: 'no-session' }
  console.log('  会话数：' + kept.length + (dropped ? '（已排除凪自身 ' + dropped + ' 条）' : ''))
  for (const s of kept) console.log(`    · ${s.app} | ${s.title || '(无标题)'} | ${s.playbackStatus}`)
  const playing = pickActiveSession(kept)?.playbackStatus === 'playing'
  console.log('  有「播放中」会话：' + (playing ? '是 → 会直接以 SMTC 为准' : '否 → 继续走窗口标题兜底'))
} catch (err) {
  console.log('  读取失败：' + err.message)
  check('SMTC 探针可执行', false, err.message)
}

console.log('\n=== 2. 白名单播放器窗口标题（兜底）===')
const fallback = await runProbe('player-title.ps1', ['-Processes', DEFAULT_PLAYER_PROCESSES.map((p) => p.process).join(',')])
for (const w of fallback.windows || []) console.log(`    · ${w.process} | ${w.title}`)
const fallbackObs = buildFallbackObservation(fallback.windows || [], Date.now())
console.log('  可解析曲目：' + (fallbackObs.sessions?.length || 0) + ' 条')
for (const s of fallbackObs.sessions || []) console.log(`    · ${s.app} | ${s.title}${s.artist ? ' / ' + s.artist : ''}`)

console.log('\n=== 3. 合并 + 归一化 ===')
const merged = mergeMediaObservations(smtc, fallbackObs)
const obs = normalizeMediaObservation(merged, Date.now())
console.log('  ' + JSON.stringify(obs))

console.log('\n=== 4. 最终注入她的上下文 ===')
const lines = musicContext(obs, Date.now())
if (!lines.length) console.log('  （空 —— 她不知道你在听什么）')
for (const line of lines) console.log('  → ' + line)

console.log('\n=== 判定 ===')
check('两层探针至少一层可读', Boolean(smtc || fallback.available))
if (!obs.available) {
  console.log('  ⚠ 当前系统里没有可识别的媒体会话 —— 请先打开播放器放首歌再跑本脚本')
  check('媒体观测可用', false, '没有正在播放的白名单播放器')
} else {
  check('媒体观测可用', true)
  check('能说出具体曲目/标题', Boolean(obs.title), '标题为空')
  check('注入上下文非空', lines.length > 0)
  check('播放状态诚实（unknown 时注明来源）',
    obs.playbackStatus !== 'playing' ? !obs.source || /播放状态未知|已暂停|已停止/.test(lines[0]) : true)
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
