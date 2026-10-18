// 临时探针：情绪肌肉层（运行时注册、FIFO 最后执行、set 绝对值）会不会把
// 五官微动层（加载期注册、add 增量）的增量整个盖掉？
// 结论决定 C 组"tremor amplitude 1→1.3"到底看得见看不见。
// 判据：读帧末最终参数（probePoseOnce 注册在最后 = 读到所有钩子写完的值），
// 比较 tremor 开/关两种情况下的参数波动幅度。
// 用法：node scripts/probe-emotion-tremor.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9415
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FACE_IDS = [
  'ParamBrowLForm', 'ParamBrowRForm', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLY2',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamCheek', 'ParamMouthForm',
  'ParamEyeLOpen', 'ParamEyeROpen'
]

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-et-'))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
    }),
    'utf8'
  )
  return dir
}

async function sample(page, n, gapMs = 120) {
  const out = []
  for (let i = 0; i < n; i++) {
    const v = await page.evaluate(async (ids) => {
      const p = await window.__nagiPoseParams(ids)
      const tr = window.__tremorLast || {}
      return { p, tr: { EyeLOpen: tr.ParamEyeLOpen ?? null, Cheek: tr.ParamCheek ?? null, BrowLY: tr.ParamBrowLY ?? null } }
    }, FACE_IDS)
    if (v && v.p) out.push(v)
    await sleep(gapMs)
  }
  return out
}

function ranges(samples) {
  const r = {}
  for (const id of FACE_IDS) {
    const vals = samples.map((s) => s[id]).filter((x) => typeof x === 'number')
    if (!vals.length) { r[id] = null; continue }
    r[id] = Math.max(...vals) - Math.min(...vals)
  }
  return r
}

let child
try {
  const userData = newUserData()
  child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) break
    } catch {}
    await sleep(400)
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const ok = await p.evaluate(
            () => document.body?.dataset?.mode === 'pet' && typeof window.__nagiFrame === 'function' && !!window.__nagiFrame()
          )
          if (ok) { page = p; break }
        } catch {}
      }
      if (page) break
    }
    if (page) break
    await sleep(400)
  }
  if (!page) throw new Error('找不到桌宠页')

  // 按住其它层：待机动作 / 头部摆动 / 情绪心跳 / 眨眼
  await page.evaluate(() => {
    window.__nagiFreezeIdle(true)
    window.__nagiFreezeMood?.(true)
    window.__nagiSetIdleHead?.(0)
    window.__nagiSetBlink?.(0)
    window.__nagiSuppressAutoAct?.(true)
  })

  // ① 中立（无情绪）：tremor 开 → 应该有波动
  await page.evaluate(() => window.__nagiEmotionIntensity('calm', 1))
  await sleep(1500)
  await page.evaluate(() => window.__nagiSetTremor(1))
  await sleep(600)
  const neutralOnSamples = await sample(page, 24)
  const neutralOn = ranges(neutralOnSamples)
  await page.evaluate(() => window.__nagiSetTremor(0))
  await sleep(600)
  const neutralOff = ranges(await sample(page, 24))

  // ② joy 满强度：tremor 开/关
  await page.evaluate(() => window.__nagiEmotionIntensity('joy', 1))
  await sleep(2000)
  await page.evaluate(() => window.__nagiSetTremor(1))
  await sleep(600)
  const joyOnSamples = await sample(page, 24)
  const joyOn = ranges(joyOnSamples)
  await page.evaluate(() => window.__nagiSetTremor(0))
  await sleep(600)
  const joyOff = ranges(await sample(page, 24))

  const fmt = (r) => FACE_IDS.map((id) => `${id}=${r[id] === null ? 'null' : r[id].toFixed(4)}`).join('  ')
  console.log('\n== 中立 / tremor 开 ==\n' + fmt(neutralOn))
  console.log('\n== 中立 / tremor 关 ==\n' + fmt(neutralOff))
  console.log('\n== joy / tremor 开 ==\n' + fmt(joyOn))
  console.log('\n== joy / tremor 关 ==\n' + fmt(joyOff))

  const raw = (label, samples) => {
    const pick = (id) => samples.map((s) => s.p[id]).filter((x) => typeof x === 'number')
    console.log(`\n[${label}] 原始值前 6 个采样`)
    for (const id of ['ParamEyeLOpen', 'ParamCheek', 'ParamMouthForm']) {
      console.log('  ' + id + ': ' + pick(id).slice(0, 6).map((x) => x.toFixed(4)).join(' '))
    }
    console.log('  tremorLast.EyeLOpen: ' + samples.map((s) => (s.tr.EyeLOpen ?? 0).toFixed(4)).slice(0, 6).join(' '))
    console.log('  tremorLast.Cheek:    ' + samples.map((s) => (s.tr.Cheek ?? 0).toFixed(4)).slice(0, 6).join(' '))
  }
  raw('中立/开', neutralOnSamples)
  raw('joy/开', joyOnSamples)

  const worstNeutral = Math.max(...FACE_IDS.map((id) => neutralOn[id] ?? 0))
  const worstJoyOn = Math.max(...FACE_IDS.map((id) => joyOn[id] ?? 0))
  const worstJoyOff = Math.max(...FACE_IDS.map((id) => joyOff[id] ?? 0))
  console.log(`\n中立波动=${worstNeutral.toFixed(4)}  joy 开=${worstJoyOn.toFixed(4)}  joy 关=${worstJoyOff.toFixed(4)}`)
  console.log(
    worstJoyOn > worstJoyOff + 0.002
      ? '→ tremor 在情绪激活时仍然活着（情绪层没盖住它）'
      : '→ tremor 在情绪激活时被盖住（情绪层 set 抹掉了 add 增量）'
  )
} finally {
  if (child && !child.killed) {
    await new Promise((r) => {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      k.on('close', r)
      k.on('error', r)
    })
  }
}
