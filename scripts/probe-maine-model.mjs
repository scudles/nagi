// 模型内部结构探针：读 drawable 顶点范围（定位头/躯干/腿的几何位置）与参数值域。
// 用法：node scripts/probe-maine-model.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve('E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi')
const PORT = 8796
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
  const page = await browser.newPage({ viewport: { width: 400, height: 700 } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 15000 })

  const out = await page.evaluate(async () => {
    const PIXI = window.PIXI
    const m = await PIXI.live2d.Live2DModel.from('/models/Maine/Maine.model3.json', { autoInteract: false })
    const raw = m.internalModel.coreModel._model
    const ci = raw.canvasinfo
    const W = ci.CanvasWidth, H = ci.CanvasHeight

    // 顶点：模型坐标（y 向上，原点画布中心）→ 归一化 fy（y 向下，0=画布顶）
    const toFy = (y) => 0.5 - y / H
    const toFx = (x) => 0.5 + x / W

    const vcounts = raw.drawables.vertexCounts
    const vpAll = raw.drawables.vertexPositions // 数组：每元素 = 一个 drawable 的顶点数组（已归一化 0~1，左上原点）
    const dIds = raw.drawables.ids
    const draws = []
    for (let i = 0; i < raw.drawables.count; i++) {
      const vp = vpAll[i]
      if (!vp) continue
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
      for (let k = 0; k < vp.length; k += 2) {
        const vx = vp[k], vy = vp[k + 1]
        if (vx < x0) x0 = vx
        if (vx > x1) x1 = vx
        if (vy < y0) y0 = vy
        if (vy > y1) y1 = vy
      }
      draws.push({
        i, id: String(dIds[i]),
        fy0: +y0.toFixed(3), fy1: +y1.toFixed(3), // fy0=上缘（y 向下）
        fx0: +x0.toFixed(3), fx1: +x1.toFixed(3),
        nVert: vp.length / 2
      })
    }

    // 参数值域
    const pIds = raw.parameters.ids
    const pMin = raw.parameters.minimumValues
    const pMax = raw.parameters.maximumValues
    const pDef = raw.parameters.defaultValues
    const params = []
    for (let i = 0; i < raw.parameters.count; i++) {
      params.push({ id: String(pIds[i]), min: pMin[i], max: pMax[i], def: pDef[i] })
    }
    return { W, H, draws, params }
  })

  console.log(`moc 画布 ${out.W}×${out.H}`)

  const want = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamBodyScaleX', 'ParamBodyScaleY', 'ParamBreath', 'ParamEyeBallX', 'ParamEyeBallY',
    'ParamEyeLOpen', 'ParamEyeROpen', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLForm', 'ParamBrowRForm',
    'ParamBrowLY2', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamCheek', 'Param19', 'Param24', 'Param25',
    'Param29', 'Param15', 'Param30999', 'ParamEyeLSmile', 'ParamEyeRSmile', 'Param2', 'Param3', 'Param4']
  console.log('\n=== 参数值域（min/max/default）===')
  for (const p of out.params) {
    if (want.includes(p.id)) console.log(`  ${p.id.padEnd(18)} min=${String(p.min).padStart(7)} max=${String(p.max).padStart(7)} def=${String(p.def).padStart(6)}`)
  }
  console.log('  参数总数:', out.params.length)

  // 按 fy 位置分组的 drawable（只列覆盖中上躯干的）
  console.log('\n=== drawable 顶点范围（fy0=上缘, fy1=下缘）===')
  const list = out.draws.filter((d) => d.nVert > 0).sort((a, b) => a.fy0 - b.fy0)
  for (const d of list.slice(0, 70)) {
    if (d.fy1 - d.fy0 > 0.9) continue // 全幅背景/特效类
    console.log(`  #${String(d.i).padStart(3)} fy[${d.fy0.toFixed(3)},${d.fy1.toFixed(3)}] fx[${d.fx0.toFixed(3)},${d.fx1.toFixed(3)}] v=${String(d.nVert).padStart(4)} order=${d.renderOrder} dbl=${d.isDoubleSided ? 'Y' : 'N'} blend=${d.blend}`)
  }
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}
