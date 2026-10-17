// scripts/probe-bust-framing.mjs
// 一次性探针：把「肚脐以上特写」到底显示了哪一段，用真实渲染量出来。
//
// 目的：用户反馈"只显示一个肩膀和头部"。要回答两件事——
//   ① 当前可见的模型区域（画布归一化坐标）到底是 [?,?]×[?,?]，该显示的是 [头 ~ 肚脐]；
//   ② 是哪一个参数把它挤小的（缩放 / 位置偏移 / 裁剪区 / 镜像）。
//
// 做法：起隔离实例（可指定窗口尺寸与 live2d 设置），逐场景读回
//   · frameInfo（取景带、fit、rendered 矩形）
//   · 真实像素 alpha 包围盒（比数学矩形可信）
//   · 由 full 取景反推「美术在画布归一化坐标里的真实范围」（ground truth）
// 并落盘快照，供人眼比对。
//
// 用法：node scripts/probe-bust-framing.mjs [--w=430] [--h=645] [--scale=1.15] [--mirror=1]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
const SCALE = Number(arg('scale', 1.15))
const MIRROR = arg('mirror', '1') === '1'
const OUT = arg('out', 'E:/凪/tmp-framing')
mkdirSync(OUT, { recursive: true })

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-framing-'))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        llm: { provider: 'custom', model: 'x' },
        privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
        live2d: {
          modelPath: 'Maine/Maine.model3.json',
          frame: 'bust',
          scale: SCALE,
          mirror: MIRROR,
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
  return dir
}

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

/** 把一帧降采样成 ASCII 轮廓图——人眼（和没有图像通道的模型）都能直接看出裁在哪 */
async function asciiMap(page, cols = 56, rows = 60) {
  return page.evaluate(
    async ([cols, rows]) => {
      const url = window.__nagiSnapshot()
      if (!url) return ''
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = cols
      c.height = rows
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(img, 0, 0, cols, rows)
      const { data } = g.getImageData(0, 0, cols, rows)
      const lines = []
      for (let y = 0; y < rows; y++) {
        let s = ''
        for (let x = 0; x < cols; x++) {
          const a = data[(y * cols + x) * 4 + 3] / 255
          s += a > 0.6 ? '#' : a > 0.3 ? '+' : a > 0.08 ? '.' : a > 0.02 ? ',' : ' '
        }
        lines.push(String(y).padStart(2, ' ') + '|' + s + '|')
      }
      return lines.join('\n')
    },
    [cols, rows]
  )
}

/** 读一帧：取景信息 + 真实像素包围盒 + 快照 */
async function sample(page, tag) {
  const frame = await page.evaluate(() => window.__nagiFrame())
  const art = await page.evaluate(() => window.__nagiArtBox?.() ?? null)
  const snap = await page.evaluate(() => (typeof window.__nagiSnapshot === 'function' ? window.__nagiSnapshot() : null))
  if (snap) writeFileSync(join(OUT, `${tag}.png`), Buffer.from(snap.split(',')[1], 'base64'))
  return { frame, art }
}

/** 把屏幕像素包围盒换算成「模型画布归一化坐标」——这样才能和取景带的 0~1 直接比 */
function toCanvasNorm(frame, art) {
  if (!frame || !art || art.empty) return null
  const r = frame.fit.rendered
  return {
    fx0: (art.x0 - r.left) / r.width,
    fx1: (art.x1 - r.left) / r.width,
    fy0: (art.y0 - r.top) / r.height,
    fy1: (art.y1 - r.top) / r.height,
    // 画布可见窗口（0~1，越界=被裁）
    viewFx0: (0 - r.left) / r.width,
    viewFx1: (frame.canvas.w - r.left) / r.width,
    viewFy0: (0 - r.top) / r.height,
    viewFy1: (frame.canvas.h - r.top) / r.height
  }
}

