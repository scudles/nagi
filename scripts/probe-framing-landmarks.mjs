// 临时探针（2026-10-17）：按真实取景带渲染，逐行量剪影宽度，反算头顶/下巴/肩线的 fy。
// 之前的 fy 换算都建立在猜测的顶点归一化口径上，对不上 frame.js 的 0.04/0.48；
// 这里改成"渲染 → 量像素 → 用模型自身变换反算 fy"，与渲染同一坐标系，不依赖换算假设。
// 用法：node scripts/probe-framing-landmarks.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8805
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
    const app = new PIXI.Application({ view: document.createElement('canvas'), width: 520, height: 760, backgroundAlpha: 0, antialias: true })
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    const core = m.internalModel.coreModel
    const raw = core._model
    const CW = raw.canvasinfo.CanvasWidth
    const CH = raw.canvasinfo.CanvasHeight
    // 与 src/core/frame.js 的 Maine 取景带一致
    const P = { left: 0.255, right: 0.83, top: 0.015, bottom: 0.48 }
    const bandW = CW * (P.right - P.left)
    const bandH = CH * (P.bottom - P.top)
    const fit = Math.min(520 / bandW, 760 / bandH)
    m.anchor.set(0.5, P.bottom)
    m.scale.set(fit)
    const centerOffset = CW * ((P.left + P.right) / 2 - 0.5)
    m.x = 520 / 2 - centerOffset * fit
    m.y = 760 / 2 + bandH * fit / 2 // 让带子垂直居中：锚点(肚脐)落在带底
    app.stage.addChild(m)
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}
    const pids = raw.parameters.ids
    const defs = raw.parameters.defaultValues
    const freeze = () => { for (let i = 0; i < pids.length; i++) core.setParameterValueById(pids[i], defs[i]) }

    // 逐帧渲染取样
    const sample = (params) => {
      freeze()
      for (const [id, v] of Object.entries(params)) core.setParameterValueById(id, v)
      app.render()
      const cv = app.renderer.extract.canvas(app.stage)
      const c2 = document.createElement('canvas')
      c2.width = cv.width; c2.height = cv.height
      const ctx = c2.getContext('2d')
      ctx.clearRect(0, 0, c2.width, c2.height)
      ctx.drawImage(cv, 0, 0)
      const d = ctx.getImageData(0, 0, c2.width, c2.height).data
      const rows = []
      let top = -1, bot = -1
      for (let y = 0; y < c2.height; y++) {
        let x0 = -1, x1 = -1, n = 0
        for (let x = 0; x < c2.width; x++) {
          if (d[(y * c2.width + x) * 4 + 3] > 24) { if (x0 < 0) x0 = x; x1 = x; n++ }
        }
        rows.push({ y, x0, x1, w: x1 - x0 + 1, n })
        if (n > 0) { if (top < 0) top = y; bot = y }
      }
      return { rows, top, bot, canvasW: c2.width, canvasH: c2.height }
    }

    const geo = { CW, CH, fit, bandH, bandPx: bandH * fit, modelX: m.x, modelY: m.y, anchorY: P.bottom }
    // 屏幕行 → fy： y_screen = modelY + (fy - anchorY) * CH * fit
    const fyOf = (row) => P.bottom + (row - m.y) / (CH * fit)

    const base = sample({})
    // 找地标：头顶 = 第一行有像素；肩线 = 剪影最宽的行（在下半段）；颈 = 头与肩之间的最窄处
    const widthAt = (r) => (r.x0 < 0 ? 0 : r.w)
    let widestRow = base.top, widest = 0
    for (let y = base.top; y <= base.bot; y++) {
      const w = widthAt(base.rows[y])
      if (w > widest) { widest = w; widestRow = y }
    }
    // 头部下边界：从头顶往下，第一次宽度回落到 < 0.6×最大宽度 之前的最宽处
    let headBottomRow = base.top
    for (let y = base.top; y <= widestRow; y++) {
      if (widthAt(base.rows[y]) > widthAt(base.rows[headBottomRow])) headBottomRow = y
    }
    // 颈：头顶与肩之间的最窄行
    let neckRow = headBottomRow, neckW = 1e9
    for (let y = headBottomRow; y <= widestRow; y++) {
      const w = widthAt(base.rows[y])
      if (w > 0 && w < neckW) { neckW = w; neckRow = y }
    }

    return {
      geo,
      base: {
        top: base.top, bot: base.bot,
        topFy: +fyOf(base.top).toFixed(4), botFy: +fyOf(base.bot).toFixed(4),
        headBottomRow, headBottomFy: +fyOf(headBottomRow).toFixed(4),
        neckRow, neckFy: +fyOf(neckRow).toFixed(4), neckW,
        widestRow, widestFy: +fyOf(widestRow).toFixed(4), widest,
        profile: base.rows.filter((r, i) => i % 20 === 0 && r.y >= base.top && r.y <= base.bot).map((r) => ({ y: r.y, w: r.w, fy: +fyOf(r.y).toFixed(3) }))
      }
    }
  })

  console.log('画布', out.geo.CW, '×', out.geo.CH, ' fit=', out.geo.fit.toFixed(5))
  console.log(`取景带像素高 ${out.geo.bandPx.toFixed(1)}，model.y=${out.geo.modelY.toFixed(1)}，anchorY=${out.geo.anchorY}`)
  const b = out.base
  console.log(`\n剪影：顶行 ${b.top}（fy=${b.topFy}）  底行 ${b.bot}（fy=${b.botFy}）`)
  console.log(`头/耳最宽行 ${b.headBottomRow}（fy=${b.headBottomFy}，宽 ${b.headBottomRow >= 0 ? '见剖面' : ''}）`)
  console.log(`颈（最窄）行 ${b.neckRow}（fy=${b.neckFy}，宽 ${b.neckW}px）`)
  console.log(`全身最宽（肩/臂）行 ${b.widestRow}（fy=${b.widestFy}，宽 ${b.widest}px）`)
  console.log('\n每 20 行剖面：')
  for (const p of b.profile) console.log(`  row ${String(p.y).padStart(3)}  fy=${p.fy}  宽 ${String(p.w).padStart(3)}px  ${'#'.repeat(Math.round(p.w / 6))}`)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
