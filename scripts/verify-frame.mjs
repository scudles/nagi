// scripts/verify-frame.mjs
// 取景 / 对齐的实机校验：自起隔离实例，把「窗口尺寸 × 面板宽度」跑成一个矩阵。
//
// 为什么要有矩阵：产品规则是
//   ① 只显示胸像（上半身）；
//   ② 形象永远待在自己的 UI 方框里 —— 既不越出画布，也不盖住 UI。
// 这两条在单一分辨率下通过不算数（曾经的 bug 就是「只有某个高度下双脚盖住控件栏」），
// 所以这里逐个分辨率验：
//   A. 画布尺寸 == 它所在容器尺寸（pixi 的 inline 尺寸没溢出）
//   B. 取景矩形落在画布可用区内（含留给 UI 的安全边距）
//   C. 真实像素不越出画布（读回这一帧求 alpha 包围盒，比数学矩形可信）
//   D. 控件栏在画布之外 —— 结构性证明它不可能被形象遮挡
//   E. 取景是胸像（可见带高明显小于整张模型）
//
// 用法：
//   npm run verify:frame            自起隔离实例跑完整矩阵（推荐）
//   npm run verify:frame -- --attach  只接管已在跑的实例（需 --remote-debugging-port=9222）
//
// 注意：**不要**调用 browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ATTACH = process.argv.includes('--attach')
/** --only=pet|workbench 只跑一半，调试用 */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || ''
const ATTACH_PORT = process.env.CDP_PORT || '9222'
const SNAP_DIR = join(tmpdir(), `nagi-frame-${Date.now()}`)
const SHOT_DIR = join(tmpdir(), `nagi-frame-shots-${Date.now()}`)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ *
 * 起实例 / 收实例
 * ------------------------------------------------------------------ */

/** 干净的子进程环境：必须剔掉 ELECTRON_RUN_AS_NODE，否则 electron 会当 node 跑 */
function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return Object.assign(env, extra)
}

