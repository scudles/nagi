// 临时探针（2026-10-17）：测 cdi3 里发现的「身体距离 / 身体x」这组疑似纵深参数，
// 并补全六个标准角度参数的量程与语义（X=左右 / Y=上下 的实证依据）。
// 用法：node scripts/probe-depth-params.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8803
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
    const ids = raw.drawables.ids
    const pids = raw.parameters.ids
    const defs = raw.parameters.defaultValues
    const mins = raw.parameters.minimumValues
    const maxs = raw.parameters.maximumValues
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}

    const rangeOf = (id) => {
      const i = pids.indexOf(id)
      return i < 0 ? null : { def: defs[i], min: mins[i], max: maxs[i] }
    }

    const stats = () => {
      const vp = raw.drawables.vertexPositions
      const res = []
      for (let i = 0; i < N; i++) {
        const v = vp[i]
        if (!v || !v.length) { res.push(null); continue }
        let cx = 0, cy = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
        for (let k = 0; k < v.length; k += 2) {
          const X = v[k], Y = v[k + 1]
          cx += X; cy += Y
          if (X < x0) x0 = X; if (X > x1) x1 = X
          if (Y < y0) y0 = Y; if (Y > y1) y1 = Y
        }
        const n = v.length / 2
        res.push({ cx: cx / n, cy: cy / n, x0, x1, y0, y1 })
      }
      return res
    }
    const setAll = (params) => {
      for (let i = 0; i < pids.length; i++) core.setParameterValueById(pids[i], defs[i])
      for (const [id, v] of Object.entries(params)) core.setParameterValueById(id, v)
      core.update()
    }
    setAll({})
    const base = stats()

    const zones = ['head', 'torso', 'leg', 'foot']
    const zoneOf = (cy) => (cy > 0.25 ? 'head' : cy > -0.15 ? 'torso' : cy > -0.45 ? 'leg' : 'foot')
    const zb = {}
    for (const z of zones) zb[z] = []
    for (let i = 0; i < N; i++) if (base[i]) zb[zoneOf(base[i].cy)].push(i)

    const measure = (label, params) => {
      setAll(params)
      const s = stats()
      const zs = {}
      let moved = 0
      for (const z of zones) {
        let sx = 0, sy = 0
        for (const i of zb[z]) { sx += s[i].cx - base[i].cx; sy += s[i].cy - base[i].cy }
        zs[z] = { n: zb[z].length, dx: +(sx / zb[z].length).toFixed(4), dy: +(sy / zb[z].length).toFixed(4) }
      }
      // 整体包围盒（看"整体放大/缩小"）
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
      for (let i = 0; i < N; i++) {
        if (!s[i]) continue
        x0 = Math.min(x0, s[i].x0); x1 = Math.max(x1, s[i].x1)
        y0 = Math.min(y0, s[i].y0); y1 = Math.max(y1, s[i].y1)
        const d = Math.hypot(s[i].cx - base[i].cx, s[i].cy - base[i].cy)
        if (d > 1e-6) moved++
      }
      let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9
      for (const i of zb.head) { bx0 = Math.min(bx0, base[i].x0); bx1 = Math.max(bx1, base[i].x1) }
      for (const i of zb.head) { by0 = Math.min(by0, base[i].y0); by1 = Math.max(by1, base[i].y1) }
      let hx0 = 1e9, hx1 = -1e9, hy0 = 1e9, hy1 = -1e9
      for (const i of zb.head) { hx0 = Math.min(hx0, s[i].x0); hx1 = Math.max(hx1, s[i].x1); hy0 = Math.min(hy0, s[i].y0); hy1 = Math.max(hy1, s[i].y1) }
      return {
        label, moved,
        zones: zs,
        bboxW: +(x1 - x0).toFixed(4), bboxH: +(y1 - y0).toFixed(4),
        headW: +(hx1 - hx0).toFixed(4), baseHeadW: +(bx1 - bx0).toFixed(4),
        headCY: +((hy0 + hy1) / 2).toFixed(4), baseHeadCY: +((by0 + by1) / 2).toFixed(4)
      }
    }

    const r84 = rangeOf('Param84')
    const r82 = rangeOf('Param82')
    const r83 = rangeOf('Param83')
    const cases = []
    if (r84) {
      cases.push(measure(`Param84 身体距离 = max ${r84.max}`, { Param84: r84.max }))
      cases.push(measure(`Param84 身体距离 = min ${r84.min}`, { Param84: r84.min }))
      cases.push(measure(`Param84 身体距离 = 中点 ${(r84.max + r84.min) / 2}`, { Param84: (r84.max + r84.min) / 2 }))
    }
    if (r82) cases.push(measure(`Param82 身体x = max ${r82.max}`, { Param82: r82.max }))
    if (r83) cases.push(measure(`Param83 身体x = max ${r83.max}`, { Param83: r83.max }))
    cases.push(measure('ParamBodyAngleY +10', { ParamBodyAngleY: 10 }))
    cases.push(measure('ParamBodyAngleY -10', { ParamBodyAngleY: -10 }))
    cases.push(measure('ParamAngleY +30（头部俯仰满量程）', { ParamAngleY: 30 }))
    cases.push(measure('ParamAngleY -30（头部俯仰满量程）', { ParamAngleY: -30 }))

    const ranges = {}
    for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'Param84', 'Param82', 'Param83']) {
      const r = rangeOf(id)
      if (r) ranges[id] = { def: +r.def.toFixed(3), min: +r.min.toFixed(3), max: +r.max.toFixed(3) }
    }
    return { N, ranges, cases }
  })

  console.log('=== 参数量程（moc 实测）===')
  for (const [id, r] of Object.entries(out.ranges)) console.log(`  ${id.padEnd(16)} default=${r.def}  [${r.min}, ${r.max}]`)
  console.log('\n=== 位移测量（归一化模型单位；全身高约 1.2，取景带 0.465）===')
  for (const c of out.cases) {
    console.log(`\n【${c.label}】动了的 drawable=${c.moved}/${out.N}`)
    console.log(`  整体包围盒 W=${c.bboxW} H=${c.bboxH}`)
    console.log(`  头宽 ${c.baseHeadW} → ${c.headW}（${((c.headW / c.baseHeadW - 1) * 100).toFixed(1)}%）   头中心 y ${c.baseHeadCY} → ${c.headCY}`)
    for (const z of ['head', 'torso', 'leg', 'foot']) {
      const q = c.zones[z]
      console.log(`  ${z.padEnd(6)}(n=${String(q.n).padStart(3)})  dx=${q.dx}  dy=${q.dy}`)
    }
  }
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
