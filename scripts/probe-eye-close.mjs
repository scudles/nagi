// 临时探针：ParamEyeLOpen/ROpen 全闭（=0）时眼睛区域到底长什么样。
// 背景：DEFAULT_BLINK.minClose=0.02 的注释声称"全 0 会让眼线消失，看着像坏了"，
// 但没人真看过。C 组要把眨眼改成闭到底（minClose 0），先拿截图定论。
// 用法：node scripts/probe-eye-close.mjs
import { spawn } from 'node:child_process'
import { writeFileSync as _wfs } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8797
const OUT = resolve(ROOT, 'tools/live2d-viewer')
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
  const page = await browser.newPage({ viewport: { width: 420, height: 760 } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  const ready = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    const app = new PIXI.Application({ width: 400, height: 640, backgroundAlpha: 0, antialias: true })
    // 盖住页面自己的界面，只留我的画布
    app.view.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#20242e'
    document.body.appendChild(app.view)
    app.stage.addChild(m)
    // 锚点 (0.5,0.5) 在模型中心；画布 5000×7000 模型单位，缩放 0.2 后半高 700
    m.scale.set(0.2)
    m.x = 200
    m.y = 700 // 模型顶端贴画布顶，头（fy=0.040）落在 y≈56

    // 每帧把眼开闭钉成目标值（hook 注册在最后 = FIFO 最后执行，盖住一切）
    let target = 1
    const hook = () => {
      const core = m.internalModel.coreModel
      core.setParameterValueById('ParamEyeLOpen', target)
      core.setParameterValueById('ParamEyeROpen', target)
    }
    m.internalModel.on('beforeModelUpdate', hook)
    window.__setEye = (v) => { target = v }
    window.__probeCanvas = app.view
    window.__probeDiag = () => {
      const px = app.renderer.extract.pixels(app.stage)
      let n = 0
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++
      return {
        pixels: px.length / 4,
        opaque: n,
        model: { w: m.width, h: m.height, x: m.x, y: m.y, textures: m.textures ? Object.keys(m.textures).length : -1 },
        tickerRunning: app.ticker.started,
        internalReady: !!m.internalModel.coreModel
      }
    }
    // 直接从渲染器取图（WebGL 画布的 element 截图会是空帧，必须走 extract）
    window.__extractShot = () => {
      const c = app.renderer.extract.canvas(app.stage)
      return c.toDataURL('image/png').slice(22)
    }
    return { ok: true }
  })
  if (!ready.ok) throw new Error('探针页面初始化失败')

  console.log('diag:', JSON.stringify(await page.evaluate(() => window.__probeDiag())))
  for (const v of [1, 0.3, 0.1, 0.02, 0]) {
    await page.evaluate((val) => window.__setEye(val), v)
    await sleep(700)
    const b64 = await page.evaluate(() => window.__probeCanvas && window.__extractShot())
    if (!b64) throw new Error('取图失败')
    const file = resolve(OUT, `tmp-eye-${v}.png`)
    _wfs(file, Buffer.from(b64, 'base64'))
    console.log(`eye open = ${v} → tmp-eye-${v}.png`)
  }
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
