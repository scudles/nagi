// 带 fy 标尺的全身图 + 细分剖面：用来目视确定「肚脐线」的归一化位置。
// 用法：node scripts/probe-maine-ruler.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve('E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi')
const PORT = 8801
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-maine-ruler-'))
const W = 400, H = 700
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
  const launchOpts = { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] }
  try {
    browser = await chromium.launch({ ...launchOpts, channel: 'msedge' })
  } catch {
    browser = await chromium.launch(launchOpts)
  }
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  const res = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const app = new PIXI.Application({ width: 400, height: 700, backgroundAlpha: 0, antialias: true })
    document.body.appendChild(app.view)
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    app.stage.addChild(m)
    const ci = m.internalModel.coreModel._model.canvasinfo
    const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
    const fit = Math.min(400 / baseW, 700 / baseH)
    m.anchor.set(0.5, 1)
    m.x = 200
    m.y = 700
    m.scale.set(fit)
    try { m.internalModel.motionManager.stopAllMotions() } catch {}
    await new Promise((r) => setTimeout(r, 1500))
    app.render()

    // 屏幕 y -> fy（0=画布顶）
    const screenYToFy = (py) => (py - m.y) / (m.scale.y * baseH) + 1
    // 标尺层：每 0.05 fy 一条线 + 标签
    const ruler = new PIXI.Graphics()
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const py = m.y + (f - 1) * m.scale.y * baseH
      const major = Math.abs(f * 100 % 10) < 0.001
      ruler.lineStyle(major ? 1.2 : 0.5, major ? 0xff3366 : 0x3388ff, 0.85)
      ruler.moveTo(0, py); ruler.lineTo(400, py)
      const t = new PIXI.Text(f.toFixed(2), { fontSize: 9, fill: 0x111111, fontWeight: 'bold' })
      t.x = 2; t.y = py + 1
      ruler.addChild(t)
    }
    app.stage.addChild(ruler)
    app.render()
    const url = app.view.toDataURL('image/png')

    // 细分剖面（0.005 一档）
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = url })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const isSkin = (r, gg, b) => r > 170 && gg > 120 && gg < r - 12 && b > 90 && b < r - 15 && r - b > 28
    const BINS = 200
    const bins = Array.from({ length: BINS }, () => ({ n: 0, skin: 0, w: 0, skinX0: 1e9, skinX1: -1e9 }))
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (d[i + 3] > 24) {
          // 排除标尺文字/线（红/蓝色像素不计入）
          const r = d[i], gg = d[i + 1], b = d[i + 2]
          const isRuler = (r > 180 && gg < 110 && b > 60) || (b > 180 && gg < 140 && r < 130)
          if (isRuler) continue
          const f = screenYToFy(y)
          if (f < 0 || f > 1) continue
          const bin = Math.min(BINS - 1, Math.max(0, Math.floor(f / (1 / BINS))))
          bins[bin].n++
          if (x > bins[bin].w) bins[bin].w = x
          if (isSkin(r, gg, b)) {
            bins[bin].skin++
            if (x < bins[bin].skinX0) bins[bin].skinX0 = x
            if (x > bins[bin].skinX1) bins[bin].skinX1 = x
          }
        }
      }
    }
    const rows = bins.map((b, i) => ({
      fy: +((i + 0.5) / BINS).toFixed(4), n: b.n, skin: b.skin,
      skinFrac: b.n ? +(b.skin / b.n).toFixed(3) : 0, w: b.w
    }))
    return { url, baseW, baseH, rows }
  })

  writeFileSync(join(SHOT, 'ruler.png'), Buffer.from(res.url.split(',')[1], 'base64'))
  console.log(`截图: ${join(SHOT, 'ruler.png')}`)
  console.log('   fy档    不透明  肤色  肤色占比  右缘x')
  for (const r of res.rows) {
    if (r.n === 0) continue
    if (r.fy < 0.3 || r.fy > 0.75) continue
    const bar = '#'.repeat(Math.min(30, Math.round(r.skin / 25)))
    console.log(`  ${r.fy.toFixed(3)}  ${String(r.n).padStart(6)} ${String(r.skin).padStart(6)}  ${String(r.skinFrac).padStart(6)}  ${String(r.w).padStart(4)} ${bar}`)
  }
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}
