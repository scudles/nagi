// 用真实取景算法（core/frame.js 的 bust 预设）算出缅因妹妹在桌宠窗口里的落位，
// 并按真实像素量出「美术实际范围」，判断胸像取景要不要改。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve('E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi')
const PORT = 8793
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-maine-frame-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

// 桌宠窗口尺寸矩阵（--safe-* 是桌宠 CSS 里给的画布内安全边距，这里按无 UI 的纯净画布算）
const SIZES = [
  [400, 600], [360, 540], [320, 480], [240, 640], [160, 800]
]

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

  for (const [W, H] of SIZES) {
    const page = await browser.newPage({ viewport: { width: W, height: H } })
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

    const out = await page.evaluate(async ([w, h]) => {
      const PIXI = window.PIXI
      const app = new PIXI.Application({ width: w, height: h, backgroundAlpha: 0, antialias: true })
      document.body.appendChild(app.view)
      const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
      app.stage.addChild(m)

      // ==== 复刻 core/frame.js ====
      const PRESET = { bust: { left: 0.255, right: 0.83, top: -0.01, bottom: 0.46 } }
      const p = PRESET.bust
      const ci = m.internalModel.coreModel._model.canvasinfo
      const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
      const band = {
        x: baseW * p.left, y: baseH * p.top,
        w: baseW * (p.right - p.left), h: baseH * (p.bottom - p.top),
        anchorY: p.bottom,
        centerOffset: baseW * ((p.left + p.right) / 2 - 0.5)
      }
      const fit = Math.min(w / band.w, h / band.h)
      m.anchor.set(0.5, band.anchorY)
      m.x = w / 2 - band.centerOffset * fit
      m.y = h
      m.scale.set(fit)

      await new Promise((r) => setTimeout(r, 900))
      app.render()
      const url = app.view.toDataURL('image/png')

      // 真实美术范围（相对 moc 画布）：反推 fx/fy
      const img = new Image()
      await new Promise((r) => { img.onload = r; img.src = url })
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x; if (x > x1) x1 = x
            if (y < y0) y0 = y; if (y > y1) y1 = y
          }
        }
      }
      // 画布像素 -> moc 归一化
      const fx = (px) => (px - m.x) / (m.scale.x * baseW) + 0.5
      const fy = (py) => (py - m.y) / (m.scale.y * baseH) + band.anchorY
      return {
        url,
        baseW, baseH, fit,
        art: Number.isFinite(x0)
          ? { fx0: fx(x0), fx1: fx(x1), fy0: fy(y0), fy1: fy(y1) }
          : null,
        clip: {
          topOverflow: y0 < 0, bottomOverflow: y1 > c.height - 1,
          leftOverflow: x0 < 0, rightOverflow: x1 > c.width - 1
        }
      }
    }, [W, H])

    const a = out.art
    const fmt = (v) => (v == null ? '—' : v.toFixed(3))
    console.log(`\n${W}×${H}  fit=${out.fit.toFixed(3)}  moc=${out.baseW}×${out.baseH}`)
    if (a) {
      console.log(`  美术范围 fx[${fmt(a.fx0)}, ${fmt(a.fx1)}]  fy[${fmt(a.fy0)}, ${fmt(a.fy1)}]`)
    }
    const c = out.clip
    console.log(`  越界：上${c.topOverflow ? '✘' : '✔'} 下${c.bottomOverflow ? '✘' : '✔'} 左${c.leftOverflow ? '✘' : '✔'} 右${c.rightOverflow ? '✘' : '✔'}`)

    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(SHOT, `pet-${W}x${H}.png`), Buffer.from(out.url.split(',')[1], 'base64'))
    await page.close()
  }
  console.log('\n截图：', SHOT)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}
