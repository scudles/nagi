// 临时探针（2026-10-17）：ParamBodyAngleX（身体俯仰）在这个模型上到底动多少？
// 判据必须是**噪声底对照**：同实例连拍两张（不动任何参数）得到物理/抗锯齿噪声，
// 再和"钉了参数"的差异比较——不然头发幌动会被误判成参数生效。
// 同时拍一个已知有效的参数（ParamAngleZ 歪头）作参照系。
// 用法：node scripts/probe-body-pitch.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8799
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-body-pitch-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

// [名字, 参数对象]；第一个是噪声底（不钉任何参数）
const CASES = [
  ['a0-noise-1', {}],
  ['a1-noise-2', {}],
  ['b0-bodyX-8', { ParamBodyAngleX: -8 }],
  ['b1-bodyX-10', { ParamBodyAngleX: -10 }],
  ['b2-bodyX+10', { ParamBodyAngleX: 10 }],
  ['c0-headX-8', { ParamAngleX: -8 }],
  ['c1-headX+8', { ParamAngleX: 8 }],
  ['d0-headZ-8', { ParamAngleZ: -8 }]
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
  const launchOpts = { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], channel: 'msedge' }
  try {
    browser = await chromium.launch(launchOpts)
  } catch {
    delete launchOpts.channel
    browser = await chromium.launch(launchOpts)
  }
  const page = await browser.newPage({ viewport: { width: 520, height: 760 } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  // 只建一次实例：所有用例共用同一个底姿，噪声才可比
  await page.evaluate(async () => {
    const PIXI = window.PIXI
    document.querySelectorAll('canvas').forEach((el) => el.remove())
    const W = 500, H = 700
    const app = new PIXI.Application({ width: W, height: H, backgroundAlpha: 0, antialias: true })
    app.view.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#2a2f3a'
    document.body.appendChild(app.view)
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    app.stage.addChild(m)
    const core = m.internalModel.coreModel
    const ci = core._model.canvasinfo
    const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
    const p = { left: 0.255, right: 0.83, top: 0.01, bottom: 0.96 } // 全身
    const band = { w: baseW * (p.right - p.left), h: baseH * (p.bottom - p.top), centerOffset: baseW * ((p.left + p.right) / 2 - 0.5) }
    const fit = Math.min(W / band.w, H / band.h)
    m.anchor.set(0.5, p.bottom)
    m.x = W / 2 - band.centerOffset * fit
    m.y = H
    m.scale.set(fit)
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}
    let params = {}
    m.internalModel.on('beforeModelUpdate', () => {
      for (const [id, v] of Object.entries(params)) {
        try { core.setParameterValueById(id, v) } catch {}
      }
    })
    window.__shot = () => {
      const c = app.renderer.extract.canvas(app.stage)
      return c.toDataURL('image/png')
    }
    window.__setParams = (p) => { params = p || {} }
    window.__probe = {}
  })

  await sleep(2500) // 等头发物理彻底停下来，把噪声底压到最低

  for (const [name, params] of CASES) {
    await page.evaluate((p) => window.__setParams(p), params)
    await sleep(900)
    const url = await page.evaluate(() => window.__shot())
    writeFileSync(join(SHOT, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
    console.log(`${name} ${JSON.stringify(params)} → ${name}.png`)
  }
  console.log('\n截图目录：', SHOT)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