const child = spawn(ELECTRON, ['.', `--user-data-dir=${newUserData()}`, `--remote-debugging-port=${PORT}`], {
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

  // 按住会干扰画面的层：待机动作 / Z 轴摆动 / 眨眼，保证两次采样可比
  await page.evaluate(() => {
    window.__nagiFreezeIdle?.(true)
    window.__nagiDepthConfig?.({ ambient: false })
    window.__nagiSetBlink?.(0)
    window.__nagiSetTremor?.(0)
  })
  await sleep(900)

  const scenes = [
    { tag: 'A_bust_scale1_nomirror', scale: 1, mirror: false, frame: 'bust' },
    { tag: 'B_bust_user', scale: SCALE, mirror: MIRROR, frame: 'bust' },
    { tag: 'C_bust_user_idle', scale: SCALE * 1.15, mirror: MIRROR, frame: 'bust' },
    { tag: 'D_full_truth', scale: 1, mirror: false, frame: 'full' }
  ]

  const out = { window: { w: W, h: H }, scenes: {} }
  for (const s of scenes) {
    await page.evaluate(
      ([f, sc, mi]) => {
        window.__nagiSetFrame?.(f)
        window.__nagiSetMirror?.(mi)
        window.__nagiSetScale?.(sc)
      },
      [s.frame, s.scale, s.mirror]
    )
    await sleep(1200)
    const r = await sample(page, s.tag)
    const norm = toCanvasNorm(r.frame, r.art)
    const ascii = await asciiMap(page)
    out.scenes[s.tag] = {
      scale: s.scale,
      mirror: s.mirror,
      canvas: r.frame?.canvas,
      rendered: r.frame?.fit?.rendered,
      band: r.frame?.band,
      artPx: r.art,
      norm
    }
    const f = r.frame
    console.log(
      `\n[${s.tag}] scale=${s.scale} mirror=${s.mirror} frame=${s.frame}\n` +
        `  canvas ${f?.canvas?.w}x${f?.canvas?.h}  取景带 fx[${f?.band?.preset?.left}, ${f?.band?.preset?.right}] fy[${f?.band?.preset?.top}, ${f?.band?.preset?.bottom}]\n` +
        `  rendered ${JSON.stringify(
          Object.fromEntries(Object.entries(f?.fit?.rendered || {}).map(([k, v]) => [k, Number(v.toFixed(1))]))
        )}\n` +
        `  真实像素包围盒 ${JSON.stringify(r.art)}\n` +
        `  换算到画布归一化：可见窗口 fx[${norm?.viewFx0.toFixed(3)}, ${norm?.viewFx1.toFixed(3)}] fy[${norm?.viewFy0.toFixed(3)}, ${norm?.viewFy1.toFixed(3)}]\n` +
        `  美术实际占位          fx[${norm?.fx0.toFixed(3)}, ${norm?.fx1.toFixed(3)}] fy[${norm?.fy0.toFixed(3)}, ${norm?.fy1.toFixed(3)}]`
    )
    // 额外诊断：模型自己报的屏幕包围盒 vs 真实像素覆盖率——两者对不上就说明"画出来了但没画全"
    const diag = await page.evaluate(async () => {
      const f = window.__nagiFrame()
      const url = window.__nagiSnapshot()
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(img, 0, 0)
      const { data } = g.getImageData(0, 0, c.width, c.height)
      let any = 0
      let solid = 0
      const rows = []
      for (let y = 0; y < c.height; y++) {
        let n = 0
        for (let x = 0; x < c.width; x++) {
          const a = data[(y * c.width + x) * 4 + 3]
          if (a > 8) {
            n++
            any++
            if (a > 128) solid++
          }
        }
        rows.push(n)
      }
      return {
        modelSize: f?.modelSize,
        original: f?.original,
        mocCanvas: f?.mocCanvas,
        bounds: f?.bounds,
        scale: f?.fit?.scale,
        snapSize: { w: c.width, h: c.height },
        coverageAny: any / (c.width * c.height),
        coverageSolid: solid / (c.width * c.height),
        firstRow: rows.findIndex((n) => n > 0),
        lastRow: rows.length - 1 - [...rows].reverse().findIndex((n) => n > 0)
      }
    })
    console.log(
      `  诊断 modelSize=${JSON.stringify(diag.modelSize)} original=${JSON.stringify(diag.original)} mocCanvas=${JSON.stringify(diag.mocCanvas)}\n` +
        `        bounds=${JSON.stringify(diag.bounds)} scale=${diag.scale?.toFixed(4)} 快照 ${diag.snapSize.w}x${diag.snapSize.h}\n` +
        `        像素覆盖 any=${(diag.coverageAny * 100).toFixed(1)}% solid=${(diag.coverageSolid * 100).toFixed(1)}% 有内容的行 ${diag.firstRow}~${diag.lastRow}`
    )
    if (process.argv.includes('--map')) {
      console.log(`\n--- ${s.tag} 轮廓（行号 = 画布自上而下 ${(645 / 60).toFixed(1)}px 一格）---`)
      console.log(ascii)
    }
  }

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(`\n快照与报告：${OUT}`)
  await browser.close()
} finally {
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
}
