// 临时探针（2026-10-17）：顶点级测量 ParamBodyAngleX / ParamAngleX 到底让哪些部件动、动多少。
// 像素法在这里失效（待机动作 + 头发物理让噪声底高达 15%），所以直接读 CubismCore 的
// 变形后顶点缓冲：core.update() + core.drawables.update() 之后，vertexPositions 就是本帧几何。
// 用法：node scripts/probe-body-vertex.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8800
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
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  const out = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    const core = m.internalModel.coreModel
    const raw = core._model
    const ci = raw.canvasinfo
    const W = ci.CanvasWidth, H = ci.CanvasHeight

    // 冻结：停掉待机动作、把所有参数按默认值钉住，再手动驱一帧
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}
    const ids = raw.parameters.ids
    const defs = raw.parameters.defaultValues
    const resetAll = () => {
      for (let i = 0; i < ids.length; i++) core.setParameterValueById(ids[i], defs[i])
      core.update()
      if (raw.drawables?.update) raw.drawables.update()
    }

    // 取某个 drawable 的变形后顶点范围（模型单位，y 向上）
    const drawableIds = raw.drawables.ids
    const vertsOf = (i) => raw.drawables.vertexPositions[i]
    const rangeOf = (i) => {
      const v = vertsOf(i)
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < x0) x0 = v[k]
        if (v[k] > x1) x1 = v[k]
        if (v[k + 1] < y0) y0 = v[k + 1]
        if (v[k + 1] > y1) y1 = v[k + 1]
      }
      return { x0, x1, y0, y1, n: v.length / 2 }
    }

    // 按 fy 给 drawable 分区域（fy = 归一化高度，0 = 画布顶）
    const toFy = (y) => 0.5 - y / H
    const regions = [
      ['头/脸 (fy<0.14)', (r) => toFy(r.y1) < 0.14],
      ['上身 (0.14~0.45)', (r) => toFy(r.y1) >= 0.14 && toFy(r.y1) < 0.45],
      ['下身 (0.45~0.80)', (r) => toFy(r.y1) >= 0.45 && toFy(r.y1) < 0.80],
      ['脚 (fy>0.80)', (r) => toFy(r.y1) >= 0.80]
    ]

    const measure = (label, params) => {
      resetAll()
      for (const [id, v] of Object.entries(params)) core.setParameterValueById(id, v)
      core.update()
      if (raw.drawables?.update) raw.drawables.update()
      const res = { label, regions: {} }
      for (const [name, test] of regions) {
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, count = 0
        for (let i = 0; i < drawableIds.length; i++) {
          const r = rangeOf(i)
          if (r.n === 0 || !test(r)) continue
          count++
          x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1)
          y0 = Math.min(y0, r.y0); y1 = Math.max(y1, r.y1)
        }
        res.regions[name] = { x0, x1, y0, y1, drawables: count }
      }
      return res
    }

    const base = measure('baseline', {})
    const cases = [
      ['bodyX-8', { ParamBodyAngleX: -8 }],
      ['bodyX-10', { ParamBodyAngleX: -10 }],
      ['bodyX+10', { ParamBodyAngleX: 10 }],
      ['headX-8', { ParamAngleX: -8 }],
      ['headX+8', { ParamAngleX: 8 }],
      ['headZ-8', { ParamAngleZ: -8 }]
    ]
    const out = { W, H, base, cases: [] }
    for (const [label, params] of cases) out.cases.push(measure(label, params))
    // 顺带列出 drawable id 清单（前 40 个），供定位部件
    out.sampleDrawables = Array.from(drawableIds).slice(0, 40)
    out.vertexCount = drawableIds.length
    return out
  })

  const { W, H, base, cases } = out
  console.log(`画布 ${W}×${H}，drawable ${out.vertexCount} 个`)
  console.log('\n基线（模型单位，y 向上；fy = 0.5 - y/H）：')
  for (const [name, r] of Object.entries(base.regions)) {
    console.log(`  ${name.padEnd(18)} drawable=${String(r.drawables).padStart(3)}  x=[${r.x0.toFixed(0)}, ${r.x1.toFixed(0)}]  y=[${r.y0.toFixed(0)}, ${r.y1.toFixed(0)}]  fy=[${(0.5 - r.y1 / H).toFixed(3)}, ${(0.5 - r.y0 / H).toFixed(3)}]`)
  }
  for (const c of cases) {
    console.log(`\n${c.label}：`)
    for (const [name, r] of Object.entries(c.regions)) {
      const b = base.regions[name]
      const dx = ((r.x0 + r.x1) / 2 - (b.x0 + b.x1) / 2)
      const dy = ((r.y0 + r.y1) / 2 - (b.y0 + b.y1) / 2)
      const dH = (r.y1 - r.y0) - (b.y1 - b.y0)
      console.log(`  ${name.padEnd(18)} 中心位移 dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}（+=上）  高度变化=${dH.toFixed(1)}`)
    }
  }
  console.log('\ndrawable 样例：', out.sampleDrawables.join(', '))
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
