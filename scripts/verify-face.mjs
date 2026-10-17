// scripts/verify-face.mjs
// 面部表达三层的真机验收（2026-10-17）：
//   A. 配置读到了（情绪肌肉 / 微动通道 / 元音）
//   B. **强度连续**：同一个情绪在 0.2 / 0.5 / 0.85 三档必须是三张不同的脸，
//      而且差距随强度差递增 —— 这是"精度"最核心的一条（以前强度完全没参与表情）
//   C. 肌肉层能换脸：joy 与 calm 画面明显不同
//   D. **微动层真的在动**：冻结待机（呼吸/眨眼/摆动都按住）之后，
//      微动开着时画面仍有细小变化，微动关掉后应该几乎静止 —— 这是决定性判据
//   E. 口型能张开（不只是 MouthOpenY 一个参数的事）
//   F. 无控制台报错
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9391'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''

const results = []
const check = (n, p, d = '') => {
  results.push({ n, p, d })
  console.log(`${p ? '✔' : '✘'} ${n}${d ? '：' + d : ''}`)
}
const info = (n, d) => console.log(`　· ${n}：${d}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function baseEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return env
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-face-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600, outfit: 'daily' },
      ambient: { enabled: true, gaze: false, autonomous: false, level: 'conservative', hotkeys: false }
    },
    null,
    2
  ),
  'utf8'
)

const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: baseEnv(),
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

let browser
try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) up = true
    } catch {
      /* 等 */
    }
    if (!up) await sleep(400)
  }
  if (!up) throw new Error('CDP 没起来')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)

  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const ok = await p.evaluate(
            () => document.body?.dataset?.mode === 'pet' && typeof window.__nagiFaceState === 'function'
          )
          if (ok) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到桌宠页')

  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

  // 抓帧工具（块级 24×24，alpha 加权）—— 与其它验收脚本同源
  await page.evaluate(() => {
    const N = 24
    const toBlocks = (data, w, h) => {
      const out = new Float64Array(N * N * 4)
      const cnt = new Float64Array(N * N)
      const bw = w / N
      const bh = h / N
      for (let y = 0; y < h; y++) {
        const by = Math.min(N - 1, (y / bh) | 0)
        for (let x = 0; x < w; x++) {
          const bx = Math.min(N - 1, (x / bw) | 0)
          const i = (y * w + x) * 4
          const k = by * N + bx
          const a = data[i + 3] / 255
          out[k * 4] += data[i] * a
          out[k * 4 + 1] += data[i + 1] * a
          out[k * 4 + 2] += data[i + 2] * a
          out[k * 4 + 3] += data[i + 3]
          cnt[k]++
        }
      }
      for (let k = 0; k < N * N; k++) {
        const c = Math.max(1, cnt[k])
        out[k * 4] /= c
        out[k * 4 + 1] /= c
        out[k * 4 + 2] /= c
        out[k * 4 + 3] /= c
      }
      return Array.from(out)
    }
    window.__shotBlocks = async () => {
      const url = window.__nagiSnapshot()
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const x = c.getContext('2d', { willReadFrequently: true })
      x.drawImage(img, 0, 0)
      return toBlocks(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height)
    }
    window.__blockDiff = (A, B) => {
      let n = 0
      for (let k = 0; k < N * N; k++) {
        const da = Math.abs(A[k * 4 + 3] - B[k * 4 + 3])
        const dc =
          Math.abs(A[k * 4] - B[k * 4]) + Math.abs(A[k * 4 + 1] - B[k * 4 + 1]) + Math.abs(A[k * 4 + 2] - B[k * 4 + 2])
        if (da > 24 || dc > 72) n++
      }
      return n / (N * N)
    }
  })
  const shot = async (tag) => {
    if (!SHOT_DIR) return
    const url = await page.evaluate(() => window.__nagiSnapshot())
    if (url) writeFileSync(join(SHOT_DIR, `${tag}.png`), Buffer.from(url.split(',')[1], 'base64'))
  }
  const diff = (a, b) => page.evaluate(([x, y]) => window.__blockDiff(x, y), [a, b])

  /* --- A. 配置 ---
   * 注意：`__nagiFaceState` 这个调试口在脚本加载时就有了，早于模型 load 完成。
   * 直接读会拿到空配置（踩过），所以要等模型真的就绪。
   */
  let st = null
  for (let i = 0; i < 40; i++) {
    st = await page.evaluate(() => window.__nagiFaceState())
    if (st?.hasConfig) break
    await sleep(500)
  }
  check(
    'A. 面部配置已加载（情绪肌肉 / 微动 / 元音）',
    !!st?.hasConfig && st.emotions.length >= 6 && st.tremorChannels >= 4 && st.visemes.length >= 3,
    `${st?.emotions?.length} 个情绪、${st?.tremorChannels} 路微动、${st?.visemes?.length} 个元音；钩子 ${JSON.stringify(st?.hooks)}`
  )

  await page.evaluate(() => window.__nagiSuppressAutoAct?.(true))
  await page.evaluate(() => window.__nagiFreezeIdle(true))
  // 冻住情绪广播：主进程 15 秒一次的心跳会把下面注入的强度覆盖回"真实情绪"，
  // 表现就是同样的用例一次过、一次不过（踩过）
  await page.evaluate(() => window.__nagiFreezeMood?.(true))
  // 画面差分类的判据（B/C/E）要先按住两层"与脸无关、但每帧都在动"的东西，
  // 否则基线随相位随机漂移，同一个用例两次跑结论不一样（2026-10-17 踩过两次）：
  //   ① Z 轴常驻摆动（B 组新增：±2.5% 缩放 + 上下 3px + 身体微摆）——整只模型都在动；
  //   ② 五官微动 tremor——它是"脸"的一部分，但量的是"强度层次"，不该被它糊住
  //      （D 项会单独把 tremor 打开来量它自己）。
  await page.evaluate(() => window.__nagiDepthConfig?.({ ambient: false }))
  await page.evaluate(() => window.__nagiSetTremor?.(0))
  await sleep(800)

  /* --- B. 强度连续：三档强度必须是三张脸 --- */
  const faces = {}
  for (const [tag, i] of [
    ['low', 0.2],
    ['mid', 0.5],
    ['high', 0.85]
  ]) {
    await page.evaluate((v) => window.__nagiEmotionIntensity('joy', v), i)
    // 轮询到缓动真的到位。目标值**从配置读**（D40：期望值与配置同源的必须实读）——
    // 写死 0.95×i 会在 C 组把 joy 笑眼调到 1.0 之后永不收敛（踩过）。
    // ⚠ emotionTarget 已经是 scaleMuscles(vec, intensity) 的结果，**不要再乘 intensity**。
    for (let k = 0; k < 30; k++) {
      const w = await page.evaluate(() => window.__nagiFaceState()?.emotionTarget?.ParamEyeLSmile ?? 0)
      const cur = await page.evaluate(() => window.__nagiFaceState()?.emotionCurrent?.ParamEyeLSmile ?? 0)
      if (Math.abs(cur - w) < 0.04) break
      await sleep(70)
    }
    faces[tag] = await page.evaluate(() => window.__shotBlocks())
    await shot(`01_joy_${tag}_${String(i).replace('.', '')}`)
  }
  const dLM = await diff(faces.low, faces.mid)
  const dMH = await diff(faces.mid, faces.high)
  const dLH = await diff(faces.low, faces.high)
  check(
    'B. 情绪强度是连续的（0.2 / 0.5 / 0.85 是三张不同的脸）',
    dLM > 0.01 && dMH > 0.01 && dLH > Math.max(dLM, dMH),
    `低↔中 ${(dLM * 100).toFixed(1)}%、中↔高 ${(dMH * 100).toFixed(1)}%、低↔高 ${(dLH * 100).toFixed(1)}%（低↔高应最大）`
  )

  /* --- C. 肌肉层能换脸 --- */
  await page.evaluate(() => window.__nagiEmotionIntensity('joy', 1))
  await sleep(1100)
  const joyFrame = await page.evaluate(() => window.__shotBlocks())
  await page.evaluate(() => window.__nagiEmotionIntensity('calm', 1))
  await sleep(1100)
  const calmFrame = await page.evaluate(() => window.__shotBlocks())
  await shot('02_calm')
  const dJoyCalm = await diff(joyFrame, calmFrame)
  check(
    'C. 肌肉层能换脸（joy vs calm）',
    dJoyCalm > 0.03,
    `画面差异 ${(dJoyCalm * 100).toFixed(1)}%`
  )

  /* --- D. 微动层：开 vs 关，冻结之后还能不能看出在动 --- */
  const sample = async (n = 3, gap = 420) => {
    const frames = []
    for (let i = 0; i < n; i++) {
      frames.push(await page.evaluate(() => window.__shotBlocks()))
      if (i < n - 1) await sleep(gap)
    }
    let worst = 0
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) worst = Math.max(worst, await diff(frames[i], frames[j]))
    }
    return worst
  }
  // 先停在 calm（避免情绪还在缓动造成"假微动"）
  await page.evaluate(() => window.__nagiEmotionIntensity('calm', 1))
  await sleep(1200)
  // 注意：本项要测的是**五官微动**这一层。除此之外还有两层会动画面，都必须按住，
  // 否则基线被它们抬高，结论就不可信（都踩过）：
  //   ① 待机头部摆动（不受 tremorScale 控制）；
  //   ② 自动眨眼（每 4 秒左右闭一次眼，采样恰好撞上就把基线抬到 6%+）。
  await page.evaluate(() => {
    window.__nagiSetTremor(0)
    window.__nagiSetIdleHead?.(0)
    window.__nagiSetBlink?.(0)
  })
  await sleep(700)
  const stillDiff = await sample()
  await page.evaluate(() => {
    window.__nagiSetTremor(1)
    window.__nagiSetIdleHead?.(1)
    window.__nagiSetBlink?.(1)
  })
  await sleep(700)
  const tremorDiff = await sample()
  /*
   * 为什么这里不再拿画面差分当判据：
   * 微动是 0.07~0.4Hz 的低频变化（周期 2.4~14 秒），而一次采样窗口只有 840ms，
   * 很可能整段都落在同一个相位里 —— 实测"开"和"关"都读到 2.95%，完全分不出来。
   * 改成读**真正写进模型的增量**，画面差异只作参考打印。
   */
  const tremorWrites = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const peak = async (ms) => {
      let m = 0
      for (let i = 0; i < ms / 120; i++) {
        await wait(120)
        const t = window.__tremorLast || {}
        for (const k of Object.keys(t)) m = Math.max(m, Math.abs(t[k] || 0))
      }
      return m
    }
    window.__nagiSetTremor(0)
    const off = await peak(1400)
    window.__nagiSetTremor(1)
    const on = await peak(1400)
    window.__nagiSetTremor(1)
    return { off, on }
  })
  check(
    'D. 微动层真的在动（关掉后完全不动，打开后有细动）',
    tremorWrites.on > 0.015 && tremorWrites.off < 0.005,
    `开着时最大增量 ${tremorWrites.on.toFixed(3)}（参数单位），关掉后 ${tremorWrites.off.toFixed(3)}；` +
      `画面变化参考：关 ${(stillDiff * 100).toFixed(2)}% / 开 ${(tremorDiff * 100).toFixed(2)}%`
  )

  /* --- E. 口型 --- */
  await page.evaluate(() => window.__nagiSetMouth(0))
  await sleep(500)
  const mouthClosed = await page.evaluate(() => window.__shotBlocks())
  await page.evaluate(() => window.__nagiSetMouth(0.85))
  await sleep(500)
  const mouthOpen = await page.evaluate(() => window.__shotBlocks())
  await shot('03_mouth_open')
  const dMouth = await diff(mouthClosed, mouthOpen)
  check('E. 口型能张开', dMouth > 0.005, `闭↔张 画面差异 ${(dMouth * 100).toFixed(1)}%`)

  await page.evaluate(() => window.__nagiSetMouth(0))
  await page.evaluate(() => window.__nagiSetTremor(1))
  await page.evaluate(() => window.__nagiFreezeIdle(false))
  await page.evaluate(() => window.__nagiFreezeMood?.(false))
  await page.evaluate(() => window.__nagiSuppressAutoAct?.(false))

  /* --- G. 自动眨眼（2026-10-17 修的真 bug） ---
   * 原来她**一次都不眨**：框架的眨眼只在"这一帧没有动作在更新"时才跑
   * （cubism4.js: if (!motionUpdated) eyeBlink.updateParameters(...)），
   * 而 Idle 动作是常驻循环 → motionUpdated 永远为 true。
   * 判据两个来源：① 计数在涨；② 真的往模型写过闭眼值（不是只算不写）。
   */
  const blink = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = window.__nagiBlinkState()?.count ?? 0
    // 两路证据，缺一不可：
    //   wroteMin —— 抽样"真正写进模型的眼开系数"（闭合段只有 120ms，40ms 一轮才捞得到）
    //   statsMin —— 调度器自己记的最小值（blink.js 的 stats().minF，不受采样窗口影响）
    let minF = 1
    let statsMin = 1
    for (let i = 0; i < 175; i++) {
      await wait(40)
      const w = window.__blinkLastWritten
      if (w && w.f < minF) minF = w.f
      const st = window.__nagiBlinkState()?.minF
      if (typeof st === 'number' && st < statsMin) statsMin = st
    }
    const after = window.__nagiBlinkState()?.count ?? 0
    // 关掉之后不该再眨（证明开关有效，也排除"别的层在动眼睑"）
    window.__nagiSetBlink(0)
    const offAt = window.__nagiBlinkState()?.count ?? 0
    await wait(2600)
    const offEnd = window.__nagiBlinkState()?.count ?? 0
    window.__nagiSetBlink(1)
    return { before, after, minF, statsMin, offAt, offEnd }
  })
  // ★幅度下限（只验方向等于没验，2026-10-17 教训）：
  //   ① 调度器记的最小值必须真的到 0（配置 minClose=0，不是半闭）；
  //   ② 抽样也要能捞到"明显闭下去"的一帧（证明这个值是写进模型的，不只是算出来）。
  check(
    'G2. 眨眼幅度下限：闭合最小值必须真的接近 0（闭到底，不是半闭）',
    blink.after > blink.before && blink.statsMin <= 0.05 && blink.minF <= 0.2,
    `7 秒内眨了 ${blink.after - blink.before} 次；调度器最小值 ${blink.statsMin.toFixed(3)}` +
      `（1 = 全睁，配置 minClose=0 → 应 ≈0），抽样捞到的最闭一帧 ${blink.minF.toFixed(3)}` +
      `；关掉后 2.6 秒内 ${blink.offEnd - blink.offAt} 次`
  )

  /* --- H. 眼球能自己移动（不再只跟着头） ---
   * 之前眼球只有 focus / 转向 / 待机摆动三个来源，全都在"跟着别的东西走"，
   * 所以看起来"视线完全由头部方向决定"。这一项要证明眼球有自己的运动。
   *
   * 2026-10-17：阈值 0.35 曾连续两次挂在分布均值上（实测跨度 0.34 / 0.24，
   * moves 7~8 次都正常）。游走本身偏小幅度（55% 概率 ±0.26、45% 概率往中间收），
   * 6 秒窗口只覆盖 4~6 次扫视，跨度纯看随机落点。窗口拉到 10 秒让随机游走走够，
   * 阈值不动——要证明的是"她自己能挪出三分之一幅面"，不是"挪得越大越好"。
   */
  const eye = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__nagiSuppressAutoAct?.(true)
    window.__nagiFreezeMood?.(true)
    window.__nagiSetBlink?.(0) // 眨眼会遮住眼珠，先关掉
    window.__nagiSetIdleHead?.(0) // 头部摆动会带动眼部跟随，也按住
    window.__nagiSetEyeWander(1)
    await wait(600)
    let minX = 1
    let maxX = -1
    let minY = 1
    let maxY = -1
    let sawWrite = false
    for (let i = 0; i < 100; i++) {
      await wait(100)
      const w = window.__eyeLastWritten
      if (w) {
        sawWrite = true
        minX = Math.min(minX, w.x)
        maxX = Math.max(maxX, w.x)
        minY = Math.min(minY, w.y)
        maxY = Math.max(maxY, w.y)
      }
    }
    const st = window.__nagiEyeState()
    const moves = st?.moves ?? 0
    return { spanX: maxX - minX, spanY: maxY - minY, moves, sawWrite, minX, maxX }
  })
  check(
    'H. 眼球能自己移动（不只是跟着头）',
    eye.sawWrite && eye.spanX > 0.35 && eye.moves >= 2,
    `10 秒内换了 ${eye.moves} 个注视点，横向范围 ${eye.spanX.toFixed(2)}（值域 2.0）；` +
      `纵向 ${eye.spanY.toFixed(2)}（真人上下动得比左右少）`
  )

  // 诊断：情绪键 → 表情名 的解析链（肌肉层是按解析后的名字查表的，解析不到就什么都不做）
  const resolved = await page.evaluate(() =>
    Object.fromEntries(['calm', 'smile', 'joy', 'puzzled', 'worry', 'pout'].map((k) => [k, window.__nagiResolve?.(k) ?? null]))
  )
  info('情绪 → 表情解析', JSON.stringify(resolved))

  /* --- I. 睁眼幅度随情绪变化（不是只有眨眼在动眼睑） --- */
  // 主进程每 15 秒广播一次真实情绪，会把下面注入的情绪覆盖回 calm。
  // 只要心跳恰好落在 1.3 秒的等待里，四个值就全读成 1.00（踩过：一次过一次不过）。
  await page.evaluate(() => window.__nagiFreezeMood?.(true))
  const eyeOpen = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__nagiSetEyeWander?.(0) // 让眼球位置别干扰眼睛大小的读数
    const read = async (mood) => {
      window.__nagiEmotionIntensity(mood, 1)
      await wait(1300) // 等缓动到位
      const cur = window.__nagiFaceState()?.emotionCurrent || {}
      return cur.ParamEyeLOpen ?? 1 // 没写 = 中性 1（全睁）
    }
    // 用**产品真实入口**（情绪键：joy/puzzled/worry/calm），不要用表情文件名。
    // setEmotion 是先 resolveExpression 再查肌肉表，传文件名会解析失败、什么都不做（踩过）
    const joy = await read('joy')
    const puzzled = await read('puzzled')
    const worry = await read('worry')
    const calm = await read('calm')
    window.__nagiSetEyeWander?.(1)
    return { joy, puzzled, worry, calm }
  })
  check(
    'I. 睁眼幅度随情绪不同（笑眼半闭 / 疑惑微眯 / 紧张睁大）',
    eyeOpen.joy < 0.86 && eyeOpen.puzzled > eyeOpen.joy && eyeOpen.worry >= 0.98 && eyeOpen.calm >= 0.98,
    `开心 ${eyeOpen.joy.toFixed(2)} < 疑惑 ${eyeOpen.puzzled.toFixed(2)} < 紧张 ${eyeOpen.worry.toFixed(2)} / 平静 ${eyeOpen.calm.toFixed(2)}`
  )

  /* --- J. 抖耳朵（Param78/79 是物理输入，写它耳朵会自己甩） --- */
  const ear = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = await window.__shotBlocks()
    window.__nagiWiggleEars(0.9, 500)
    let peak = 0
    let framePeak = 0
    for (let i = 0; i < 12; i++) {
      await wait(90)
      peak = Math.max(peak, Math.abs(window.__earLast || 0))
      framePeak = Math.max(framePeak, window.__blockDiff(before, await window.__shotBlocks()))
    }
    await wait(1200)
    return { peak, settled: Math.abs(window.__earLast || 0), framePeak }
  })
  check(
    'J. 抖耳朵：给了冲量，并且自己收干净',
    ear.peak > 0.2 && ear.settled < 0.01,
    `峰值 ${ear.peak.toFixed(2)}，1.2 秒后归零（${ear.settled.toFixed(3)}）；画面变化 ${(ear.framePeak * 100).toFixed(1)}%（耳朵由物理带动）`
  )

  const noisy = errs.filter((t) => !/favicon|Failed to load resource/i.test(t))
  check('K. 无控制台报错', noisy.length === 0, noisy.slice(0, 2).join(' | ') || '0 条')
  if (SHOT_DIR) console.log('\n截图目录：', SHOT_DIR)

  const failed = results.filter((r) => !r.p)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('\n验收中断：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
}
