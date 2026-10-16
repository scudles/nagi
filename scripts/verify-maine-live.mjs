// scripts/verify-maine-live.mjs
// 「缅因妹妹」的**真机**验收（真实 Electron + 桌宠页 + 生产渲染层 live2d.js）。
//
// 与 scripts/verify-maine.mjs 的分工：
//   · verify-maine      —— 独立浏览器 + 预览页，验「模型文件 + 接线」本身
//   · verify-maine-live —— 真起 Electron 桌宠，验「本项目渲染层跑起来后」是不是真的对：
//                          取景预设有没有命中缅因、6 个情绪切出来的面容是不是映射里那张、
//                          5 个动作组是不是真的在动、画面有没有画出来
//
// 判据说明（避免"调用没报错"就当通过）：
//   · 表情：读**表情专属参数**（剔除眨眼、呼吸、动作会写的）取值签名，
//     比对「走情绪链路」与「直接点该表情」两次签名是否一致；
//   · 动作：播放期间**密集采样该动作文件真正会写的那些参数**，看它们有没有真的在摆动
//     （只取一次前后快照会漏：动作有淡入、且可能被同优先级的动作挡掉）。
//
// 用法：npm run verify:maine-live
//
// 注意：**不要** browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MOTION_DIR = join(ROOT, 'models', 'Maine', 'Motions')
const PORT = process.env.CDP_PORT || '9337'
/** --shots=<dir> 指定截图落点（对比压缩前后画面时用） */
const SHOT_DIR =
  (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] ||
  mkdtempSync(join(tmpdir(), 'nagi-maine-live-'))

/**
 * 表情专属参数：所有 exp3.json 的参数并集，
 * 剔除两类会自己动的——① 动作会写的（wave/scene 里出现）② 眨眼接管的 ParamEyeLOpen/ROpen。
 * 剩下的就是"谁切的表情、切成什么样"的指纹。
 */
const FACE_IDS = [
  'ParamBrowLY', 'ParamBrowRY', 'ParamCheek',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthOpenY',
  'Param2', 'Param3', 'Param4', 'Param5', 'Param6',
  'Param11', 'Param13', 'Param14', 'Param15', 'Param16', 'Param17', 'Param18', 'Param19', 'Param20',
  'Param93', 'Param116', 'Param139', 'Param321', 'Param322',
  'Param466', 'Param467', 'Param468', 'Param469'
]
/** 6 情绪 → 期望落到的表情（与 models/Maine/nagi-emotion.json 一致，Name 是中文显示名） */
const EMOTION_MAP = {
  calm: 'nagi_neutral',
  smile: '脸红',
  joy: 'nagi_joy',
  puzzled: 'nagi_puzzled',
  worry: '紧张汗',
  pout: 'nagi_pout'
}
const WANT_GROUPS = ['Idle', 'TapBody', 'Greet', 'Happy', 'Scene']
const SAMPLE_MS = 3600
const SAMPLE_STEP = 120

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读 PNG 头拿宽高（不解码，避免为了量尺寸把 8192 大图读进内存） */
function pngSize(path) {
  try {
    const b = readFileSync(path)
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: statSync(path).size }
  } catch {
    return null
  }
}

/** 当前生效贴图清单 + 解码后显存估算（RGBA 4 字节/像素） */
function textureReport(model = 'Maine') {
  try {
    const dir = join(ROOT, 'models', model)
    const cfg = JSON.parse(readFileSync(join(dir, `${model}.model3.json`), 'utf8'))
    const refs = (cfg.FileReferences || {}).Textures || []
    let vram = 0
    const lines = []
    for (const rel of refs) {
      const s = pngSize(join(dir, rel))
      if (!s) continue
      vram += s.w * s.h * 4
      lines.push(`${rel.split('/').pop()} ${s.w}×${s.h} ${(s.bytes / 1048576).toFixed(1)}MB`)
    }
    return { lines, vramMB: vram / 1048576 }
  } catch {
    return null
  }
}

/** 从磁盘读出每个动作文件真正会写的参数 id */
function motionParamIds(file) {
  try {
    const d = JSON.parse(readFileSync(join(MOTION_DIR, `${file}.motion3.json`), 'utf8'))
    return [...new Set((d.Curves || []).map((c) => c.Id))]
  } catch {
    return []
  }
}

/* ---------------- 起实例 / 收实例 ---------------- */

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则 electron 会当 node 跑
  // 本机 GPU 进程在沙箱内会 0xC0000005 崩 → 必须关渲染沙箱，否则桌宠页根本起不来
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-maine-live-'))
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

