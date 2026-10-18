// 临时探针（2026-10-17）：结构自检 —— 找顶点缓冲的正确访问路径。
// probe-body-vertex.mjs 读 raw.drawables.vertexPositions 得到几乎全零（547 个 drawable
// 全被归进同一个区），说明那条路径不是变形后的几何。这里把 candidates 逐一试出来。
// 用法：node scripts/probe-vertex-introspect.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8801
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
    const info = {}

    info.rawKeys = Object.keys(raw)
    info.rawProto = Object.getOwnPropertyNames(Object.getPrototypeOf(raw))
    info.drawablesKeys = raw.drawables ? Object.keys(raw.drawables) : null
    info.coreProto = Object.getOwnPropertyNames(Object.getPrototypeOf(core))

    // 候选顶点路径
    const cands = {
      'raw.drawables.vertexPositions': () => raw.drawables?.vertexPositions,
      'raw.drawables.dynamicVertexPositions': () => raw.drawables?.dynamicVertexPositions,
      'raw.drawables.staticVertexPositions': () => raw.drawables?.staticVertexPositions,
      'core.drawables.vertexPositions': () => core.drawables?.vertexPositions,
      'core.drawables.dynamicVertexPositions': () => core.drawables?.dynamicVertexPositions,
      'core.drawables.staticVertexPositions': () => core.drawables?.staticVertexPositions,
      'core._drawables.vertexPositions': () => core._drawables?.vertexPositions,
      'core._drawables.dynamicVertexPositions': () => core._drawables?.dynamicVertexPositions
    }
    info.candidates = {}
    for (const [name, fn] of Object.entries(cands)) {
      try {
        const v = fn()
        if (!v) { info.candidates[name] = 'absent'; continue }
        const a = Array.isArray(v) ? v : null
        const sample = a ? a[0] : v[0]
        info.candidates[name] = {
          type: a ? 'array' : typeof v,
          len: v.length,
          sample0: sample ? { len: sample.length, head: Array.from(sample.slice(0, 6)) } : null
        }
      } catch (e) { info.candidates[name] = 'throw: ' + e.message }
    }

    // 用最像的那条做 baseline / ParamAngleZ=-8 对比
    try { m.internalModel.motionManager?.stopAllMotions() } catch {}
    const ids = raw.parameters.ids
    const defs = raw.parameters.defaultValues
    const resetAll = () => {
      for (let i = 0; i < ids.length; i++) core.setParameterValueById(ids[i], defs[i])
      core.update()
      if (typeof core.drawables?.update === 'function') core.drawables.update()
      if (typeof raw.drawables?.update === 'function') raw.drawables.update()
    }
    const paths = ['raw.drawables.vertexPositions', 'core.drawables.vertexPositions', 'raw.drawables.dynamicVertexPositions', 'core.drawables.dynamicVertexPositions']
    const get = (p) => p.split('.').reduce((o, k) => o?.[k], { raw, core })
    info.probe = {}
    for (const p of paths) {
      const res = {}
      for (const [label, param] of [['base', {}], ['z-8', { ParamAngleZ: -8 }]]) {
        resetAll()
        for (const [id, v] of Object.entries(param)) core.setParameterValueById(id, v)
        core.update()
        if (typeof core.drawables?.update === 'function') core.drawables.update()
        if (typeof raw.drawables?.update === 'function') raw.drawables.update()
        const arr = get(p)
        if (!arr || !arr.length) { res[label] = 'absent'; continue }
        // 全部 drawable 合并的顶点范围 + 非零点位数
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, nz = 0, tot = 0
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i]
          if (!v || !v.length) continue
          for (let k = 0; k < v.length; k += 2) {
            const X = v[k], Y = v[k + 1]
            if (X !== 0 || Y !== 0) nz++
            tot++
            if (X < x0) x0 = X
            if (X > x1) x1 = X
            if (Y < y0) y0 = Y
            if (Y > y1) y1 = Y
          }
        }
        res[label] = { drawables: arr.length, nz, tot, x: [+x0.toFixed(1), +x1.toFixed(1)], y: [+y0.toFixed(1), +y1.toFixed(1)] }
      }
      info.probe[p] = res
    }
    info.paramIds = ids.filter((id) => /Angle/.test(id))
    return info
  })

  console.log(JSON.stringify(out, null, 2))
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}
