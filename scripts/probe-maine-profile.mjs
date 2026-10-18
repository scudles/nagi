// 纵向剖面探针：把缅因模型在「full」取景下渲染，按 moc 归一化 fy 分带，
// 统计每档的不透明像素宽度、肤色像素数，用来定位头/肩/胸/躯干下缘（找肚脐线）。
// 用法：node scripts/probe-maine-profile.mjs [--fy=0.30]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve('E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi')
const PORT = 8795
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-maine-profile-'))
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

  const rows = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const app = new PIXI.Application({ width: 400, height: 700, backgroundAlpha: 0, antialias: true })
    document.body.appendChild(app.view)
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    app.stage.addChild(m)
    const ci = m.internalModel.coreModel._model.canvasinfo
    const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
    // full 取景 + contain：整张 moc 画布完整可见
    const fit = Math.min(400 / baseW, 700 / baseH)
    m.anchor.set(0.5, 1)
    m.x = 400 / 2
    m.y = 700
    m.scale.set(fit)
    // 冻结在静止姿态：停掉动作与物理，只留一帧
    try { m.internalModel.motionManager.stopAllMotions() } catch {}
    try { m.internalModel.physics?._evaluate?.(0) } catch {}
    await new Promise((r) => setTimeout(r, 1500))
    app.render()
    const url = app.view.toDataURL('image/png')

    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = url })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data

    // 逐屏幕行统计：不透明像素数 / x 跨度 / 肤色像素数
    const isSkin = (r, gg, b) => r > 170 && gg > 120 && gg < r - 12 && b > 90 && b < r - 15 && r - b > 28
    const out = []
    for (let y = 0; y < c.height; y++) {
      let n = 0, x0 = 1e9, x1 = -1e9, skin = 0
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (d[i + 3] > 24) {
          n++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (isSkin(d[i], d[i + 1], d[i + 2])) skin++
        }
      }
      if (n > 0) {
        // 屏幕行 -> moc 归一化 fy（自上而下，0=画布顶）
        const fy = (y - m.y) / (m.scale.y * baseH) + 1
        out.push({ fy, n, w: x1 - x0 + 1, skin, skinFrac: +(skin / n).toFixed(3) })
      }
    }
    return { baseW, baseH, fit, url, rows: out }
  })

  writeFileSync(join(SHOT, 'profile.png'), Buffer.from(rows.url.split(',')[1], 'base64'))
  console.log(`moc=${rows.baseW}×${rows.baseH}  fit=${rows.fit.toFixed(3)}  截图: ${SHOT}`)

  // 按 0.02 fy 分档聚合，打印剖面
  const BINS = 50
  const binH = 1 / BINS
  const bins = []
  for (let i = 0; i < BINS; i++) bins.push({ i, n: 0, skin: 0, wMax: 0, rows: 0 })
  for (const r of rows.rows) {
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(r.fy / binH)))
    bins[b].n += r.n
    bins[b].skin += r.skin
    bins[b].wMax = Math.max(bins[b].wMax, r.w)
    bins[b].rows++
  }
  console.log('  fy区间      不透明像素  最大宽度  肤色占比  行数')
  for (const b of bins) {
    const lo = (b.i * binH).toFixed(3)
    const frac = b.n > 0 ? (b.skin / b.n).toFixed(3) : '—'
    const bar = '#'.repeat(Math.min(40, Math.round(b.n / 60)))
    if (b.n === 0) continue
    console.log(`  ${lo}~${(b.i * binH + binH).toFixed(3)}  ${String(b.n).padStart(8)}  ${String(b.wMax).padStart(8)}  ${String(frac).padStart(7)}  ${String(b.rows).padStart(4)} ${bar}`)
  }
  const withArt = bins.filter((b) => b.n > 0)
  console.log(`\n美术纵向范围: fy ∈ [${(withArt[0].i * binH).toFixed(3)}, ${(withArt[withArt.length - 1].i * binH + binH).toFixed(3)}]`)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}
