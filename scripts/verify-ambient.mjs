// scripts/verify-ambient.mjs
// 待机行为与装束的真机验收（真实 Electron 桌宠 + 生产渲染层）。
//
// 验的是"看起来对了"背后那几件容易假通过的事：
//   A. 装束清单从模型里读出来了（nagi-outfit.json 真的被加载）
//   B. 换装束以后画面真的变了（不是只改了内部状态）
//   C. **装束与情绪表情并存** —— 这是整个设计的关键：
//      Live2D 的 expression 是独占的，所以装束才必须走参数层。
//      这里先让情绪把脸笑出来，再换装束，确认那张脸还在（没被顶掉）。
//   D. 眨眼掩护真的发生（切换期间眼睛确实闭到过 0）——否则就是"啪"地硬切
//   E. 注视方向能落到模型上，且回中时不残留
//   F. 静默（勿扰）时目光必须归中 —— 对应 verify-pose 的"不跟随鼠标"，不能回归
//   G. 自主配额按保守档生效（一天上限 3 次），不是无限换
//   H. 控制台干净
//
// 用法：npm run verify:ambient
//
// 注意：**不要** browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9361'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-ambient-'))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        llm: { provider: 'custom', model: 'x' },
        // 勿扰：验证实例不该被真实鼠标扰动（注视链路单独用注入的方式测）
        privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
        live2d: { frame: 'bust', petWidth: 400, petHeight: 600, outfit: 'daily' },
        ambient: { enabled: true, gaze: true, autonomous: true, level: 'conservative', hotkeys: false }
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

