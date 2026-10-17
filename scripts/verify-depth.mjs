// scripts/verify-depth.mjs
// 前后（Z 轴）动作的真机验收（B 组，2026-10-17 用户拍板"补纵深方向"）。
//
// 验的不是"状态机里算对了"（那是 test/depth-motion.test.js 的职责），而是**渲染层
// 真的把它落到了模型上**：
//   ① 三段轨迹（淡入/保持/淡出）时长与包络，峰值位移/缩放命中设计值；
//   ② 容器层 scaleX === scaleY（等比，不拉伸变形），且位移/缩放绕模型锚点
//      （取景带底边 = 肚脐线）——像素包围盒增高 ≥5%、底边基本不动；
//   ③ 角度增量真的写进了模型参数：读**帧末最终值**（probePoseOnce 式注册在最后的
//      探针），不是读 __depthLast 的意图值——2026-10-17 实测教训：beforeModelUpdate
//      的监听器按**注册顺序**执行（eventemitter3 FIFO），转向层 turnHook 对
//      ParamAngle*/ParamBodyAngle* 是 set 绝对值，depth 注册在它前面会被整个盖掉
//      （归来时 playTurn('return') 与 peek 叠加，探头的抬头就丢了）。本条即回归；
//   ④ 常态复合摆动：左右转身（yaw）与前后（scale/dy）同时在场且相位差 1/4 周期；
//   ⑤ 幅度滑杆线性（0.5 → 峰值 1.03；2 → 1.12）；关开关平滑归零；
//   ⑥ 对话事件接线：thinking → 前倾、done → 后仰（mock 大脑真实链路）；
//   ⑦ 设置页 round-trip：滑杆即时生效、保存落盘、configureDepth 收到。
//
// 采样口径：__depthLast 是 depth 钩子每帧真正写出去的值（含容器层），
// 判"生没生效"读它 + 帧末参数探针，不拿画面差分（头发物理余震会把"已收回"
// 算成"还在动"，verify:turns 踩过）。
//
// 用法：npm run verify:depth
// 注意：**不要**调用 browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SNAP_DIR = join(tmpdir(), `nagi-depth-${Date.now()}`)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 起实例 / 收实例 ---------------- */

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则 electron 会当 node 跑
  // 本机 GPU 进程会崩，渲染器沙箱必须关，否则桌宠页永远 ready 不了
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-depth-'))
  // 无 key → 走本地占位大脑（mockRun）：事件序列确定、不依赖网络
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        llm: { provider: 'custom', model: 'x' },
        privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
        live2d: { frame: 'bust', petWidth: 400, petHeight: 600, depthMotion: { enabled: true, amount: 1 } }
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