function startApp() {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${newUserData()}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: baseEnv(),
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

async function waitForCdp(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return false
}

/** 找到桌宠那个页面（body[data-mode=pet] 且模型已就绪） */
async function findPetPage(browser, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const ok = await page.evaluate(
            () =>
              document.body?.dataset?.mode === 'pet' &&
              typeof window.__nagiFrame === 'function' &&
              !!window.__nagiFrame() &&
              (window.__nagiExpressionList?.() || []).length > 0
          )
          if (ok) return page
        } catch {
          /* 页面还在导航 */
        }
      }
    }
    await sleep(500)
  }
  return null
}

/** 密集采样一组参数，返回每个参数的波动幅度（max-min）里的最大值 */
async function sampleAmplitude(page, ids, ms = SAMPLE_MS) {
  const lo = {}
  const hi = {}
  for (const id of ids) {
    lo[id] = Infinity
    hi[id] = -Infinity
  }
  for (let t = 0; t < ms; t += SAMPLE_STEP) {
    const v = await page.evaluate((list) => window.__nagiReadParams(list), ids)
    for (const id of ids) {
      if (typeof v?.[id] !== 'number') continue
      lo[id] = Math.min(lo[id], v[id])
      hi[id] = Math.max(hi[id], v[id])
    }
    await sleep(SAMPLE_STEP)
  }
  let worst = 0
  let who = ''
  for (const id of ids) {
    if (lo[id] === Infinity) continue
    const amp = hi[id] - lo[id]
    if (amp > worst) {
      worst = amp
      who = id
    }
  }
  return { amp: worst, who }
}

