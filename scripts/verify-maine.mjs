// scripts/verify-maine.mjs
// 「缅因妹妹」（models/Maine）的渲染接线验收（零依赖版）。
//
// 为什么不走 Electron：本机 Electron 的 GPU 进程会起来就崩（exit_code=-1073741819，
// 已在 softwareGl / SwiftShader 下亦然，换回旧的 Mao 也一样 → 是环境问题，不是模型问题），
// 桌宠页根本渲染不出来。所以改成：起 tools/live2d-viewer 的静态服务，
// 用**独立浏览器**加载——运行库（Cubism Core / pixi7 / pixi-live2d-display）
// 与加载语义（读 model3.json 的 Moc/Textures/Physics/Expressions/Motions）
// 跟桌宠是同一套，验的就是"这份模型 + 这份接线能不能被正常加载和驱动"。
//
// 验的项目：
//   A. 模型能加载（moc 画布 / 参数数 / 贴图数 / 物理）
//   B. 表情清单完整（原包 31 + 本项目 nagi_* 5）
//   C. 6 个情绪都能命中表情（nagi-emotion.json 的映射）
//   D. 5 个动作组都能播（Idle / TapBody / Greet / Happy / Scene）
//   E. 每张情绪表情存一张截图，供人眼复核
//   F. 画布真的画出了非透明像素（不是黑屏/空白）
//
// 用法：npm run verify:maine  （加 --no-shots 不存图）
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = 8791
const SHOT_DIR = mkdtempSync(join(tmpdir(), 'nagi-maine-verify-'))
const WANT_SHOTS = !process.argv.includes('--no-shots')
/** --model= 换一个模型做对照（比如 models-archive 里的旧模型） */
const MODEL = (process.argv.find((a) => a.startsWith('--model=')) || '--model=Maine/Maine.model3.json').split('=')[1]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

