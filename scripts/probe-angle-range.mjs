// scripts/probe-angle-range.mjs
// 探"幅度能开多大"：头部/身体角度参数的真实值域 + 超界会不会穿帮。
// 用来定"转头/转身"的幅度上限（超出 max 的量会被核心静默裁掉，看画面区分不出来）。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9411'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'nagi-angle-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600, outfit: 'daily' },
      ambient: { enabled: true, gaze: false, autonomous: false, level: 'conservative', hotkeys: false }
    },
    null,
    2
  ),
  'utf8'
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NAGI_RENDERER_SANDBOX = '0'
const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

let browser
try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) up = true
    } catch {
      /* 等 */
    }
    if (!up) await sleep(400)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (await p.evaluate(() => typeof window.__nagiParamRange === 'function' && !!window.__nagiFaceState?.()?.hasConfig)) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到桌宠页')

  const ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeBallX', 'ParamEyeBallY']
  const range = await page.evaluate((list) => window.__nagiParamRange(list), ids)
  console.log('参数值域（核心真实上下限）：')
  for (const id of ids) {
    const r = range?.[id]
    console.log(`  ${id.padEnd(16)} ${r ? `[${r.min}, ${r.max}]  默认 ${r.def}` : '（无此参数）'}`)
  }

  // 逐个把参数推到不同值，看画面是否继续变化（不变 = 被裁掉了 / 已经到顶）
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
  const measure = async () =>
    page.evaluate(async () => {
      const url = window.__nagiSnapshot()
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = 96
      c.height = 144
      const x = c.getContext('2d', { willReadFrequently: true })
      x.drawImage(img, 0, 0, 96, 144)
      const d = x.getImageData(0, 0, 96, 144).data
      let n = 0
      let sum = 0
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) n++
      let h = 0
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0
      return { n, sum: h }
    })

  console.log('\n逐档推值（画面是否还在变）：')
  for (const [id, steps] of [
    ['ParamAngleX', [0, 15, 30, 40, 50, 60]],
    ['ParamAngleY', [0, 10, 20, 30]],
    ['ParamAngleZ', [0, 10, 20, 30]],
    ['ParamBodyAngleX', [0, 8, 12, 18, 24]],
    ['ParamBodyAngleY', [0, 8, 12, 18, 24]]
  ]) {
    const row = []
    let prev = null
    for (const v of steps) {
      await page.evaluate(
        ([pid, val]) => {
          window.__nagiFreezeIdle?.(true)
          window.__nagiApplyAngleProbe?.(pid, val)
        },
        [id, v]
      )
      await sleep(260)
      const m = await measure()
      const changed = prev && m.sum !== prev.sum ? '变' : '不变'
      row.push(`${v}${prev ? '(' + changed + ')' : ''}`)
      prev = m
      if (SHOT_DIR) {
        const url = await page.evaluate(() => window.__nagiSnapshot())
        if (url) writeFileSync(join(SHOT_DIR, `${id}_${v}.png`), Buffer.from(url.split(',')[1], 'base64'))
      }
    }
    console.log(`  ${id.padEnd(16)} ${row.join('  ')}`)
  }
} catch (e) {
  console.error('探针失败：', e.message)
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  process.exit(0)
}