function startApp(port, userData) {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
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

async function saveSnap(page, name) {
  const url = await page.evaluate(() => (typeof window.__nagiSnapshot === 'function' ? window.__nagiSnapshot() : null))
  if (!url) return null
  mkdirSync(SNAP_DIR, { recursive: true })
  const f = join(SNAP_DIR, `depth-${name}.png`)
  writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'))
  info('快照', f)
  return f
}

/* ---------------- 页内采样 helpers（全部走 rAF，和渲染同频） ---------------- */

/** 开一段轨迹：可选先触发一个动作；按帧记录 __depthLast（按 seq 去重） */
function traceDepth(page, ms, trigger) {
  return page.evaluate(
    ({ ms, trigger }) =>
      new Promise((resolve) => {
        const out = []
        let lastSeq = -1
        const t0 = performance.now()
        if (trigger) window.__nagiDepth(trigger)
        const tick = () => {
          const d = window.__depthLast
          if (d && d.seq !== lastSeq) {
            lastSeq = d.seq
            out.push({
              t: performance.now() - t0,
              seq: d.seq,
              mode: d.mode,
              phase: d.phase,
              env: d.env,
              scale: d.transform.scale,
              dx: d.transform.dx,
              dy: d.transform.dy,
              sx: d.container.scaleX,
              sy: d.container.scaleY,
              params: d.params
            })
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
    { ms, trigger }
  )
}

/** 等到触发动作到峰值（env ≥ minEnv），同帧读回深度状态 + 像素包围盒 */
function peakWithArtBox(page, minEnv = 0.98, timeoutMs = 4500) {
  return page.evaluate(
    ({ minEnv, timeoutMs }) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const tick = async () => {
          const d = window.__depthLast
          if (d && d.env >= minEnv) {
            const box = await window.__nagiArtBox()
            resolve({
              mode: d.mode,
              env: d.env,
              scale: d.transform.scale,
              dy: d.transform.dy,
              params: d.params,
              sx: d.container.scaleX,
              sy: d.container.scaleY,
              box
            })
            return
          }
          if (performance.now() - t0 > timeoutMs) {
            resolve(null)
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { minEnv, timeoutMs }
  )
}

/** 只等峰值（不量包围盒） */
function peakOnly(page, minEnv = 0.98, timeoutMs = 4500) {
  return page.evaluate(
    ({ minEnv, timeoutMs }) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const tick = () => {
          const d = window.__depthLast
          if (d && d.env >= minEnv) {
            resolve({ mode: d.mode, env: d.env, scale: d.transform.scale, dy: d.transform.dy, params: d.params })
            return
          }
          if (performance.now() - t0 > timeoutMs) {
            resolve(null)
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { minEnv, timeoutMs }
  )
}

/** 等动作收干净（mode 回 idle） */
function waitIdle(page, timeoutMs = 6000) {
  return page.evaluate(
    (timeoutMs) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const tick = () => {
          const s = window.__nagiDepthState()
          if (s.mode === 'idle' || performance.now() - t0 > timeoutMs) resolve(s)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    timeoutMs
  )
}

/** 轨迹里某个时刻的 env（取 ≤ t 的最后一帧） */
const envAt = (trace, t) => {
  let v = 0
  for (const s of trace) if (s.t <= t) v = s.env
  return v
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const port = 9412
  const userData = newUserData()
  console.log('起隔离实例（本地占位大脑）…')
  const child = startApp(port, userData)
  try {
    if (!(await waitForCdp(port))) throw new Error('CDP 未就绪')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = await findPage(browser)
    if (!page) throw new Error('桌宠页未就绪（模型没加载出来？GPU 进程崩了？试 NAGI_RENDERER_SANDBOX=0）')
    await sleep(1200) // 等模型把首批帧跑完

    /* ① 配置成确定性：关自动触发与常态摆动，只留我触发的 */
    const cfg0 = await page.evaluate(() => {
      const before = window.__nagiDepthState()
      window.__nagiDepthConfig({ enabled: true, amount: 1, ambient: false, auto: false })
      return { before, after: window.__nagiDepthState() }
    })
    check(
      '纵感触达且配置生效（enabled/amount=1，ambient/auto 关闭）',
      cfg0.after.enabled === true && cfg0.after.amount === 1 && cfg0.after.ambient === false && cfg0.after.auto === false,
      JSON.stringify(cfg0.after)
    )
    // 冻结待机（呼吸/眨眼/摆头）：量像素包围盒时排除这些噪声，容器层不受影响
    const froze = await page.evaluate(() => window.__nagiFreezeIdle(true))
    check('冻结待机动作成功（包围盒测量专用）', froze === true, String(froze))

    /* ② 静止恒等：常态与触发都没有时，容器层必须精确不动 */
    const idle0 = await page.evaluate(() => window.__depthLast)
    const idle1 = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 250))
      return window.__depthLast
    })
    const ident = (d) => d && Math.abs(d.transform.scale - 1) < 1e-9 && d.transform.dx === 0 && d.transform.dy === 0
    check('静止时容器层恒等（scale=1, dx=dy=0，两次采样）', ident(idle0) && ident(idle1), JSON.stringify(idle1?.transform))

    /* ③ 基线包围盒（冻结态），测两遍求稳定 */
    const base = await page.evaluate(() => window.__nagiArtBox())
    const base2 = await page.evaluate(() => window.__nagiArtBox())
    const baseStable =
      base && base2 && !base.empty && Math.abs(base.y1 - base2.y1) <= 2 && Math.abs(base.x0 - base2.x0) <= 2 && Math.abs(base.h - base2.h) <= 2
    check(
      '基线包围盒可测且稳定（两次差 ≤2px）',
      !!baseStable,
      base ? `${base.w}×${base.h} 画布，art [${base.x0},${base.y0}]~[${base.x1},${base.y1}]` : 'null'
    )
    await saveSnap(page, 'baseline')

    /* ④ leanIn 三段轨迹 */
    const trace = await traceDepth(page, 2200, 'leanIn')
    const okTrace = Array.isArray(trace) && trace.length >= 30
    check('leanIn 轨迹采到 ≥30 帧（渲染在跑）', okTrace, `${trace?.length} 帧`)
    if (okTrace) {
      const peakEnv = Math.max(...trace.map((s) => s.env))
      const peakScale = Math.max(...trace.map((s) => s.scale))
      const minDy = Math.min(...trace.map((s) => s.dy))
      const t95 = trace.find((s) => s.env >= 0.95)?.t ?? null
      const last = trace[trace.length - 1]
      const seqMono = trace.every((s, i) => i === 0 || s.seq > trace[i - 1].seq)
      const equalRatio = trace.every((s) => s.sx === s.sy)
      const noNaN = trace.every((s) => Number.isFinite(s.scale) && Number.isFinite(s.dy) && Number.isFinite(s.env))
      // 无跳帧：按**每毫秒**算 Lipschitz（掉帧只会让 Δt 变大，不会误判；
      // 帧内瞬移才会超）——leanIn 最陡段 outCubic 峰值斜率 ≈4.3e-4/ms，阈值留 2 倍
      let maxScaleRate = 0
      let maxDyRate = 0
      for (let i = 1; i < trace.length; i++) {
        const dt = trace[i].t - trace[i - 1].t
        if (dt <= 0) continue
        maxScaleRate = Math.max(maxScaleRate, Math.abs(trace[i].scale - trace[i - 1].scale) / dt)
        maxDyRate = Math.max(maxDyRate, Math.abs(trace[i].dy - trace[i - 1].dy) / dt)
      }
      check('leanIn 峰值包络到 1 且无过冲', peakEnv <= 1 + 1e-9 && peakEnv >= 0.999, `envPeak=${peakEnv.toFixed(4)}`)
      check('leanIn 淡入约 420ms 到 95%', t95 !== null && t95 >= 200 && t95 <= 620, `t(env≥0.95)=${t95?.toFixed(0)}ms`)
      check('leanIn 保持段env≈1（420ms 与 1000ms 都在高位）', envAt(trace, 400) >= 0.99 && envAt(trace, 1000) >= 0.95, `env@400=${envAt(trace, 400).toFixed(3)} env@1000=${envAt(trace, 1000).toFixed(3)}`)
      check('leanIn 淡出在约 1440ms 内收干净并回到恒等', envAt(trace, 1550) <= 0.1 && last.mode === 'idle' && Math.abs(last.scale - 1) < 1e-9 && last.dy === 0, `env@1550=${envAt(trace, 1550).toFixed(4)} mode=${last.mode} scale=${last.scale}`)
      check('leanIn 峰值缩放 ≥1.055（设计 1.06，明显可感知）', peakScale >= 1.055 && peakScale <= 1.062, `scalePeak=${peakScale.toFixed(4)}`)
      check('leanIn 峰值上移 ≤−5.5px（设计 −6）', minDy <= -5.5 && minDy >= -6.5, `dyMin=${minDy.toFixed(2)}`)
      check('容器层全程 scaleX === scaleY（等比，不拉伸变形）', equalRatio)
      check('无跳帧：位移/缩放每毫秒变化率有界（无瞬移）', maxScaleRate <= 1e-3 && maxDyRate <= 0.2, `scaleRate≤${maxScaleRate.toExponential(2)}/ms dyRate≤${maxDyRate.toExponential(2)}/ms`)
      check('seq 单调递增且无数值异常', seqMono && noNaN)
    }

    /* ⑤ peek 峰值 + 像素包围盒：绕锚点（肚脐线）放大 → 增高、底边基本不动、比例不变
     * ⚠ measureArtBox 的 w/h 是**画布**尺寸；盒子尺寸要自己用 (x1-x0)/(y1-y0) 算。 */
    await page.evaluate(() => window.__nagiDepth('peek'))
    const pk = await peakWithArtBox(page, 0.98)
    check('peek 到达峰值且同帧取到包围盒', !!pk && !!pk.box && !pk.box.empty, pk ? `env=${pk.env.toFixed(3)} scale=${pk.scale.toFixed(4)}` : 'null')
    if (pk && pk.box && base && !base.empty) {
      // 峰值采样可能落在 env=0.98 的上升沿（不是满幅 1）：设计值按采样时的 env 折算
      const pkEnv = pk.env
      const boxOf = (b) => ({ w: b.x1 - b.x0, h: b.y1 - b.y0 })
      const b0 = boxOf(base)
      const b1 = boxOf(pk.box)
      const hRatio = b1.h / b0.h
      const wRatio = b1.w / b0.w
      const aspectBase = b0.w / b0.h
      const aspectPeak = b1.w / b1.h
      const dBottom = pk.box.y1 - base.y1
      const inside = pk.box.x0 >= -1 && pk.box.y0 >= -1 && pk.box.x1 <= pk.box.w + 1 && pk.box.y1 <= pk.box.h + 1
      const scaleOk = Math.abs(pk.scale - (1 + 0.1 * pkEnv)) <= 0.002 && 1 + 0.1 * pkEnv >= 1.098
      const dyOk = Math.abs(pk.dy + 10 * pkEnv) <= 0.2
      check('peek 峰值包围盒增高 ≥5%（设计放大 10%）', hRatio >= 1.05, `${(hRatio * 100 - 100).toFixed(1)}%（${b0.h}→${b1.h}px）`)
      check('peek 峰值包围盒等比例增宽（同倍率，不只有纵向）', wRatio >= 1.05, `${(wRatio * 100 - 100).toFixed(1)}%`)
      // 次要证据：容器层 scaleX===scaleY 已精确证明不拉伸；像素长宽比允许 silhouette
      // 绕锚点不对称 + dy 位移带来的少量变化（实测约 1.7%）
      check('peek 峰值长宽比基本不变（不拉伸变形）', Math.abs(aspectPeak / aspectBase - 1) <= 0.03, `${aspectBase.toFixed(4)} → ${aspectPeak.toFixed(4)}`)
      check('peek 峰值底边（肚脐线）基本不动（|Δ|≤14px，位移只来自 dy）', Math.abs(dBottom) <= 14, `Δbottom=${dBottom.toFixed(1)}px（dy=${pk.dy.toFixed(1)}）`)
      check('peek 峰值整体仍在画布内（不越界盖 UI）', inside, `art [${pk.box.x0},${pk.box.y0}]~[${pk.box.x1},${pk.box.y1}] / ${pk.box.w}×${pk.box.h}`)
      check('peek 参数：抬头凑近（ParamAngleX ≤−5.5，负=靠近，实测约定）', (pk.params.ParamAngleX ?? 0) <= -5.5, `ParamAngleX=${pk.params.ParamAngleX}`)
      check('peek 参数：侧头幅度 |ParamAngleY| ≥3.5（左右复合）', Math.abs(pk.params.ParamAngleY ?? 0) >= 3.5, `ParamAngleY=${pk.params.ParamAngleY}`)
      check('peek 峰值缩放/上移命中设计公式（1+0.10·env / −10·env）', scaleOk && dyOk, `scale=${pk.scale.toFixed(4)}（期望 ${(1 + 0.1 * pkEnv).toFixed(4)}）dy=${pk.dy.toFixed(2)}（期望 ${(-10 * pkEnv).toFixed(2)}）`)
      await saveSnap(page, 'peek-peak')
    }
    await waitIdle(page)

    /* ⑥ leanBack 反向：缩小 + 下沉 + 角度为正（远离屏幕）
     * 同样按采样时的 env 折算设计值（峰值采样常落在 env≈0.98 的上升沿）。 */
    await page.evaluate(() => window.__nagiDepth('leanBack'))
    const lbPeak = await peakOnly(page, 0.98)
    const lbEnv = lbPeak?.env ?? 0
    check(
      'leanBack 反向：缩小/下沉命中设计公式（1−0.05·env / +10·env），角度为正（远离）',
      !!lbPeak &&
        lbEnv >= 0.98 &&
        Math.abs(lbPeak.scale - (1 - 0.05 * lbEnv)) <= 0.002 &&
        1 - 0.05 * lbEnv <= 0.951 &&
        Math.abs(lbPeak.dy - 10 * lbEnv) <= 0.2 &&
        (lbPeak.params.ParamBodyAngleX ?? 0) > 0 &&
        (lbPeak.params.ParamAngleX ?? 0) > 0,
      lbPeak
        ? `env=${lbEnv.toFixed(3)} scale=${lbPeak.scale.toFixed(4)}（期望 ${(1 - 0.05 * lbEnv).toFixed(4)}）dy=${lbPeak.dy.toFixed(2)}（期望 ${(10 * lbEnv).toFixed(2)}）BodyAngleX=${lbPeak.params.ParamBodyAngleX?.toFixed(2)} AngleX=${lbPeak.params.ParamAngleX?.toFixed(2)}`
        : 'null'
    )
    const lbIdle = await waitIdle(page)
    const lbLast = await page.evaluate(() => window.__depthLast)
    check('leanBack 收干净后回到恒等', lbIdle.mode === 'idle' && Math.abs(lbLast.transform.scale - 1) < 1e-9 && lbLast.transform.dy === 0, `mode=${lbIdle.mode}`)

    /* ⑦ 幅度滑杆线性：0.5 → 1.03；2 → 1.12（各触发一次取峰值）
     * 注意 configureDepth 是「缺省项回默认」的合并——只传 amount 会把 ambient/auto
     * 弹回开启，峰值里就混进常态摆动，所以每一条都显式关回去。 */
    const half = await page.evaluate(async () => {
      window.__nagiDepthConfig({ amount: 0.5, ambient: false, auto: false })
      window.__nagiDepth('leanIn')
      const t0 = performance.now()
      while (performance.now() - t0 < 4500) {
        const d = window.__depthLast
        if (d && d.env >= 0.98) return { scale: d.transform.scale, env: d.env, amount: window.__nagiDepthState().amount }
        await new Promise((r) => requestAnimationFrame(r))
      }
      return null
    })
    check(
      'amount=0.5 峰值缩放 ≈1.03（线性减半，按采样 env 折算）',
      !!half && half.amount === 0.5 && Math.abs(half.scale - (1 + 0.06 * 0.5 * half.env)) <= 0.002 && 1 + 0.06 * 0.5 * half.env >= 1.029,
      half ? `env=${half.env.toFixed(3)} scale=${half.scale.toFixed(4)}（期望 ${(1 + 0.03 * half.env).toFixed(4)}）amount=${half.amount}` : 'null'
    )
    await waitIdle(page)
    const dbl = await page.evaluate(async () => {
      window.__nagiDepthConfig({ amount: 2, ambient: false, auto: false })
      window.__nagiDepth('leanIn')
      const t0 = performance.now()
      while (performance.now() - t0 < 4500) {
        const d = window.__depthLast
        if (d && d.env >= 0.98) return { scale: d.transform.scale, env: d.env, amount: window.__nagiDepthState().amount }
        await new Promise((r) => requestAnimationFrame(r))
      }
      return null
    })
    check(
      'amount=2 峰值缩放 ≈1.12（线性翻倍，仍 ≤10% 动作 + 上限内）',
      !!dbl && dbl.amount === 2 && Math.abs(dbl.scale - (1 + 0.06 * 2 * dbl.env)) <= 0.002 && 1 + 0.06 * 2 * dbl.env >= 1.117,
      dbl ? `env=${dbl.env.toFixed(3)} scale=${dbl.scale.toFixed(4)}（期望 ${(1 + 0.12 * dbl.env).toFixed(4)}）amount=${dbl.amount}` : 'null'
    )
    await page.evaluate(() => window.__nagiDepthConfig({ amount: 1, ambient: false, auto: false }))
    await waitIdle(page)

    /* ⑧ 关开关：峰值上关掉 → 平滑收回（不跳变），最终恒等 */
    const off = await page.evaluate(async () => {
      window.__nagiDepth('leanIn')
      const t0 = performance.now()
      while (performance.now() - t0 < 4500) {
        const d = window.__depthLast
        if (d && d.env >= 0.98) break
        await new Promise((r) => requestAnimationFrame(r))
      }
      const atPeak = window.__depthLast.transform.scale
      const offAt = performance.now()
      window.__nagiDepthConfig({ enabled: false, ambient: false, auto: false })
      const samples = []
      const tick = () => {
        const d = window.__depthLast
        if (d) samples.push({ t: performance.now() - offAt, scale: d.transform.scale, dy: d.transform.dy, env: d.env })
        if (performance.now() - offAt < 1400) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      await new Promise((r) => setTimeout(r, 1500))
      return { atPeak, samples, state: window.__nagiDepthState(), last: window.__depthLast }
    })
    let maxRateOff = 0
    for (let i = 1; i < off.samples.length; i++) {
      const dt = off.samples[i].t - off.samples[i - 1].t
      if (dt > 0) maxRateOff = Math.max(maxRateOff, Math.abs(off.samples[i].scale - off.samples[i - 1].scale) / dt)
    }
    const offLast = off.samples[off.samples.length - 1]
    check(
      '关开关后平滑收回：确实从峰值下手、约 420ms 内归零、最终恒等、无跳变',
      off.atPeak >= 1.05 && off.state.enabled === false && offLast.env <= 0.05 && Math.abs(offLast.scale - 1) < 1e-9 && offLast.dy === 0 && maxRateOff <= 1e-3,
      `atPeak=${off.atPeak?.toFixed(4)} endScale=${offLast.scale.toFixed(6)} endEnv=${offLast.env.toFixed(4)} rate≤${maxRateOff.toExponential(2)}/ms`
    )
    await page.evaluate(() => window.__nagiDepthConfig({ enabled: true, ambient: false, auto: false }))

    /* ⑨ 常态复合摆动：左右转身（yaw）与前后（scale/dy）同场，相位差 1/4 周期 */
    const amb = await page.evaluate(async () => {
      window.__nagiDepthConfig({ ambient: true, auto: false })
      await new Promise((r) => setTimeout(r, 300))
      const out = []
      let lastSeq = -1
      const t0 = performance.now()
      await new Promise((resolve) => {
        const tick = () => {
          const d = window.__depthLast
          if (d && d.seq !== lastSeq) {
            lastSeq = d.seq
            out.push({ t: performance.now() - t0, yaw: d.params.ParamBodyAngleY ?? 0, roll: d.params.ParamAngleZ ?? 0, scale: d.transform.scale, dy: d.transform.dy })
          }
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      return out
    })
    const yawPeak = Math.max(...amb.map((s) => Math.abs(s.yaw)))
    const rollPeak = Math.max(...amb.map((s) => Math.abs(s.roll)))
    const depthPeak = Math.max(...amb.map((s) => Math.abs(s.scale - 1)))
    const tYaw = amb.reduce((a, b) => (Math.abs(b.yaw) > Math.abs(a.yaw) ? b : a)).t
    const tDepth = amb.reduce((a, b) => (Math.abs(b.scale - 1) > Math.abs(a.scale - 1) ? b : a)).t
    const phaseGap = Math.abs(tYaw - tDepth)
    check('常态摆动：身体左右转幅度到位（|ParamBodyAngleY| ≥6，设计 7）', yawPeak >= 6, `yawPeak=${yawPeak.toFixed(2)}°`)
    check('常态摆动：歪头幅度到位（|ParamAngleZ| ≥2.5，设计 3）', rollPeak >= 2.5, `rollPeak=${rollPeak.toFixed(2)}°`)
    check('常态摆动：前后分量到位（|scale−1| ≥0.025，设计 0.03）', depthPeak >= 0.025, `depthPeak=${(depthPeak * 100).toFixed(2)}%`)
    check('常态摆动是**复合**的：yaw 极值与前后极值相位差 ≈1/4 周期（600ms）', phaseGap >= 350 && phaseGap <= 850, `Δt=${phaseGap.toFixed(0)}ms（周期 2400ms）`)
    await page.evaluate(() => window.__nagiDepthConfig({ ambient: false, auto: false }))

    /* ⑩ 回归：转向层 set 绝对值不许盖掉 depth 的角度增量（2026-10-17 实测踩过）
     * 归来 = playTurn('return') + triggerDepth('peek') 同时发生，探头的抬头必须还在。
     * 读**帧末最终值**（探针注册在最后，读到的是叠完的值）；__turnLastWritten 是
     * 转向层同族参数真正写进去的值，两者相减就是 depth 的净贡献。 */
    await page.evaluate(() => {
      window.__nagiFreezeIdle(false) // 冻结会连 depth 的增量一起按成 0，必须关
      window.__nagiSetIdleHead(0) // 待机摆头也是 add，排除它的分量
      window.__nagiApplyRhythmPose('neutral') // 时段表现同理
    })
    // 时段表现是运行时才注册的 hook，执行顺序在 turn 的 set **之后**——它的 add 会
    // 落在帧末值里污染净贡献。收回是渐变的（rate=6/s，约 1.8s 收敛），等它归零再测。
    await sleep(2600)
    const reg = await page.evaluate(async () => {
      const depthOk = window.__nagiDepth('peek')
      const turn = window.__nagiTurn('return')
      const t0 = performance.now()
      while (performance.now() - t0 < 6000) {
        const d = window.__depthLast
        const tw = window.__turnLastWritten
        if (d && d.env >= 0.9 && tw && tw.w >= 0.3) {
          const real = await window.__nagiPoseParams(['ParamAngleX', 'ParamBodyAngleX'])
          return { depthOk, turnOk: turn?.ok === true, real, tw, env: d.env, depthParams: d.params }
        }
        await new Promise((r) => requestAnimationFrame(r))
      }
      return { depthOk, turnOk: turn?.ok === true, real: null, tw: window.__turnLastWritten || null }
    })
    const dAngle = reg.real && reg.tw ? reg.real.ParamAngleX - reg.tw.x : null
    const dBody = reg.real && reg.tw ? reg.real.ParamBodyAngleX - reg.tw.body : null
    check(
      '回归：转向进行中 peek 的抬头增量仍在帧末值里（净贡献 ≈−6°，修复前被 set 盖成 0）',
      reg.depthOk === true && reg.turnOk === true && dAngle !== null && dAngle <= -4 && dAngle >= -8,
      `ΔAngleX=${dAngle?.toFixed(2)}°（turn 写 ${reg.tw?.x?.toFixed(2)}°，帧末 ${reg.real?.ParamAngleX?.toFixed(2)}°，peek 意图 ${reg.depthParams?.ParamAngleX}）`
    )
    check(
      '回归：转向进行中 peek 的身体前倾增量仍在（净贡献 ≈−1.5°）',
      dBody !== null && dBody <= -0.8 && dBody >= -3,
      `ΔBodyAngleX=${dBody?.toFixed(2)}°（turn 写 ${reg.tw?.body?.toFixed(2)}°，帧末 ${reg.real?.ParamBodyAngleX?.toFixed(2)}°）`
    )
    await page.evaluate(() => window.__nagiSetIdleHead(1)) // 恢复摆头
    await waitIdle(page)

    /* ⑪ 对话事件接线（mock 大脑真实链路）：thinking → 前倾 / done → 后仰 */
    const chat = await page.evaluate(async () => {
      const modes = {}
      let doneMode = null
      window.nagi.on('agent:event', (evt) => {
        if (!evt?.type) return
        // 监听器注册在 chat.js 之后 → onStatus/onDone 已同步跑完，这里读到的是落地后的状态
        if (evt.type === 'status') modes[evt.state] = window.__nagiDepthState().mode
        if (evt.type === 'done') doneMode = window.__nagiDepthState().mode
      })
      const input = document.getElementById('input')
      const btn = document.getElementById('btn-send')
      input.value = '你好，凪'
      btn.click()
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        if (doneMode && !btn.disabled) break
        await new Promise((r) => setTimeout(r, 150))
      }
      await new Promise((r) => setTimeout(r, 1200))
      return { modes, doneMode, state: window.__nagiDepthState() }
    })
    check('对话接线：thinking → 前倾凑近（leanIn）', chat.modes?.thinking === 'leanIn', JSON.stringify(chat.modes))
    check('对话接线：done → 后仰靠回去（leanBack）', chat.doneMode === 'leanBack', String(chat.doneMode))
    await waitIdle(page)

    /* ⑫ 设置页 round-trip：滑杆即时生效；开关+保存落盘并热更新 */
    await page.click('#btn-pet-settings')
    await sleep(900)
    const ui0 = await page.evaluate(() => ({
      hasToggle: !!document.getElementById('set-depth-motion'),
      hasSlider: !!document.getElementById('set-depth-amount'),
      sliderVal: document.getElementById('set-depth-amount')?.value,
      toggleOn: document.getElementById('set-depth-motion')?.checked
    }))
    check('设置页有纵感动开关与幅度滑杆', ui0.hasToggle && ui0.hasSlider, JSON.stringify(ui0))
    const live = await page.evaluate(() => {
      const el = document.getElementById('set-depth-amount')
      el.value = '1.5'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return { label: document.getElementById('set-depth-amount-val')?.textContent, state: window.__nagiDepthState() }
    })
    check('幅度滑杆拖动即时生效（不必先保存）', live.state.amount === 1.5 && live.label === '1.5', `label=${live.label} amount=${live.state.amount}`)
    await page.evaluate(() => {
      document.getElementById('set-depth-motion').checked = false
      document.getElementById('btn-save-l2d').click()
    })
    await sleep(900)
    const saved1 = await page.evaluate(() => window.__nagiDepthState())
    let disk1 = null
    try {
      disk1 = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))?.live2d?.depthMotion
    } catch {
      /* 读不到再说 */
    }
    check('保存后纵感动关闭（state + 落盘一致）', saved1.enabled === false && disk1 && disk1.enabled === false && disk1.amount === 1.5, `state.enabled=${saved1.enabled} disk=${JSON.stringify(disk1)}`)
    await page.evaluate(() => {
      document.getElementById('set-depth-motion').checked = true
      document.getElementById('btn-save-l2d').click()
    })
    await sleep(900)
    const saved2 = await page.evaluate(() => window.__nagiDepthState())
    let disk2 = null
    try {
      disk2 = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))?.live2d?.depthMotion
    } catch {
      /* 读不到再说 */
    }
    check('重新开启后纵感动恢复（state + 落盘一致）', saved2.enabled === true && disk2 && disk2.enabled === true && disk2.amount === 1.5, `state.enabled=${saved2.enabled} disk=${JSON.stringify(disk2)}`)
    // 恢复幅度基准，别让后面的读取受 1.5 影响
    await page.evaluate(() => {
      const el = document.getElementById('set-depth-amount')
      el.value = '1'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      window.__nagiDepthConfig({ amount: 1 })
    })

    /* ⑬ 静态接线契约：reunion → peek（真机要走 5 分钟离开段，由 presence 自测覆盖；
     * 这里钉代码路径，动作本身已在 ⑤ 真机验过） */
    const mainSrc = readFileSync(join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8')
    const wThinking = /onStatus:\s*\(state\)\s*=>\s*\{[\s\S]{0,600}?triggerDepth\('leanIn'\)/.test(mainSrc)
    const wDone = /onDone:\s*\(\)\s*=>\s*\{[\s\S]{0,600}?triggerDepth\('leanBack'\)/.test(mainSrc)
    const wReunion = /onReunion:[\s\S]{0,600}?triggerDepth\('peek'\)/.test(mainSrc)
    check('接线契约：onStatus(thinking)→leanIn / onDone→leanBack / onReunion→peek', wThinking && wDone && wReunion, `thinking=${wThinking} done=${wDone} reunion=${wReunion}`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  ✘ ${f.name}${f.detail ? '：' + f.detail : ''}`)
    }
    console.log(`快照目录：${SNAP_DIR}`)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await stopApp(child)
  }
}

main().catch((err) => {
  console.error('校验失败：', err)
  process.exitCode = 1
})