const server = spawn(process.execPath, ['tools/live2d-viewer/server.mjs', '--port', String(PORT), '--no-open'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
server.stdout.on('data', (b) => (serverLog += String(b)))
server.stderr.on('data', (b) => (serverLog += String(b)))

let browser
try {
  let list = null
  for (let i = 0; i < 50 && !list; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/models`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) list = await r.json()
    } catch {
      /* 还没起来 */
    }
    if (!list) await sleep(300)
  }
  if (!list) throw new Error('预览服务没起来：' + serverLog.slice(-600))
  console.log('· 模型目录扫描到：', list.models.join(' / '), '\n')

  const launchOpts = { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] }
  try {
    browser = await chromium.launch({ ...launchOpts, channel: 'msedge' })
  } catch {
    browser = await chromium.launch(launchOpts)
  }
  const page = await browser.newPage({ viewport: { width: 520, height: 720 } })
  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.PIXI?.live2d?.Live2DModel, null, { timeout: 20000 })

  // 加载模型 + 摆到画面里（按胸像取景，与 core/frame.js 的 Maine 预设同口径）
  const meta = await page.evaluate(async (rel) => {
    const PIXI = window.PIXI
    const app = new PIXI.Application({ width: 460, height: 640, backgroundAlpha: 0, antialias: true })
    document.body.appendChild(app.view)
    window.__app = app
    const m = await PIXI.live2d.Live2DModel.from('/models/' + rel, { autoInteract: false })
    window.__m = m
    app.stage.addChild(m)
    const p = { left: 0.255, right: 0.83, top: -0.01, bottom: 0.46 }
    const ci = m.internalModel.coreModel._model.canvasinfo
    const bw = ci.CanvasWidth, bh = ci.CanvasHeight
    const bandW = bw * (p.right - p.left)
    const bandH = bh * (p.bottom - p.top)
    const s = Math.min(app.screen.width / bandW, app.screen.height / bandH)
    m.anchor.set(0.5, p.bottom)
    m.x = app.screen.width / 2 - bw * ((p.left + p.right) / 2 - 0.5) * s
    m.y = app.screen.height
    m.scale.set(s)
    await new Promise((r) => setTimeout(r, 1200))
    const st = m.internalModel.settings
    const raw = await fetch('/models/' + rel).then((r) => r.json())
    const groups = raw.Groups || []
    const ids = Array.from(m.internalModel.coreModel._parameterIds || [])
    const lip = (groups.find((g) => g.Name === 'LipSync') || {}).Ids || []
    const blink = (groups.find((g) => g.Name === 'EyeBlink') || {}).Ids || []
    return {
      name: rel.split('/')[0],
      canvas: { w: bw, h: bh },
      // 注意：model3.json 里的 Name 是中文（给 UI 看的），文件名才是 ASCII
      expressions: (st.expressions || []).map((e) => e.Name || e.name),
      motions: Object.fromEntries(Object.entries(st.motions || {}).map(([g, a]) => [g, a.length])),
      physics: !!st.physics,
      textures: (st.textures || []).length,
      lipSync: lip.length > 0 && lip.every((id) => ids.includes(id)),
      lipIds: lip,
      blinkIds: blink,
      params: ids.length
    }
  }, MODEL)

  check('A. 模型加载', meta.canvas.w > 0 && meta.params > 0,
    `moc ${meta.canvas.w}×${meta.canvas.h}，参数 ${meta.params}，贴图 ${meta.textures}，物理 ${meta.physics}，口型 ${meta.lipSync}`)

  const nagiOnes = meta.expressions.filter((n) => String(n).startsWith('nagi_'))
  check('B. 表情清单', meta.expressions.length >= 34 && nagiOnes.length === 5,
    `共 ${meta.expressions.length} 个（nagi_* ${nagiOnes.length} 个）`)

  // 6 情绪 → 表情：**从 nagi-emotion.json 实读**，不硬编码期望表——2026-10-17 踩过：
  // D37 把 smile 从文件名改成 Name 后，这里的硬编码表没同步（还写着 smile→脸红），
  // 而检查只验"表情存在且可应用"、不对比配置，于是静默漂移，C 项失去意义。
  // 实读之后：配置指向不存在的表情 → 应用失败 → C 项挂；配置改了 → 期望跟着改。
  const EMOTION_KEYS = ['calm', 'smile', 'joy', 'puzzled', 'worry', 'pout']
  const FALLBACK_MAP = { calm: 'nagi_neutral', smile: 'nagi_smile', joy: 'nagi_joy', puzzled: 'nagi_puzzled', worry: '紧张汗', pout: 'nagi_pout' }
  let MAP = FALLBACK_MAP
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'models', 'Maine', 'nagi-emotion.json'), 'utf8'))
    const got = {}
    for (const k of EMOTION_KEYS) if (cfg[k]?.expr) got[k] = cfg[k].expr
    if (Object.keys(got).length === EMOTION_KEYS.length) MAP = got
    else console.log(`　· 情绪映射：配置缺 ${EMOTION_KEYS.filter((k) => !got[k]).join(',')}，用内置期望表`)
  } catch {
    console.log('　· 情绪映射：读 nagi-emotion.json 失败，用内置期望表')
  }
  const emoBad = []
  for (const [emo, name] of Object.entries(MAP)) {
    const ok = await page.evaluate((n) => {
      try {
        window.__m.expression(n)
        return true
      } catch {
        return false
      }
    }, name)
    if (!ok || !meta.expressions.includes(name)) emoBad.push(`${emo}→${name}`)
    await sleep(450)
    if (WANT_SHOTS) {
      const url = await page.evaluate(() => {
        window.__app.render()
        return window.__app.view.toDataURL('image/png')
      })
      if (url) writeFileSync(join(SHOT_DIR, `emo-${emo}.png`), Buffer.from(url.split(',')[1], 'base64'))
    }
  }
  check('C. 6 情绪 → 表情', emoBad.length === 0,
    emoBad.length ? '未命中：' + emoBad.join(',') : Object.entries(MAP).map(([e, n]) => `${e}→${n}`).join('  '))

  const groups = Object.keys(meta.motions)
  const wantGroups = ['Idle', 'TapBody', 'Greet', 'Happy', 'Scene']
  const missingGroups = wantGroups.filter((g) => !groups.includes(g))
  const motionBad = []
  for (const g of groups) {
    const ok = await page.evaluate((n) => {
      try {
        window.__m.motion(n)
        return true
      } catch {
        return false
      }
    }, g)
    if (!ok) motionBad.push(g)
    await sleep(350)
  }
  check('D. 动作组可播', motionBad.length === 0 && missingGroups.length === 0,
    (missingGroups.length ? '缺组：' + missingGroups.join(',') + '；' : '') +
    groups.map((g) => `${g}(${meta.motions[g]})`).join('  '))

  // 全部表情逐个应用（含开关类，确认资产都能读）
  await page.evaluate(() => window.__m.expression(null) || window.__m.internalModel?.motionManager?.expressionManager?.resetExpression?.())
  const exprBad = []
  for (const name of meta.expressions) {
    const ok = await page.evaluate((n) => {
      try {
        window.__m.expression(n)
        return true
      } catch {
        return false
      }
    }, name)
    if (!ok) exprBad.push(name)
    await sleep(60)
  }
  check('E. 全部表情可应用', exprBad.length === 0,
    exprBad.length ? '失败：' + exprBad.join(',') : `${meta.expressions.length}/${meta.expressions.length}`)

  // 画面非空
  const painted = await page.evaluate(() => {
    window.__app.render()
    const c = window.__app.view
    const g = document.createElement('canvas')
    g.width = c.width
    g.height = c.height
    const x = g.getContext('2d', { willReadFrequently: true })
    x.drawImage(c, 0, 0)
    const { data } = x.getImageData(0, 0, g.width, g.height)
    let n = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++
    return { n, total: data.length / 4 }
  })
  check('F. 画面非空', painted.n > 1000,
    `不透明像素 ${painted.n} / ${painted.total}（${((painted.n / painted.total) * 100).toFixed(1)}%）`)

  const noisy = errs.filter((t) => !/favicon|Failed to load resource/i.test(t))
  check('G. 无控制台报错', noisy.length === 0, noisy.length ? noisy.slice(0, 3).join(' | ') : '0 条')
  if (WANT_SHOTS) console.log('\n截图目录：', SHOT_DIR)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('\n验收中断：', e.message)
  if (serverLog) console.error(serverLog.slice(-1200))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill()
}

