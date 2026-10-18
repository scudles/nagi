// 临时探针（2026-10-17）：全精度顶点位移测量。
// 回答：ParamBodyAngleX / ParamAngleX 在缅因模型上到底动不动、动哪些部件、动多少。
// 像素法在本模型失效（待机+物理噪声底 15.55%），所以直读 CubismCore 变形后顶点。
// 用法：node scripts/probe-body-vertex2.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8802
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
    const V = () => raw.drawables.vertexPositions

    // 冻结待机动作（顶点读取不依赖渲染，但 stopAllMotions 让参数回到 motion 外状态）
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}

    // 把每个 drawable 的顶点压成统计量：中心 + bbox + 顶点数
    const stats = () => {
      const vp = V()
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
        res.push({ cx: cx / n, cy: cy / n, x0, x1, y0, y1, n })
      }
      return res
    }

    const setAll = (params) => {
      // 先全部回默认，再叠加测试参数
      const pids = raw.parameters.ids
      const defs = raw.parameters.defaultValues
      for (let i = 0; i < pids.length; i++) core.setParameterValueById(pids[i], defs[i])
      for (const [id, v] of Object.entries(params)) core.setParameterValueById(id, v)
      core.update()
    }

    const base = stats()
    setAll({}) // baseline 显式重算一遍
    const base2 = stats()
    // 自检：连算两次 baseline 应完全一致
    let identical = true
    for (let i = 0; i < N; i++) {
      const a = base[i], b = base2[i]
      if (!a || !b) continue
      if (Math.abs(a.cx - b.cx) > 1e-9 || Math.abs(a.cy - b.cy) > 1e-9) identical = false
    }

    // 用 baseline 的 cy 给 drawable 分区（归一化模型单位：y 向上，全身约 [-0.6,+0.6]）
    const zoneOf = (cy) => (cy > 0.25 ? 'head' : cy > -0.15 ? 'torso' : cy > -0.45 ? 'leg' : 'foot')
    const zones = ['head', 'torso', 'leg', 'foot']
    const zoneBase = {}
    for (const z of zones) zoneBase[z] = []
    for (let i = 0; i < N; i++) {
      const a = base[i]
      if (!a) continue
      zoneBase[zoneOf(a.cy)].push(i)
    }

    const cases = [
      ['ParamAngleZ -8（已知有效，作 harness 对照）', { ParamAngleZ: -8 }],
      ['ParamAngleX -8（抬头）', { ParamAngleX: -8 }],
      ['ParamAngleX +8（低头）', { ParamAngleX: 8 }],
      ['ParamBodyAngleX -8', { ParamBodyAngleX: -8 }],
      ['ParamBodyAngleX -10', { ParamBodyAngleX: -10 }],
      ['ParamBodyAngleX +10', { ParamBodyAngleX: 10 }],
      ['ParamBodyAngleZ -10', { ParamBodyAngleZ: -10 }],
      ['ParamAngleY +10', { ParamAngleY: 10 }]
    ]
    const report = []
    for (const [label, params] of cases) {
      setAll(params)
      const s = stats()
      const movers = []
      let anyMove = false
      for (let i = 0; i < N; i++) {
        const a = base[i], b = s[i]
        if (!a || !b) continue
        const d = Math.hypot(b.cx - a.cx, b.cy - a.cy)
        const dh = (b.y1 - b.y0) - (a.y1 - a.y0)
        if (d > 1e-6 || Math.abs(dh) > 1e-6) {
          anyMove = true
          movers.push({ id: ids[i], cx: +(b.cx - a.cx).toFixed(5), cy: +(b.cy - a.cy).toFixed(5), dH: +dh.toFixed(5), d: +d.toFixed(5) })
        }
      }
      movers.sort((p, q) => q.d - p.d)
      // 分区汇总：各类部件的**平均**位移（去掉单点极值噪声）
      const zs = {}
      for (const z of zones) {
        const arr = zoneBase[z]
        if (!arr.length) { zs[z] = null; continue }
        let sx = 0, sy = 0, sd = 0
        for (const i of arr) {
          const a = base[i], b = s[i]
          sx += b.cx - a.cx; sy += b.cy - a.cy
          sd += Math.hypot(b.cx - a.cx, b.cy - a.cy)
        }
        zs[z] = { n: arr.length, dx: +(sx / arr.length).toFixed(4), dy: +(sy / arr.length).toFixed(4), d: +(sd / arr.length).toFixed(4) }
      }
      report.push({
        label,
        moved: movers.length,
        anyMove,
        zones: zs,
        top: movers.slice(0, 6)
      })
    }
    return { N, identical, sampleIds: Array.from(ids).slice(0, 8), report }
  })

  console.log(`drawable 数 ${out.N}；两次 baseline 完全一致：${out.identical}`)
  for (const r of out.report) {
    console.log(`\n【${r.label}】有位移的 drawable：${r.moved}/${out.N}`)
    if (!r.moved) { console.log('  → 全部为 0：该参数未绑定任何变形器'); continue }
    const z = r.zones
    console.log(`  分区平均位移  头(n=${z.head?.n}): dx=${z.head?.dx} dy=${z.head?.dy} |d|=${z.head?.d}`)
    console.log(`               躯(n=${z.torso?.n}): dx=${z.torso?.dx} dy=${z.torso?.dy} |d|=${z.torso?.d}`)
    console.log(`               腿(n=${z.leg?.n}): dx=${z.leg?.dx} dy=${z.leg?.dy} |d|=${z.leg?.d}`)
    console.log(`               脚(n=${z.foot?.n}): dx=${z.foot?.dx} dy=${z.foot?.dy} |d|=${z.foot?.d}`)
    for (const t of r.top) console.log(`  最大单件 ${t.id.padEnd(14)} dx=${t.cx} dy=${t.cy} dH=${t.dH} |d|=${t.d}`)
  }
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
