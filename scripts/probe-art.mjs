// 一次性探针：量「美术真实范围」在声明画布里的归一化坐标（relative to moc canvas）。
// 做法：用 full 取景 + 小缩放让整张画布可见，再读像素求 alpha 包围盒，反推 fx/fy。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'
const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9455
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ud = mkdtempSync(join(tmpdir(), 'nagi-probe-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ llm: { provider: 'custom', model: 'x' }, privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true }, live2d: { frame: 'full', scale: 1, petWidth: 400, petHeight: 600 } }),
  'utf8'
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

try {
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      ok = r.ok
    } catch {}
    if (!ok) await sleep(400)
  }
  if (!ok) throw new Error('CDP 未就绪')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const m = await p.evaluate(() => document.body?.dataset?.mode)
          if (m === 'pet' && (await p.evaluate(() => typeof window.__nagiFrame === 'function' && !!window.__nagiFrame()))) page = p
        } catch {}
      }
    }
    if (!page) await sleep(400)
  }
  if (!page) throw new Error('桌宠页未就绪')

  for (const [frame, scale] of [['full', 0.85], ['full', 0.6], ['bust', 1]]) {
    await page.evaluate(([f, s]) => {
      window.__nagiSetFrame(f)
      window.__nagiSetScale(s)
    }, [frame, scale])
    await sleep(900)
    const fi = await page.evaluate(() => window.__nagiFrame())
    const ab = await page.evaluate(() => window.__nagiArtBox())
    const cw = fi.canvas.w
    const chh = fi.canvas.h
    // 反推 model 局部坐标系：anchor 把局部 (0.5W, anchorY*H) 映射到 (pos.x, pos.y)
    const s = fi.scale.x
    const W = fi.modelSize.w
    const H = fi.modelSize.h
    const ox = fi.pos.x - 0.5 * W * s
    const oy = fi.pos.y - fi.anchor.y * H * s
    const fx0 = (ab.x0 - ox) / (W * s)
    const fx1 = (ab.x1 - ox) / (W * s)
    const fy0 = (ab.y0 - oy) / (H * s)
    const fy1 = (ab.y1 - oy) / (H * s)
    console.log(`frame=${frame} scale=${scale} canvas=${cw}x${chh} modelSize=${W}x${H} scale=${s.toFixed(4)}`)
    console.log(`  pos=(${fi.pos.x.toFixed(1)},${fi.pos.y.toFixed(1)}) anchorY=${fi.anchor.y} band=${fi.band.w.toFixed(0)}x${fi.band.h.toFixed(0)} navail=${(cw).toFixed(0)}`)
    console.log(`  美术像素 bbox = [${ab.x0},${ab.y0}]~[${ab.x1},${ab.y1}]  (画布 ${ab.w}x${ab.h})`)
    console.log(`  → 归一化 fx=[${fx0.toFixed(3)},${fx1.toFixed(3)}]  fy=[${fy0.toFixed(3)},${fy1.toFixed(3)}]`)
  }
} finally {
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
}
