// 临时探针（2026-10-17）：量模型纵向"宽度剖面"，找颈/肩线的 fy。
// 缩放支点要落在颈肩之间，才能让"凑近"读作探头而不是整体放大。
// 用法：node scripts/probe-shoulder-line.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8804
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

let browser
try {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/models`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) break
    } catch {}
    await sleep(300)
  }
  const launchOpts = { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], channel: 'msedge' }
  try {
    browser = await chromium.launch(launchOpts)
  } catch {
    delete launchOpts.channel
    browser = await chromium.launch(launchOpts)
  }
  const page = await browser.newPage({ viewport: { width: 520, height: 760 } })
  page.on('pageerror', (e) => console.error('pageerror:', e.message))
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  const out = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    const core = m.internalModel.coreModel
    const raw = core._model
    const N = raw.drawables.count
    const ci = raw.canvasinfo
    const H = ci.CanvasHeight
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}
    const pids = raw.parameters.ids
    const defs = raw.parameters.defaultValues
    for (let i = 0; i < pids.length; i++) core.setParameterValueById(pids[i], defs[i])
    core.update()

    const vp = raw.drawables.vertexPositions
    // 顶点是**画布归一化**坐标：画布纵向映射到 y ∈ [-0.5, +0.5]（y 向上），
    // 所以 fy = 0.5 - y（不是 0.5 - y/H；头顶点实测 fy≈0.04 → y≈0.46）
    const FY = (y) => 0.5 - y
    const bins = 48 // 每格约 0.025 fy
    const ext = new Array(bins).fill(0)
    const cnt = new Array(bins).fill(0)
    for (let i = 0; i < N; i++) {
      const v = vp[i]
      if (!v || !v.length) continue
      let x0 = 1e9, x1 = -1e9
      const fys = []
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < x0) x0 = v[k]
        if (v[k] > x1) x1 = v[k]
        fys.push(FY(v[k + 1]))
      }
      const lo = Math.min(...fys), hi = Math.max(...fys)
      for (let b = 0; b < bins; b++) {
        const f0 = b / bins, f1 = (b + 1) / bins
        if (hi >= f0 && lo <= f1) { ext[b] = Math.max(ext[b], x1 - x0); cnt[b]++ }
      }
    }
    let top = 1, bot = 0
    for (let b = 0; b < bins; b++) if (cnt[b] > 0) { top = Math.min(top, b / bins); bot = Math.max(bot, (b + 1) / bins) }
    return { H, bins, ext: ext.map((v) => +v.toFixed(3)), cnt, top: +top.toFixed(3), bot: +bot.toFixed(3) }
  })

  console.log(`画布高 ${out.H}，美术纵向范围 fy ∈ [${out.top}, ${out.bot}]`)
  console.log('\nfy 区间        宽度(归一化)  部件数  剖面')
  for (let b = 0; b < out.bins; b++) {
    const f0 = (b / out.bins).toFixed(3), f1 = ((b + 1) / out.bins).toFixed(3)
    if (out.cnt[b] === 0 && b > 30) continue
    const bar = '#'.repeat(Math.round(out.ext[b] * 60))
    console.log(`${f0}~${f1}   ${out.ext[b].toFixed(3).padStart(6)}   ${String(out.cnt[b]).padStart(4)}  ${bar}`)
  }
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
