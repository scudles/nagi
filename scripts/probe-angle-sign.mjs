// 实证角度参数的正负号：ParamAngleX / ParamBodyAngleX 的 +/− 到底是"抬头前倾"还是"低头后仰"。
// 做法：本地 viewer 起服务 → playwright 开页 → 逐档 set 参数 → 截图 → 人眼读图。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve('E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi')
const PORT = 8795
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-angle-sign-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

// [参数, 值, 文件名]
const CASES = [
  ['ParamAngleX', 10, 'angleX-plus'],
  ['ParamAngleX', -10, 'angleX-minus'],
  ['ParamBodyAngleX', 8, 'bodyAngleX-plus'],
  ['ParamBodyAngleX', -8, 'bodyAngleX-minus']
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
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], channel: 'msedge' })

  const page = await browser.newPage({ viewport: { width: 500, height: 700 } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  for (const [id, v, name] of CASES) {
    const url = await page.evaluate(async ([pid, val]) => {
      const PIXI = window.PIXI
      const app = new PIXI.Application({ width: 500, height: 700, backgroundAlpha: 0, antialias: true })
      document.body.appendChild(app.view)
      const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
      app.stage.addChild(m)
      const core = m.internalModel.coreModel
      const ci = core._model.canvasinfo
      const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
      // 与 core/frame.js 同款：缅因胸像带，contain 装框
      const p = { left: 0.255, right: 0.83, top: 0.015, bottom: 0.48 }
      const band = { w: baseW * (p.right - p.left), h: baseH * (p.bottom - p.top), centerOffset: baseW * ((p.left + p.right) / 2 - 0.5) }
      const fit = Math.min(500 / band.w, 700 / band.h)
      m.anchor.set(0.5, p.bottom)
      m.x = 250 - band.centerOffset * fit
      m.y = 700
      m.scale.set(fit)
      core.setParameterValueById(pid, val)
      await new Promise((r) => setTimeout(r, 1200))
      app.render()
      return app.view.toDataURL('image/png')
    }, [id, v])
    writeFileSync(join(SHOT, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
    console.log(`${id} = ${v} → ${name}.png`)
  }
  console.log('\n截图目录：', SHOT)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}
