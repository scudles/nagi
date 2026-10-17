// scripts/verify-pose.mjs
// 立绘行为回归的实机校验（2026-10-15 需求）：
//   ① 「黑脸」系列表情（dark_mask×4）彻底消失——清单里没有、调试口也触发不了；
//   ② 目光与身体不再跟随鼠标（焦点控制器加载时归中后再没动过——直接读它的内部状态，
//      比拿参数反推可靠：待机动作也在写角度/眼球参数）；
//   ③ 动作由对话状态驱动：
//        · 生成回复期间 → 思考姿态（目光偏移 + 轻微低侧头），平滑进入；
//        · 回复返回 / 空闲 → 平滑收回中立，交还呼吸与待机动作；
//        · 一次完整对话链路：thinking 时姿态已在思考态，DONE 后回到中立、
//          且情绪落到面容层（mood.get().expr == 本轮 EMOTION 事件的情绪）。
//
// 用法：npm run verify:pose
//
// 注意：**不要**调用 browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SNAP_DIR = join(tmpdir(), `nagi-pose-${Date.now()}`)

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
  // 本机 GPU 进程会崩（gpu_process_host.cc exit_code=-1073741819），渲染器沙箱必须关，
  // 否则桌宠页永远 ready 不了——2026-10-17 排查：本脚本是全仓唯一漏了这个开关的 verify，
  // 连续两次"桌宠页未就绪"超时。其余 verify-*.mjs 都在自己的启动 env 里设了它。
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-pose-'))
  // 无 key → 走本地占位大脑（mockRun）：事件序列确定、不依赖网络
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

