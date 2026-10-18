// 临时探针（2026-10-17）：核对 B 组「Z 轴动作」到底做出来的是什么效果。
// 用户质疑：要的是「向前探头/向前弯腰」，不是「模型整体前后移动」。
// 当前实现的主体是**容器整体缩放**（peek = scale 1.10 + dy −10px，身体角度只给 1.5°），
// 本探针把「当前实现」「纯身体俯仰」「候选新设计」并排拍出来，用全身取景（腿脚可见）
// 判断哪一种读作"弯腰"，哪一种读作"整人放大平移"。
// 用法：node scripts/probe-depth-look.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8798
const SHOT = mkdtempSync(join(tmpdir(), 'nagi-depth-look-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

// 每个用例：{ name, frame: 'full'|'bust', scale, dx, dy, params }
//   scale/dx/dy = zContainer 的容器层（与 live2d.js 同款：pivot 设模型位置、绝对定位）
//   params      = 每帧钉住的模型参数（度）
const CASES = [
  // ---- 全身取景：看腿动不动 ----
  { name: '00-full-neutral', frame: 'full', scale: 1, dx: 0, dy: 0, params: {} },
  { name: '01-full-current-peek', frame: 'full', scale: 1.1, dx: 0, dy: -10, params: { ParamBodyAngleX: -1.5, ParamAngleX: -6, ParamAngleY: 4 } },
  { name: '02-full-body-only', frame: 'full', scale: 1, dx: 0, dy: 0, params: { ParamBodyAngleX: -8 } },
  { name: '03-full-body-head', frame: 'full', scale: 1, dx: 0, dy: 0, params: { ParamBodyAngleX: -8, ParamAngleX: -8 } },
  { name: '04-full-candidate', frame: 'full', scale: 1.02, dx: 0, dy: -2, params: { ParamBodyAngleX: -6, ParamAngleX: -8 } },
  { name: '05-full-leanback', frame: 'full', scale: 0.98, dx: 0, dy: 2, params: { ParamBodyAngleX: 5, ParamAngleX: 7 } },
  // ---- 胸像取景（出厂 400×600 的那一套）----
  { name: '10-bust-neutral', frame: 'bust', scale: 1, dx: 0, dy: 0, params: {} },
  { name: '11-bust-current-peek', frame: 'bust', scale: 1.1, dx: 0, dy: -10, params: { ParamBodyAngleX: -1.5, ParamAngleX: -6, ParamAngleY: 4 } },
  { name: '12-bust-body-only', frame: 'bust', scale: 1, dx: 0, dy: 0, params: { ParamBodyAngleX: -8 } },
  { name: '13-bust-candidate', frame: 'bust', scale: 1.02, dx: 0, dy: -2, params: { ParamBodyAngleX: -6, ParamAngleX: -8 } }
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

  for (const c of CASES) {
    const url = await page.evaluate(async (cfg) => {
      const PIXI = window.PIXI
      // 每次重建，避免上一个用例的状态残留
      document.querySelectorAll('canvas').forEach((el) => el.remove())
      const W = 500, H = 700
      const app = new PIXI.Application({ width: W, height: H, backgroundAlpha: 0, antialias: true })
      app.view.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#2a2f3a'
      document.body.appendChild(app.view)

      const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
      // 与 live2d.js 同款：模型套一层容器，只动容器的 scale/x/y
      const z = new PIXI.Container()
      z.addChild(m)
      app.stage.addChild(z)

      const core = m.internalModel.coreModel
      const ci = core._model.canvasinfo
      const baseW = ci.CanvasWidth, baseH = ci.CanvasHeight
      // 取景带：full = 整身（能看到脚）；bust = 出厂胸像（肚脐线）
      const p = cfg.frame === 'full'
        ? { left: 0.255, right: 0.83, top: 0.01, bottom: 0.96 }
        : { left: 0.255, right: 0.83, top: 0.015, bottom: 0.48 }
      const band = { w: baseW * (p.right - p.left), h: baseH * (p.bottom - p.top), centerOffset: baseW * ((p.left + p.right) / 2 - 0.5) }
      const fit = Math.min(W / band.w, H / band.h)
      m.anchor.set(0.5, p.bottom)
      m.x = W / 2 - band.centerOffset * fit
      m.y = H
      m.scale.set(fit)

      // 钉住待机动作：留一个静止底姿，否则 9 秒循环的 Idle 会把对比噪声盖过去
      try { m.internalModel.motionManager?.stopAllMotions() } catch {}

      // 参数层：每帧写（框架帧末 loadParameters 会复位，必须在 hook 里写）
      let params = {}
      const hook = () => {
        for (const [id, v] of Object.entries(params)) {
          try { core.setParameterValueById(id, v) } catch {}
        }
      }
      m.internalModel.on('beforeModelUpdate', hook)

      // 容器层：与 ensureDepthHook 同款（pivot = 模型位置，绝对定位）
      const applyContainer = () => {
        z.pivot.set(m.x, m.y)
        z.position.set(m.x + cfg.dx, m.y + cfg.dy)
        z.scale.set(cfg.scale)
      }
      applyContainer()

      params = cfg.params
      await new Promise((r) => setTimeout(r, 1400))
      applyContainer()
      app.render()
      const out = app.renderer.extract.canvas(app.stage)
      return out.toDataURL('image/png')
    }, c)
    const file = join(SHOT, `${c.name}.png`)
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
    console.log(`${c.name} → ${file}`)
  }
  console.log('\n截图目录：', SHOT)
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