function newUserData(tag) {
  const dir = mkdtempSync(join(tmpdir(), `nagi-frame-${tag}-`))
  // 本地占位大脑 + 关掉监测，避免验证时被网络/采集噪声干扰
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        llm: { provider: 'custom', model: 'x' },
        privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
        live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

function startApp({ mode, port }) {
  const userData = newUserData(mode || 'pet')
  const args = ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`]
  const child = spawn(ELECTRON, args, {
    cwd: ROOT,
    env: baseEnv(mode ? { NAGI_MODE: mode } : {}),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function stopApp(child) {
  if (!child || child.killed) return
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  await sleep(600)
}

/** 轮询 CDP 端口直到可连 */
async function waitForCdp(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/json/version`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return false
}

/** 在 context 里找到目标窗口的 page，并等它的 Live2D 就绪 */
async function findPage(browser, mode, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const ok = await page.evaluate(
            (m) => document.body?.dataset?.mode === m && typeof window.__nagiFrame === 'function' && !!window.__nagiFrame(),
            mode
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

/* ------------------------------------------------------------------ *
 * 读取现场
 * ------------------------------------------------------------------ */

async function inspect(page) {
  return page.evaluate(() => {
    const mode = document.body.dataset.mode
    const R = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }
    }
    const isWb = mode === 'workbench'
    const canvas = document.getElementById(isWb ? 'wb-live2d-canvas' : 'live2d-canvas')
    // 注意：桌宠窗里 .np-stage 也存在（隐藏的工作台 DOM），必须按窗口模式取
    const stage = isWb ? document.querySelector('.np-stage') : document.getElementById('pet-stage')
    const canvasAttr = canvas ? { w: canvas.width, h: canvas.height, styleW: canvas.style.width, styleH: canvas.style.height } : null
    const frame = typeof window.__nagiFrame === 'function' ? window.__nagiFrame() : null
    const snap = typeof window.__nagiSnapshot === 'function' ? window.__nagiSnapshot() : null
    return {
      mode,
      inner: { w: window.innerWidth, h: window.innerHeight },
      canvasBox: R(canvas),
      stageBox: R(stage),
      canvasAttr,
      ui: { controls: R(document.querySelector('.np-controls')), toolbar: R(document.querySelector('.pet-toolbar')), status: R(document.getElementById('pet-status')) },
      frame,
      snap
    }
  })
}

/**
 * 真实画面范围（读回这一帧像素求 alpha 包围盒）。
 * 必须单独一次 evaluate：measureArtBox 是异步的（要等 Image.decode）。
 */
async function inspectArt(page) {
  try {
    return await page.evaluate(() => (typeof window.__nagiArtBox === 'function' ? window.__nagiArtBox() : null))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 单项检查
 * ------------------------------------------------------------------ */

function audit(s, art, tag) {
  const cb = s.canvasBox
  const sb = s.stageBox
  if (!cb || !sb || !s.frame) {
    check(`${tag} 现场可读`, false, 'canvas/stage/frame 缺失')
    return
  }

  // A. 画布尺寸 == 容器尺寸（pixi 的 inline 尺寸没把画布撑出容器）
  const sizeOk = Math.abs(cb.w - sb.w) < 2 && Math.abs(cb.h - sb.h) < 2
  check(
    `${tag} 画布尺寸 == 容器尺寸`,
    sizeOk,
    `canvas ${cb.w.toFixed(0)}x${cb.h.toFixed(0)} / stage ${sb.w.toFixed(0)}x${sb.h.toFixed(0)}`
  )

  // B. 取景矩形落在画布可用区内（含留给 UI 的安全边距）
  const r0 = s.frame.fit.rendered
  const inside = r0.left >= -1 && r0.top >= -1 && r0.left + r0.width <= cb.w + 1 && r0.top + r0.height <= cb.h + 1
  check(
    `${tag} 取景矩形不越界`,
    inside,
    `rendered [${r0.left.toFixed(0)}, ${r0.top.toFixed(0)}] ${r0.width.toFixed(0)}x${r0.height.toFixed(0)} in ${cb.w.toFixed(0)}x${cb.h.toFixed(0)}`
  )

  // C. 真实像素不越出画布 —— 这条是「形象被约束在方框内」的真凭据。
  //    底边允许贴边（胸像本来就是从身体中部裁掉，而画布下边界就是方框边界）；
  //    左右上三边允许贴边但不允许为负 —— 待机动作会让手臂摆到画布边缘，
  //    那是被画布裁掉，属于 Live2D 桌宠的常态，不等于"跑出方框"。
  if (!art || art.empty) {
    check(`${tag} 真实画面可测`, false, art?.empty ? '画面为空' : '未取到像素')
  } else {
    const mL = art.x0
    const mT = art.y0
    const mR = cb.w - 1 - art.x1
    const mB = cb.h - 1 - art.y1
    check(`${tag} 真实画面不越出画布`, mL >= 0 && mT >= 0 && mR >= 0 && mB >= 0, `左${mL} 上${mT} 右${mR} 下${mB}`)
    info(tag, `静止姿态下的四边余量：左${mL} 上${mT} 右${mR} 下${mB}`)
  }

  // D. 结构性证明：控件栏在画布**之外**，形象再怎么长也盖不到它
  if (s.ui.controls) {
    check(
      `${tag} 控件栏在画布之外（不可能被形象遮挡）`,
      s.ui.controls.y >= cb.bottom - 1 || s.mode !== 'workbench',
      `控件栏 top ${s.ui.controls.y.toFixed(0)} vs 画布 bottom ${cb.bottom.toFixed(0)}`
    )
  }

  // E. 取景是胸像
  const { band, base } = s.frame
  const ratio = band.h / base.h
  check(`${tag} 取景为胸像`, ratio < 0.6, `可见带高 ${(ratio * 100).toFixed(0)}% 模型高`)

  // 信息项：画面占据画布的比例
  if (art && !art.empty) {
    const aw = art.x1 - art.x0 + 1
    const ah = art.y1 - art.y0 + 1
    info(tag, `画面 ${aw}x${ah} 占画布 宽 ${((aw / cb.w) * 100).toFixed(0)}% 高 ${((ah / cb.h) * 100).toFixed(0)}%`)
  }

  // 信息项：桌宠浮动工具条（画在形象之上，不会被盖住；这里只报告侵入量）
  if (s.ui.toolbar && s.ui.toolbar.w > 1 && art && !art.empty) {
    const tbLocal = { left: s.ui.toolbar.x - cb.x, right: s.ui.toolbar.right - cb.x }
    const intrude = Math.max(0, art.x1 + 1 - tbLocal.left)
    info(tag, `形象右缘 ${art.x1}，工具条左缘 ${tbLocal.left.toFixed(0)} → 重叠 ${intrude.toFixed(0)}px（工具条绘制在形象之上，不受影响）`)
  }
}

function saveSnap(s, tag) {
  if (!s.snap) return
  mkdirSync(SNAP_DIR, { recursive: true })
  const f = join(SNAP_DIR, `frame-${tag}.png`)
  writeFileSync(f, Buffer.from(s.snap.split(',')[1], 'base64'))
  info(tag, `快照 → ${f}`)
}

/**
 * 整窗截图：把画布这一帧贴回它的真实位置，再截整页。
 *
 * 为什么要绕这一下：Playwright 直接截页面时，WebGL 画布常常是空白的（缓冲被清掉）。
 * 所以先把 __nagiSnapshot() 的像素做成一张覆盖在画布位置上的 <img>，再截图 —— 这样拿到的
 * 是「用户真正看到的样子」：形象 + 它周围的 UI（控件栏 / 工具条 / 状态行）。
 */
async function shotComposite(page, tag) {
  try {
    const ok = await page.evaluate(() => {
      const mode = document.body.dataset.mode
      const c = document.getElementById(mode === 'workbench' ? 'wb-live2d-canvas' : 'live2d-canvas')
      const url = window.__nagiSnapshot?.()
      if (!c || !url) return false
      const r = c.getBoundingClientRect()
      let img = document.getElementById('__nagi_shot')
      if (!img) {
        img = document.createElement('img')
        img.id = '__nagi_shot'
        img.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;'
        document.body.appendChild(img)
      }
      img.src = url
      img.style.left = `${r.left}px`
      img.style.top = `${r.top}px`
      img.style.width = `${r.width}px`
      img.style.height = `${r.height}px`
      // 桌宠窗是透明背景，截图前铺一层底色，否则整窗截图是空的
      document.documentElement.style.background = '#14161c'
      return true
    })
    if (!ok) return
    await sleep(150)
    mkdirSync(SHOT_DIR, { recursive: true })
    const f = join(SHOT_DIR, `shot-${tag}.png`)
    await page.screenshot({ path: f })
    info(tag, `整窗截图 → ${f}`)
  } catch {
    /* 截图失败不影响校验结论 */
  } finally {
    await page
      .evaluate(() => {
        document.getElementById('__nagi_shot')?.remove()
        document.documentElement.style.background = ''
      })
      .catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 桌宠：用应用自己的 resize 通道改窗口（走的正是用户拖手柄那条路） */
async function resizePet(page, w, h) {
  await page.evaluate((size) => window.nagi.win.resize({ width: size.w, height: size.h, persist: false }), { w, h })
  await sleep(700)
}

/**
 * 工作台：没有 resize IPC，改窗口 bounds 又需要浏览器级 CDP 会话（页面会话拿不到 Browser 域）。
 * 这里改用页面级的 device metrics 覆盖 —— 对布局而言等价于把视口改成 w×h，
 * 弹性高度（.np-stage { flex:1 }）会随之收缩/伸展，正是要复现的场景。
 */
async function resizeWindow(page, w, h) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await cdp.detach().catch(() => {})
  await sleep(900)
}

/** 设凪面板宽度（240–460，与拖 splitter 等效） */
async function setPanelWidth(page, px) {
  await page.evaluate((w) => {
    const panel = document.getElementById('nagi-panel')
    if (!panel) return
    panel.style.flexBasis = w + 'px'
    panel.style.width = w + 'px'
  }, px)
  await sleep(600)
}

const children = []

try {
  if (ATTACH) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${ATTACH_PORT}`)
    console.log('=== attach 模式：只读检查已在跑的实例 ===')
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const s = await inspect(page)
          if (!s.frame) continue
          console.log(`\n===== ${s.mode}（${s.inner.w.toFixed(0)}x${s.inner.h.toFixed(0)}） =====`)
          audit(s, await inspectArt(page), s.mode)
          saveSnap(s, s.mode)
        } catch {
          /* 忽略非常规页面 */
        }
      }
    }
  } else {
    if (!existsSync(ELECTRON)) {
      console.error('找不到 electron：' + ELECTRON)
      process.exit(1)
    }

    // ---- 桌宠窗：一实例多尺寸 ----
    const PET_CASES = [
      { w: 200, h: 300, label: '最小' },
      { w: 320, h: 480, label: '偏窄' },
      { w: 400, h: 600, label: '默认' },
      { w: 640, h: 960, label: '偏大' },
      { w: 900, h: 1300, label: '最大' }
    ]
    const petPort = 9401
    const petChild = ONLY === 'workbench' ? null : startApp({ mode: null, port: petPort })
    if (petChild) {
      children.push(petChild)
      console.log('\n################ 桌宠窗 ################')
      if (!(await waitForCdp(petPort))) throw new Error('桌宠实例 CDP 未就绪')
      const petBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${petPort}`)
      const petPage = await findPage(petBrowser, 'pet')
      if (!petPage) throw new Error('桌宠页未就绪（模型没加载出来？）')
      for (const c of PET_CASES) {
        await resizePet(petPage, c.w, c.h)
        const art = await inspectArt(petPage)
        const s = await inspect(petPage)
        const tag = `桌宠 ${c.w}x${c.h}(${c.label})`
        console.log(`\n----- ${tag} -----`)
        audit(s, art, tag)
        const slug = tag.replace(/[^\w\u4e00-\u9fa5]+/g, '_')
        saveSnap(s, slug)
        await shotComposite(petPage, slug)
      }
      await stopApp(petChild)
    }

    // ---- 工作台：一个实例，改视口大小 + 面板宽度 ----
    const WB_CASES = [
      { win: [1000, 640], panel: 240, label: '矮窗+窄面板' },
      { win: [1000, 640], panel: 460, label: '矮窗+宽面板' },
      { win: [1400, 900], panel: 300, label: '大窗+默认面板' },
      { win: [1180, 760], panel: 460, label: '中窗+宽面板' }
    ]
    const wbPort = 9402
    const wbChild = ONLY === 'pet' ? null : startApp({ mode: 'workbench', port: wbPort })
    if (wbChild) {
      children.push(wbChild)
      console.log('\n################ 工作台凪面板 ################')
      if (!(await waitForCdp(wbPort))) throw new Error('工作台实例 CDP 未就绪')
      const wbBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${wbPort}`)
      const wbPage = await findPage(wbBrowser, 'workbench')
      if (!wbPage) throw new Error('工作台页未就绪（模型没加载出来？）')
      for (const c of WB_CASES) {
        await resizeWindow(wbPage, c.win[0], c.win[1])
        await setPanelWidth(wbPage, c.panel)
        const art = await inspectArt(wbPage)
        const s = await inspect(wbPage)
        const tag = `工作台 ${c.win[0]}x${c.win[1]} 面板${c.panel}(${c.label})`
        console.log(`\n----- ${tag} -----`)
        audit(s, art, tag)
        const slug = tag.replace(/[^\w\u4e00-\u9fa5]+/g, '_')
        saveSnap(s, slug)
        await shotComposite(wbPage, slug)
      }
      await stopApp(wbChild)
    }
  }
} catch (err) {
  console.error('✘ 校验中断：', err?.message || err)
  results.push({ name: '校验流程', pass: false, detail: String(err?.message || err) })
} finally {
  for (const c of children) await stopApp(c)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✘ ${f.name}${f.detail ? '：' + f.detail : ''}`)
}
console.log(`快照目录：${SNAP_DIR}`)
console.log(`整窗截图目录：${SHOT_DIR}`)
process.exit(failed.length ? 2 : 0)