function startApp(port) {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${newUserData()}`, `--remote-debugging-port=${port}`], {
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
  const f = join(SNAP_DIR, `pose-${name}.png`)
  writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'))
  info('快照', f)
  return f
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const port = 9410
  console.log('起隔离实例（本地占位大脑）…')
  const child = startApp(port)
  try {
    if (!(await waitForCdp(port))) throw new Error('CDP 未就绪')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = await findPage(browser)
    if (!page) throw new Error('桌宠页未就绪（模型没加载出来？GPU 进程崩了？试 NAGI_RENDERER_SANDBOX=0）')
    await sleep(1200) // 等模型把首批帧跑完

    /* ① 黑脸系列：清单与调试口都碰不到 */
    // 2026-10-17 改成**数据驱动**：原先把"11 个"写死（Lisette 时代的数字），
    // 换模型后必然失败；而且"能应用"用返回 true 判断是假通过（找不到的表情也不抛错）。
    // 现在直接读模型自己的表情清单来对齐，黑脸按"中英文名都挡"来判。
    const exprs = await page.evaluate(() => window.__nagiExpressionList())
    const BLACK = /dark[_-]?mask|dark[_-]?face|脸黑/i
    const nagi5 = ['nagi_neutral', 'nagi_smile', 'nagi_joy', 'nagi_puzzled', 'nagi_pout']
    check(
      '表情清单里没有黑脸，且 5 个 nagi_* 都在',
      Array.isArray(exprs) && exprs.length > 0 && !exprs.some((n) => BLACK.test(String(n))) && nagi5.every((n) => exprs.includes(n)),
      `共 ${exprs?.length} 个：${JSON.stringify(exprs)}`
    )
    const blocked = await page.evaluate(() => window.__nagiTestExpression('dark_mask'))
    const ok2 = await page.evaluate(() => window.__nagiTestExpression('dark_mask2'))
    const ok3 = await page.evaluate(() => window.__nagiTestExpression('脸黑'))
    check(
      '调试口拒绝黑脸（dark_mask / dark_mask2 / 脸黑 均返回 false）',
      blocked === false && ok2 === false && ok3 === false,
      `dark_mask→${blocked} dark_mask2→${ok2} 脸黑→${ok3}`
    )
    // 用真实存在的表情名验证"正常表情仍可应用"
    const usable = await page.evaluate((n) => window.__nagiTestExpression(n), nagi5[0])
    check('正常表情仍可手动应用', usable === true, `${nagi5[0]} → ${usable}`)
    await page.evaluate(() => window.__nagiTestExpression(null)) // 复位

    /* ② 鼠标不跟随：焦点控制器必须一直是 0（它每帧都会把内部目标写进目光/头部参数） */
    const focusBefore = await page.evaluate(() => window.__nagiFocusState())
    const cdp = await page.context().newCDPSession(page)
    const vp = page.viewportSize() || { width: 400, height: 600 }
    // Input.dispatchMouseEvent 的坐标是视口内的 CSS 像素；桌宠窗的视口就是整个窗口，
    // 所以四个角就是 (2,2)~(w-2,h-2)。页面级 CDP 没有 Browser 域，拿不到屏幕坐标，也不需要。
    for (const [x, y] of [[2, 2], [vp.width - 2, 2], [2, vp.height - 2], [vp.width - 2, vp.height - 2]]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(150)
    }
    const focusAfter = await page.evaluate(() => window.__nagiFocusState())
    const focusZero = (f) => f && f.x === 0 && f.y === 0 && f.targetX === 0 && f.targetY === 0
    check(
      '鼠标怼到四角后焦点控制器仍归中（目光/身体不跟随鼠标）',
      focusZero(focusBefore) && focusZero(focusAfter),
      `before=${JSON.stringify(focusBefore)} after=${JSON.stringify(focusAfter)}`
    )
    check('空闲时自然动画仍在跑（框架自动轮换 Idle 待机组）', focusAfter?.motionGroup === 'Idle', `motionGroup=${focusAfter?.motionGroup}`)
    await cdp.detach().catch(() => {})

    /* ③ 思考姿态：平滑进入 → 保持 → 平滑收回
     *
     * 采样口径（重要，都是实测逼出来的）：
     *  1. 框架自带"动作播完随机换 Idle 组"，而 Idle 组里只有 shy_idle 写眼球参数——
     *     它一播放眼球采样就被污染。这里强制播 Idle[0]（breathing，不写眼球），
     *     并以"连续两次静止采样基本一致"作为闸门，不达标就重来。
     *     闸门容差 0.03：拒绝真实漂移（shy_idle 实测一次能推动 0.26），
     *     同时接纳冻结基线/呼吸末端的微差（量级 5e-5）；卡 1e-9 会因为
     *     呼吸 4s 循环结束的时机永远等不到完全静止的 200ms 窗口。
     *  2. Live2D 的动作结束不归零：硬切动作会把上一个动作的末值冻结在参数里
     *     （实测冻过 -0.3064）。所以断言一律用**增量**（思考 - 中立），
     *     冻结的基线会在减法里抵消，只有姿态的贡献会留下来。
     *  3. 眼球因此是只属于姿态的硬信号；头部/身体参数还被框架呼吸（峰值
     *     ±15°/±10°/±4°）和待机动作干扰，只做方向性参考 + 快照目视，不设硬断言。
     */
    // 2026-10-17 起"待机头部摆动"会顺带把眼珠也带着走（眼神跟头转）。
    // 本块要测的是**注视（focus）**这一层的精确值，所以先把头部摆动关掉，
    // 否则眼珠的增量里混进 ±0.05 的摆动分量，断言必然偏（实测 0.35 → 0.30）。
    // 眼球游走也要一起按住：它用 set 写 ParamEyeBall*、钩子顺序还在姿态之后，
    // 而 probePoseOnce 读的是帧末最终值——不按住，读到的是游走落点而不是姿态目标
    // （2026-10-17 实测 ΔEyeBallX=0.468 ≠ 0.35，收回后也读到 0.11 的游走残余）。
    // 产品层已加"姿态激活时游走让位"，这里再按住是双保险：姿态收回之后游走会恢复。
    await page.evaluate(() => {
      window.__nagiSetIdleHead?.(0)
      window.__nagiSetEyeWander?.(0)
    })
    await sleep(600)
    const probe = () => page.evaluate(() => window.__nagiPoseParams())
    const STABLE_EPS = 0.03
    const HIT_EPS = STABLE_EPS + 0.005 // 断言容差略大于闸门：两次采样误差叠加后的安全边界
    const stable = (a, b) => a && b && Math.abs(a.ParamEyeBallX - b.ParamEyeBallX) < STABLE_EPS && Math.abs(a.ParamEyeBallY - b.ParamEyeBallY) < STABLE_EPS
    let rest = null
    let think = null
    let back = null
    let poseName = null
    let releasing = null
    let poseAfter = null
    let ok = false
    for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
      await page.evaluate(() => window.__nagiTestMotion2('Idle', 0)) // breathing
      await sleep(2300) // 等上一个动作淡出（idle 淡出 2s）
      const r1 = await probe()
      await sleep(200)
      const r2 = await probe()
      if (!stable(r1, r2)) {
        info(`第 ${attempt} 次尝试`, `静止眼球在动（${r1?.ParamEyeBallX} → ${r2?.ParamEyeBallX}），疑似 shy_idle 在播，重来`)
        continue
      }
      rest = r2
      await page.evaluate(() => window.__nagiSetPose('thinking'))
      await sleep(1800) // 平滑进入（rate=6/s，眼珠 0.45 → 1e-4 需 1.42s，留余量）
      const t1 = await probe()
      await sleep(200)
      const t2 = await probe()
      poseName = await page.evaluate(() => window.__nagiGetPose())
      if (!stable(t1, t2)) {
        info(`第 ${attempt} 次尝试`, `思考采样被污染 t1=${JSON.stringify(t1)} t2=${JSON.stringify(t2)}，重来`)
        await page.evaluate(() => window.__nagiSetPose(null))
        await sleep(1200)
        continue
      }
      think = t1
      await saveSnap(page, 'thinking')
      await page.evaluate(() => window.__nagiSetPose(null))
      releasing = await page.evaluate(() => window.__nagiGetPose())
      // 收回也是平滑的（rate=6/s，最大项 AngleZ=5° → 归零到 1e-4 需约 1.8s）
      await sleep(2600)
      const b1 = await probe()
      await sleep(200)
      const b2 = await probe()
      poseAfter = await page.evaluate(() => window.__nagiGetPose())
      if (stable(b1, b2) && poseAfter === 'neutral') {
        back = b2
        ok = true
      } else {
        info(`第 ${attempt} 次尝试`, `收回采样被污染 back=${JSON.stringify(b1)} pose=${poseAfter}，重来`)
      }
    }
    const dEyeX = rest && think ? think.ParamEyeBallX - rest.ParamEyeBallX : null
    const dEyeY = rest && think ? think.ParamEyeBallY - rest.ParamEyeBallY : null
    const rEyeX = rest && back ? back.ParamEyeBallX - rest.ParamEyeBallX : null
    const rEyeY = rest && back ? back.ParamEyeBallY - rest.ParamEyeBallY : null
    info('中立基线', JSON.stringify(rest))
    info('思考采样', JSON.stringify(think))
    check('思考姿态生效（getPose = thinking）', poseName === 'thinking', String(poseName))
    check(
      '目光偏移量精确命中目标（ΔEyeBallX=+0.35 / ΔEyeBallY=-0.45；breathing 不写眼球，增量里只剩姿态）',
      dEyeX !== null && Math.abs(dEyeX - 0.35) < HIT_EPS && Math.abs(dEyeY + 0.45) < HIT_EPS,
      `ΔEyeBallX=${dEyeX?.toFixed(4)} ΔEyeBallY=${dEyeY?.toFixed(4)}`
    )
    if (rest && think) {
      const dz = think.ParamAngleZ - rest.ParamAngleZ
      const dx = think.ParamAngleX - rest.ParamAngleX
      const db = think.ParamBodyAngleX - rest.ParamBodyAngleX
      info('头/身体角度变化（参考项，呼吸 ±15°/±10°/±4° 会干扰，看快照目视）', `ΔAngleZ=${dz.toFixed(2)} ΔAngleX=${dx.toFixed(2)} ΔBodyAngleX=${db.toFixed(2)}（目标 +5 / -4 / -2）`)
    }
    check('收回是渐变的（先进入 thinking→neutral，不是瞬切）', typeof releasing === 'string' && releasing.startsWith('thinking→'), String(releasing))
    check(
      '收回后回到中立基线（getPose = neutral，眼球增量归零交还自然动画）',
      poseAfter === 'neutral' && rEyeX !== null && Math.abs(rEyeX) < HIT_EPS && Math.abs(rEyeY) < HIT_EPS,
      `pose=${poseAfter} ΔEyeBallX=${rEyeX?.toFixed(4)} ΔEyeBallY=${rEyeY?.toFixed(4)}`
    )
    await saveSnap(page, 'neutral')
    await page.evaluate(() => {
      window.__nagiSetIdleHead?.(1) // 恢复头部摆动（下面几项要正常状态）
      window.__nagiSetEyeWander?.(1)
    })

    /* ④ 一次完整对话链路（mock 大脑）：thinking 时已在思考态；DONE 后中立 + 情绪落脸 */
    const trace = await page.evaluate(async () => {
      const seen = []
      const poses = {}
      window.nagi.on('agent:event', (evt) => {
        if (!evt?.type) return
        // 监听器注册在 chat.js 之后 → 它的 onStatus/onDone 已同步跑完，这里读到的是落地后的姿态
        if (evt.type === 'status') poses[evt.state] = window.__nagiGetPose()
        if (evt.type === 'done') poses.done = window.__nagiGetPose()
        if (evt.type === 'emotion') seen.push(evt.emotion)
      })
      const input = document.getElementById('input')
      const btn = document.getElementById('btn-send')
      input.value = '你好，凪'
      btn.click()
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        if (poses.done && !btn.disabled) break
        await new Promise((r) => setTimeout(r, 150))
      }
      // 收回是渐变的（rate=6/s，约 1.8s 收敛）：轮询等她真的回到中立，
      // 而不是赌一个固定时长——"最终一定回中立"本身就是这条链路要断言的事。
      const t1 = Date.now()
      let poseNow = window.__nagiGetPose()
      while (poseNow !== 'neutral' && Date.now() - t1 < 8000) {
        await new Promise((r) => setTimeout(r, 150))
        poseNow = window.__nagiGetPose()
      }
      const mood = await window.nagi.mood.get()
      return { seen, poses, mood, poseNow }
    })
    info('对话链路', JSON.stringify(trace))
    check('生成回复期间姿态已在思考态（thinking 时 getPose=thinking）', trace.poses?.thinking === 'thinking', JSON.stringify(trace.poses))
    check('回复返回时姿态开始收回（DONE 时 getPose=thinking→neutral）', String(trace.poses?.done || '').startsWith('thinking→') || trace.poses?.done === 'neutral', String(trace.poses?.done))
    check('渐进收回后最终回到中立（不再挂在思考态）', trace.poseNow === 'neutral', trace.poseNow)
    const lastEmotion = trace.seen?.[trace.seen.length - 1]
    // 注意：mood.expr 是"静息面容"推导值（joy 低强度会显示成 smile），所以比对状态机的 mood 字段
    check('回复的情绪落到面容层（mood.mood == 本轮 EMOTION 事件）', !!lastEmotion && trace.mood?.mood === lastEmotion, `emotion=${lastEmotion} mood.mood=${trace.mood?.mood} mood.expr=${trace.mood?.expr}`)
    await saveSnap(page, 'chat-done')

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
