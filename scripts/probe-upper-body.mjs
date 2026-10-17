// scripts/probe-upper-body.mjs
// 一次性探针：量出「肚脐以上上半身」在模型画布里的**真实横向范围**。
//
// 为什么要单独量：全身的横向范围（含裙摆/腿/垂手）比上半身宽，
// 直接拿全身范围当取景带会把上半身缩得很小；而只量头肩又会裁掉双臂。
//
// 做法：full 取景（整只模型完整可见、无裁切）渲染一帧，按 fy 逐档统计
// 每一行的 alpha 像素横向范围 → 换回画布归一化 fx。
//
// 用法：node scripts/probe-upper-body.mjs [--w=430] [--h=645]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const W = Number(arg('w', 430))
const H = Number(arg('h', 645))

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = '9334'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'nagi-upper-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: {
        modelPath: 'Maine/Maine.model3.json',
        frame: 'full',
        scale: 1,
        mirror: false,
        petWidth: W,
        petHeight: H,
        idleBoost: false,
        outfit: 'lazy'
      }
    },
    null,
    2
  ),
  'utf8'
)

async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return false
}

async function findPage(browser, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const ok = await page.evaluate(
            () => document.body?.dataset?.mode === 'pet' && typeof window.__nagiFrame === 'function' && !!window.__nagiFrame()
          )
          if (ok) return page
        } catch {
          /* 页面还在导航 */
        }
      }
    }
    await sleep(400)
  }
  return null
}

const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: (() => {
    const e = { ...process.env }
    delete e.ELECTRON_RUN_AS_NODE
    e.NAGI_MODE = 'pet'
    e.NAGI_RENDERER_SANDBOX = '0'
    return e
  })(),
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

try {
  if (!(await waitForCdp(PORT))) throw new Error('CDP 起不来')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const page = await findPage(browser)
  if (!page) throw new Error('找不到桌宠页')
  await sleep(1500)

  await page.evaluate(() => {
    window.__nagiSetFrame?.('full')
    window.__nagiSetMirror?.(false)
    window.__nagiSetScale?.(1)
    window.__nagiFreezeIdle?.(true)
    window.__nagiDepthConfig?.({ ambient: false })
    window.__nagiSetBlink?.(0)
    window.__nagiSetTremor?.(0)
  })
  await sleep(1200)

  const frame = await page.evaluate(() => window.__nagiFrame())
  const rows = await page.evaluate(async () => {
    const url = window.__nagiSnapshot()
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const { data } = g.getImageData(0, 0, img.width, img.height)
    const out = []
    for (let y = 0; y < img.height; y++) {
      let lo = -1
      let hi = -1
      let n = 0
      for (let x = 0; x < img.width; x++) {
        if (data[(y * img.width + x) * 4 + 3] > 8) {
          if (lo < 0) lo = x
          hi = x
          n++
        }
      }
      out.push({ y, lo, hi, n })
    }
    return { rows: out, w: img.width, h: img.height }
  })

  const r = frame.fit.rendered
  const toFy = (y) => (y - r.top) / r.height
  const toFx = (x) => (x - r.left) / r.width

  console.log(`画布 ${rows.w}x${rows.h}  full 取景 rendered ${JSON.stringify(r)}`)
  console.log('（fx/fy 都是模型画布归一化坐标；fy=0.48 是肚脐线）\n')

  // 目标段：头顶 0.030 ~ 肚脐 0.48
  const LO = 0.03
  const HI = 0.48
  let lo = Infinity
  let hi = -Infinity
  for (const row of rows.rows) {
    if (row.lo < 0) continue
    const fy = toFy(row.y)
    if (fy < LO || fy > HI) continue
    lo = Math.min(lo, row.lo)
    hi = Math.max(hi, row.hi)
  }
  console.log(`上半身（fy ${LO}~${HI}）横向：像素 x[${lo}, ${hi}]  →  fx[${toFx(lo).toFixed(4)}, ${toFx(hi).toFixed(4)}]`)
  console.log(`  宽度 ${(toFx(hi) - toFx(lo)).toFixed(4)}  中心 ${((toFx(lo) + toFx(hi)) / 2).toFixed(4)}\n`)

  // 逐档剖面：每 0.03 一档，看头/肩/臂/腰各在哪、多宽
  console.log('逐档横向剖面（每档 = 该 fy 区间内所有像素行的并集）：')
  for (let a = 0.02; a < 0.62; a += 0.04) {
    const b = a + 0.04
    let l = Infinity
    let h = -Infinity
    for (const row of rows.rows) {
      if (row.lo < 0) continue
      const fy = toFy(row.y)
      if (fy < a || fy >= b) continue
      l = Math.min(l, row.lo)
      h = Math.max(h, row.hi)
    }
    if (!Number.isFinite(l)) {
      console.log(`  fy [${a.toFixed(2)}, ${b.toFixed(2)})  空`)
      continue
    }
    const w = toFx(h) - toFx(l)
    const bar = '#'.repeat(Math.max(0, Math.round(w * 56)))
    console.log(
      `  fy [${a.toFixed(2)}, ${b.toFixed(2)})  fx[${toFx(l).toFixed(3)}, ${toFx(h).toFixed(3)}]  宽 ${w.toFixed(3)}  |${bar}`
    )
  }

  // 上半身 ASCII（只画 fy 0.02~0.52，横向画整个画布宽）
  console.log('\n上半身轮廓（fy 0.02~0.52，横向整幅画布；行号 = fy）：')
  const map = await page.evaluate(async () => {
    const url = window.__nagiSnapshot()
    const img = new Image()
    img.src = url
    await img.decode()
    const cols = 56
    const rowsN = 34
    const c = document.createElement('canvas')
    c.width = cols
    c.height = rowsN
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0, cols, rowsN)
    const { data } = g.getImageData(0, 0, cols, rowsN)
    const lines = []
    for (let y = 0; y < rowsN; y++) {
      let s = ''
      for (let x = 0; x < cols; x++) {
        const a = data[(y * cols + x) * 4 + 3] / 255
        s += a > 0.6 ? '#' : a > 0.3 ? '+' : a > 0.08 ? '.' : a > 0.02 ? ',' : ' '
      }
      lines.push(s)
    }
    return lines
  })
  console.log(
    map
      .map((s, i) => `  ${(0.02 + (i / map.length) * 0.5).toFixed(3)}|${s}|`)
      .join('\n')
  )
} finally {
  child.kill()
}