const t0 = Date.now()
const child = startApp()
let browser
try {
  if (!(await waitForCdp())) throw new Error('Electron 的 CDP 没起来（GPU 进程崩了？试 NAGI_RENDERER_SANDBOX=0）')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const page = await findPetPage(browser)
  if (!page) throw new Error('没找到就绪的桌宠页')
  // 含 Electron 冷启动 + 模型加载 + 贴图解码，是"贴图多大"最直观的体感指标
  info('冷启动到桌宠就绪', `${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  /* --- A. 桌面宠物跑的是缅因，且取景预设命中缅因 --- */
  const frame = await page.evaluate(() => window.__nagiFrame())
  const preset = frame?.preset || {}
  const isMainePreset =
    Math.abs((preset.left ?? 0) - 0.255) < 1e-6 && Math.abs((preset.right ?? 0) - 0.83) < 1e-6
  check(
    'A. 桌宠加载的是缅因妹妹',
    isMainePreset && frame?.mocCanvas?.w === 5000,
    `取景预设 ${JSON.stringify(preset)}；moc 画布 ${frame?.mocCanvas?.w}×${frame?.mocCanvas?.h}；画布 ${frame?.canvas?.w}×${frame?.canvas?.h}`
  )

  const tex = textureReport()
  if (tex) info('生效贴图', `${tex.lines.join('｜')} → 解码后显存约 ${tex.vramMB.toFixed(0)}MB`)

  /* --- B. 表情清单 --- */
  const exprs = await page.evaluate(() => window.__nagiExpressionList())
  const nagiOnes = exprs.filter((n) => String(n).startsWith('nagi_'))
  const hasDark = exprs.some((n) => /黑脸|dark_mask/i.test(String(n)))
  check(
    'B. 表情清单（黑脸已挡在外面）',
    exprs.length === 36 && nagiOnes.length === 5 && !hasDark,
    `共 ${exprs.length} 个（nagi_* ${nagiOnes.length} 个：${nagiOnes.join('/')}）；黑脸 ${hasDark ? '仍在' : '不在'}清单`
  )

  // 指纹工具：只在真实存在的参数上取值
  await page.evaluate((ids) => {
    window.__faceIds = (window.__nagiParamIds() || []).filter((id) => ids.includes(id))
    window.__sig = () => {
      const v = window.__nagiReadParams(window.__faceIds) || {}
      return window.__faceIds.map((id) => (typeof v[id] === 'number' ? v[id].toFixed(3) : 'x')).join('|')
    }
    window.__diff = (a, b) => {
      const x = a.split('|')
      const y = b.split('|')
      let worst = 0
      for (let i = 0; i < x.length; i++) {
        if (x[i] === 'x' || y[i] === 'x') continue
        worst = Math.max(worst, Math.abs(Number(x[i]) - Number(y[i])))
      }
      return worst
    }
  }, FACE_IDS)
  info('指纹参数', `表情专属 ${await page.evaluate(() => window.__faceIds.length)} 个 / 全模型 ${await page.evaluate(() => window.__nagiParamIds().length)} 个`)

  /* --- 0. 先确认模型本身在动（否则后面全都是"静止"的假象） --- */
  const alive = await sampleAmplitude(page, ['ParamBodyAngleY', 'ParamAngleZ', 'ParamAngleX'], 1600)
  info('模型活跃度', `待机期间最大波动 ${alive.amp.toFixed(3)}（${alive.who || '—'}）`)

  /* --- C. 6 情绪切出来的面容 == 映射里那张表情 --- */
  const emoBad = []
  for (const [emo, want] of Object.entries(EMOTION_MAP)) {
    // 先走情绪链路（会顺带 force 一个动作）
    await page.evaluate((e) => window.__nagiTestEmotion(e), emo)
    await sleep(900)
    const sigByEmotion = await page.evaluate(() => window.__sig())
    // 再直接点目标表情，两张脸应当一致
    await page.evaluate((n) => window.__nagiTestExpression(n), want)
    await sleep(500)
    const sigByExpr = await page.evaluate(() => window.__sig())
    const gap = await page.evaluate(([a, b]) => window.__diff(a, b), [sigByEmotion, sigByExpr])
    if (gap > 0.05) emoBad.push(`${emo}→${want}(差${gap.toFixed(3)})`)
    await sleep(150)
  }
  check(
    'C. 6 情绪 → 表情（面容指纹比对）',
    emoBad.length === 0,
    emoBad.length ? '不一致：' + emoBad.join('，') : Object.entries(EMOTION_MAP).map(([e, n]) => `${e}→${n}`).join('  ')
  )

  /* --- D. 5 个动作组真的在动（密集采样该动作会写的参数） --- */
  const catalog = await page.evaluate(() => window.__nagiMotionCatalog())
  const allIds = await page.evaluate(() => window.__nagiParamIds())
  const missing = WANT_GROUPS.filter((g) => !(g in catalog))
  const stillBad = []
  const detail = []
  for (const g of WANT_GROUPS) {
    if (missing.includes(g)) continue
    const files = catalog[g] || []
    const ids = [...new Set(files.flatMap(motionParamIds))].filter((id) => allIds.includes(id))
    if (!ids.length) {
      stillBad.push(`${g}(读不到参数)`)
      continue
    }
    const ok = await page.evaluate((n) => {
      try {
        return !!window.__nagiTestMotion(n)
      } catch {
        return false
      }
    }, g)
    const { amp, who } = await sampleAmplitude(page, ids)
    detail.push(`${g}(${files.length}个/幅度${amp.toFixed(2)})`)
    info(`　${g}`, `参数 ${ids.length} 个，播放期间最大波动 ${amp.toFixed(3)}（${who || '—'}），playMotion=${ok}`)
    if (!ok || amp < 0.05) stillBad.push(`${g}(${ok ? '静' : '调不动'})`)
  }
  check(
    'D. 5 动作组播放且参数真的在摆',
    missing.length === 0 && stillBad.length === 0,
    (missing.length ? '缺组：' + missing.join(',') + '；' : '') +
      (stillBad.length ? '没动：' + stillBad.join(',') : detail.join('  '))
  )

  /* --- E. 画面真的画出来了 --- */
  const painted = await page.evaluate(async () => {
    const url = window.__nagiSnapshot()
    if (!url) return null
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const x = c.getContext('2d', { willReadFrequently: true })
    x.drawImage(img, 0, 0)
    const d = x.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
    return { n, total: d.length / 4, w: c.width, h: c.height }
  })
  check(
    'E. 画面非空',
    !!painted && painted.n > 1000,
    painted ? `不透明像素 ${painted.n} / ${painted.total}（${((painted.n / painted.total) * 100).toFixed(1)}%），画面 ${painted.w}×${painted.h}` : '抓帧失败'
  )

  // 顺手存一张当前帧，供人眼复核（--shots=<dir> 可指定落点，用来对比压缩前后）
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const url = await page.evaluate(() => window.__nagiSnapshot())
    if (url) writeFileSync(join(SHOT_DIR, 'pet-frame.png'), Buffer.from(url.split(',')[1], 'base64'))
  } catch {
    /* 存图失败无所谓 */
  }

  /* --- G. 帧率（只作参考：验证环境不代表真机，主要用来比压缩前后） --- */
  const fps = await page.evaluate(async () => {
    const t = window.PIXI?.Ticker?.shared
    if (!t) return null
    const s = []
    for (let i = 0; i < 30; i++) {
      s.push(t.FPS)
      await new Promise((r) => setTimeout(r, 100))
    }
    s.sort((a, b) => a - b)
    return { avg: s.reduce((a, b) => a + b, 0) / s.length, p10: s[Math.floor(s.length * 0.1)], min: s[0] }
  })
  info('帧率采样（3 秒）', fps ? `平均 ${fps.avg.toFixed(1)} / 低十分位 ${fps.p10.toFixed(1)} / 最低 ${fps.min.toFixed(1)} fps` : '读不到 PIXI Ticker')

  /* --- F. 控制台干净 --- */
  const noisy = errs.filter((t) => !/favicon|Failed to load resource/i.test(t))
  check('F. 无控制台报错', noisy.length === 0, noisy.length ? noisy.slice(0, 3).join(' | ') : '0 条')
  console.log('\n截图目录：', SHOT_DIR)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('\n验收中断：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopApp(child)
}