const child = spawn(ELECTRON, ['.', `--user-data-dir=${newUserData()}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: baseEnv(),
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function measure(page) {
  return page.evaluate(async () => {
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
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) n++
    return { n, w: c.width, h: c.height, data: null }
  })
}

let browser
try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) up = true
    } catch {
      /* 还没起来 */
    }
    if (!up) await sleep(400)
  }
  if (!up) throw new Error('CDP 没起来（GPU 进程崩了？需要 NAGI_RENDERER_SANDBOX=0）')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)

  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const ok = await p.evaluate(
            () =>
              document.body?.dataset?.mode === 'pet' &&
              typeof window.__nagiOutfitConfig === 'function' &&
              !!window.__nagiOutfitConfig()
          )
          if (ok) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到就绪的桌宠页')

  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async (tag) => {
    if (!SHOT_DIR) return
    const url = await page.evaluate(() => window.__nagiSnapshot())
    if (url) writeFileSync(join(SHOT_DIR, `${tag}.png`), Buffer.from(url.split(',')[1], 'base64'))
  }

  /* --- A. 装束清单 --- */
  const cfg = await page.evaluate(() => window.__nagiOutfitConfig())
  check(
    'A. 装束清单已从模型读取',
    !!cfg && cfg.looks.length >= 4 && cfg.slots.length >= 6,
    cfg ? `${cfg.slots.length} 个槽位、${cfg.looks.length} 套装束（${cfg.looks.map((l) => l.name).join('/')}）` : '没读到配置'
  )

  /* --- 抓帧比较工具 ---
   * 逐像素比较会被抗锯齿边缘放大：模型挪 1 个像素，整圈轮廓都"变了"。
   * 所以降采样成 24×24 的块（按 alpha 加权），比块级差异 —— 微小位移被平均掉，
   * "换了一身/换了一张脸"这种整片变化才留得下来。
   */
  await page.evaluate(() => {
    const BLOCKS = 24
    window.__toBlocks = (data, w, h) => {
      const out = new Float64Array(BLOCKS * BLOCKS * 4)
      const cnt = new Float64Array(BLOCKS * BLOCKS)
      const bw = w / BLOCKS
      const bh = h / BLOCKS
      for (let y = 0; y < h; y++) {
        const by = Math.min(BLOCKS - 1, (y / bh) | 0)
        for (let x = 0; x < w; x++) {
          const bx = Math.min(BLOCKS - 1, (x / bw) | 0)
          const i = (y * w + x) * 4
          const k = by * BLOCKS + bx
          const a = data[i + 3] / 255
          out[k * 4] += data[i] * a
          out[k * 4 + 1] += data[i + 1] * a
          out[k * 4 + 2] += data[i + 2] * a
          out[k * 4 + 3] += data[i + 3]
          cnt[k]++
        }
      }
      for (let k = 0; k < BLOCKS * BLOCKS; k++) {
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
      return window.__toBlocks(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height)
    }
    window.__blockDiff = (A, B) => {
      let changed = 0
      for (let k = 0; k < BLOCKS * BLOCKS; k++) {
        const da = Math.abs(A[k * 4 + 3] - B[k * 4 + 3])
        const dc =
          Math.abs(A[k * 4] - B[k * 4]) + Math.abs(A[k * 4 + 1] - B[k * 4 + 1]) + Math.abs(A[k * 4 + 2] - B[k * 4 + 2])
        if (da > 24 || dc > 72) changed++
      }
      return changed / (BLOCKS * BLOCKS)
    }
  })

  /* --- B. 换装束画面真的变了 ---
   * 先冻结她自己会动的那些参数（待机摆动 / 呼吸 / 眨眼）：不冻结的话
   * 两次抓帧天然差一大截，分不清"画面变了"是换装束还是她刚好摆到别处。
   */
  await page.evaluate(() => window.__nagiFreezeIdle(true))
  await sleep(900)
  const jit1 = await page.evaluate(() => window.__shotBlocks())
  await sleep(360)
  const jit2 = await page.evaluate(() => window.__shotBlocks())
  const jitter = await page.evaluate(([a, b]) => window.__blockDiff(a, b), [jit1, jit2])

  await page.evaluate(() => window.__nagiSetOutfit('daily'))
  await sleep(1100)
  const before = await page.evaluate(() => window.__shotBlocks())
  await shot('01_daily')
  await page.evaluate(() => window.__nagiSetOutfit('going_out'))
  await sleep(1300)
  const after = await page.evaluate(() => window.__shotBlocks())
  await shot('02_going_out')
  const diff = await page.evaluate(([a, b]) => window.__blockDiff(a, b), [before, after])
  check(
    'B. 换装束后画面确实变了',
    diff > 0.02 && jitter < 0.05,
    `块级差异 ${(diff * 100).toFixed(1)}%（换装束）；冻结后静置抖动 ${(jitter * 100).toFixed(1)}%`
  )

  /* --- C. 关键：装束与情绪表情并存（表情没被顶掉） ---
   *
   * 判据用**画面差分**而不是读参数：2026-10-17 实测发现渲染库定格的参数数组
   * （readParams 读的那份）读不到表情/眨眼那一层的值——拿它对比会得到"两边都是 0、
   * 所以一致"的假通过。画面是最终产物，用它才靠得住。
   */
  const coexist = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // 冻结自己会动的参数后，画面差异才只反映"面容 + 装束"
    window.__nagiFreezeIdle(true)
    await wait(500)

    window.__nagiSetOutfit('night')
    await wait(1300)
    window.__nagiTestExpression(null)
    await wait(700)
    const neutralFace = await window.__shotBlocks()

    // ① 装束之上加表情：画面必须变化（说明表情没被装束挡住）
    window.__nagiTestExpression('nagi_joy')
    await wait(900)
    const smiling = await window.__shotBlocks()
    const exprOnTop = window.__blockDiff(neutralFace, smiling)

    // ② 保持表情去换装束：变化应当来自"换了衣服"，而不是"脸没了"
    window.__nagiSetOutfit('daily')
    await wait(1300)
    const outfitSwapped = await window.__shotBlocks()
    const outfitDiff = window.__blockDiff(smiling, outfitSwapped)

    // ③ 换回原装束但不清表情：应当回到接近 smiling（脸还在）
    window.__nagiSetOutfit('night')
    await wait(1300)
    const backToNight = await window.__shotBlocks()
    const backDiff = window.__blockDiff(smiling, backToNight)

    return {
      exprOnTop,
      outfitDiff,
      backDiff,
      probe: window.__nagiDeepProbe(['ParamCheek', 'ParamEyeLSmile', 'Param469']),
      outfit: window.__nagiOutfit()
    }
  })
  await page.evaluate(() => window.__nagiFreezeIdle(false)) // 解冻：下面的 D 项要测动作
  check(
    'C. 装束与情绪表情并存（表情能盖在装束上）',
    coexist.exprOnTop > 0.02 && coexist.outfitDiff > 0.02,
    `装束下加表情画面变化 ${(coexist.exprOnTop * 100).toFixed(2)}%；` +
      `带表情换装束变化 ${(coexist.outfitDiff * 100).toFixed(2)}%；` +
      `换回原装束后与换之前差异 ${(coexist.backDiff * 100).toFixed(2)}%`
  )
  info('装束目标参数', JSON.stringify(coexist.outfit?.params))
  info(
    '参数三层读数（诊断）',
    `mirror.ParamCheek=${coexist.probe?.mirror?.ParamCheek} live=${coexist.probe?.live?.ParamCheek} core=${coexist.probe?.core?.ParamCheek}`
  )

  /* --- D. 眨眼掩护（看埋点，不看参数） --- */
  const blinkBefore = await page.evaluate(() => window.__nagiBlinkTrace())
  await page.evaluate(() => window.__nagiSetOutfit('work'))
  await sleep(1100)
  const blinkAfter = await page.evaluate(() => window.__nagiBlinkTrace())
  const blinkFired = (blinkAfter?.count || 0) > (blinkBefore?.count || 0)
  check(
    'D. 切换时有眨眼掩护（不是硬切）',
    blinkFired && blinkAfter.min < 0.2,
    `掩护航线打了 ${blinkAfter.count - blinkBefore.count} 次，眼睛最小开度 ${blinkAfter.min}（0 = 完全闭合）`
  )
  await sleep(400)
  await shot('03_work')

  /* --- E. 注视方向落到模型上 --- */
  const gazeRight = await page.evaluate(async () => {
    window.__nagiSetGaze(1, 0)
    await new Promise((r) => setTimeout(r, 1400))
    return window.__nagiFocusState()
  })
  const gazeBack = await page.evaluate(async () => {
    window.__nagiSetGaze(0, 0)
    await new Promise((r) => setTimeout(r, 1600))
    return window.__nagiFocusState()
  })
  check(
    'E. 注视：给方向会朝那边看，回中会归位',
    gazeRight?.targetX === 1 && gazeRight?.x > 0.15 && Math.abs(gazeBack?.x ?? 9) < 0.15,
    `右看 target=${gazeRight?.targetX} 实际 x=${gazeRight?.x?.toFixed(3)}；回中后 x=${gazeBack?.x?.toFixed(3)}`
  )

  /* --- F. 静默时归中（不能回归"跟随鼠标"） --- */
  const amb = await page.evaluate(() => window.__nagiAmbient())
  const focusNow = await page.evaluate(() => window.__nagiFocusState())
  check(
    'F. 勿扰/静默时目光归中（不追随鼠标）',
    Math.abs(amb?.appliedGaze?.x ?? 9) < 1e-6 &&
      Math.abs(amb?.appliedGaze?.y ?? 9) < 1e-6 &&
      Math.abs(focusNow?.targetX ?? 9) < 1e-6,
    `ambient.appliedGaze=${JSON.stringify(amb?.appliedGaze)}，focus.target=(${focusNow?.targetX},${focusNow?.targetY})`
  )

  /* --- G. 自主配额按保守档 --- */
  const plan = amb?.plan || {}
  check(
    'G. 自主换装配额（保守档：一天 ≤3 次）',
    plan.restyleMaxPerDay === 3 && amb?.enabled === true && amb?.autonomous === true,
    `上限 ${plan.restyleMaxPerDay} 次/天，今日已用 ${plan.restyleCount}，下次动作时点 ${plan.nextMotionAt ? '已排' : '未排'}`
  )

  /* --- H. 用户在设置页/热键触发的指令链路 --- */
  const cmdRes = await page.evaluate(async () => {
    const before = window.__nagiOutfit().lookId
    window.__nagiAmbientCommand({ action: 'next' })
    await new Promise((r) => setTimeout(r, 900))
    const after = window.__nagiOutfit().lookId
    window.__nagiAmbientCommand({ action: 'act' })
    return { before, after }
  })
  check(
    'H. 宿主指令链路（热键/托盘走的就是这条）',
    cmdRes.after && cmdRes.after !== cmdRes.before,
    `${cmdRes.before} → ${cmdRes.after}（next 指令生效）`
  )

  /* --- J. 微表情池 --- */
  const micro = await page.evaluate(() => window.__nagiMicroConfig())
  check(
    'J. 微表情池已从模型读取',
    !!micro && (micro.pool || []).length >= 5,
    micro ? `${micro.pool.length} 个：${micro.pool.map((e) => e.name).join('/')}（时长 ${micro.holdMs.join('~')}ms）` : '没读到'
  )

  /* --- K. 微表情：闪得出来，并且会自己收回 ---
   * 这条最容易被做成"假通过"：只看"闪出来了"不看"收回去了"，
   * 结果她可能永远顶着一双星星眼。所以两头都测。
   */
  const microFlash = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // 抓帧期间把"自己动一下/自己换装"按住：否则她可能在这 2 秒里插播一个动作
    window.__nagiSuppressAutoAct?.(true)
    window.__nagiFreezeIdle(true)
    await wait(700)
    const base = await window.__shotBlocks()
    const hit = window.__nagiFlashMicro('star')
    await wait(750)
    const during = await window.__shotBlocks()
    const liveState = window.__nagiMicroState()
    await wait(2200)
    const afterState = window.__nagiMicroState()
    window.__nagiFreezeIdle(false)
    window.__nagiSuppressAutoAct?.(false)
    return {
      name: hit?.name || null,
      lit: window.__blockDiff(base, during),
      liveDuring: !!liveState,
      goneAfter: afterState === null
    }
  })
  /*
   * 为什么"收回"用状态判断而不是画面判断：
   *   框架每帧末会 loadParameters()，把参数恢复成"动作之后、表情之前"的定格值
   *   （见 cubism4.js 的 update 尾部）。也就是说微表情的 add 只在当帧有效、
   *   不会残留——只要 hook 卸载了就一定回落。
   *   而"画面是否回到基线"会被主进程 15 秒一次的情绪心跳干扰（它会把表情重新播回来），
   *   拿画面判断会得到假失败。所以这里判 hook 卸载，画面只用来证明"真的闪出来了"。
   */
  check(
    'K1. 微表情能闪出来（画面真的变了）',
    microFlash.lit > 0.02 && microFlash.liveDuring,
    `${microFlash.name}：闪起时与基线差 ${(microFlash.lit * 100).toFixed(1)}%`
  )
  check(
    'K2. 2 秒后自己收回（钩子已卸载，不会残留成永久星星眼）',
    microFlash.goneAfter,
    microFlash.goneAfter ? '到时状态已清空' : '到时仍在闪（会残留）'
  )

  /* --- L. 撅嘴的可见度（2026-10-17 增强前只有 0.2%，等于看不见） --- */
  const pout = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__nagiSuppressAutoAct?.(true)
    window.__nagiFreezeIdle(true)
    await wait(700)
    const base = await window.__shotBlocks()
    let best = 0
    // 取 3 次里最明显的一次：嘴在胸像取景里只占画面零点几个百分点，
    // 单次采样很容易落在淡入途中（这不是"没效果"，是采样点的问题）
    for (let i = 0; i < 3; i++) {
      window.__nagiTestExpression('nagi_pout')
      await wait(850)
      const p = await window.__shotBlocks()
      best = Math.max(best, window.__blockDiff(base, p))
      window.__nagiTestExpression(null)
      await wait(600)
    }
    window.__nagiFreezeIdle(false)
    window.__nagiSuppressAutoAct?.(false)
    return { delta: best }
  })
  check(
    'L. 撅嘴现在看得出来（增强前实测 0.2% ≈ 看不见）',
    pout.delta > 0.008,
    `与平静脸的画面差异 ${(pout.delta * 100).toFixed(1)}%（约增强前的 ${(pout.delta / 0.002).toFixed(0)} 倍；` +
      '嘴在胸像取景里本来就只占零点几个百分点，绝对值不会大）'
  )

  /* --- M. 罕见专场（Scene：那套 28 参数的完整演出）能播 --- */
  const showpiece = await page.evaluate(async () => {
    window.__nagiAmbientCommand({ action: 'showpiece' })
    await new Promise((r) => setTimeout(r, 500))
    return window.__nagiFocusState()
  })
  check(
    'M. 专场演出（Scene）能播',
    showpiece?.motionGroup === 'Scene',
    `当前动作组：${showpiece?.motionGroup}`
  )

  const noisy = errs.filter((t) => !/favicon|Failed to load resource/i.test(t))
  check('I. 无控制台报错', noisy.length === 0, noisy.length ? noisy.slice(0, 3).join(' | ') : '0 条')
  if (SHOT_DIR) console.log('\n截图目录：', SHOT_DIR)

  const failed = results.filter((r) => !r.pass)
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
