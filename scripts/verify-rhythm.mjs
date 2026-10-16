// scripts/verify-rhythm.mjs
// BLUE-2 时段表现的实机校验（2026-10-17）：
//   ① 端到端广播链路：主进程 presence 快照 → presence.js → live2d.applyRhythmPose，
//      渲染层落地的时段与「按 rhythm.at 用 core 时段表推算」一致；
//   ② 深夜（all-day night 时段表驱动）：目光微垂 / 眼微阖
//      （ΔEyeBallY≈-0.15、ΔEyeLOpen/ROpen≈-0.06），头/身体/呼吸同向（信息项）；
//   ③ 午后（all-day afternoon 驱动）：半眯眼 / 微张口 / 低头
//      （ΔEyeLOpen≈-0.2、ΔEyeBallY≈-0.12、ΔMouthOpenY≈+0.08）；
//   ④ 时段切换是渐变改目标：night→afternoon 全程不经收回中立
//      （200ms 粒度采标签，中间不许出现 neutral）；
//   ⑤ 关节律开关 → 平滑收回中立，增量归零交还自然动画（对配对中立基线）；
//   ⑥ 无预设时段（all-day morning）：不施加任何叠加（pose 保持 neutral）；
//   ⑦ 模型参数清单含预设全部参数（「禁止映射不存在的参数」的运行时一侧）。
//
// 为什么用「改时段表」而不是调试口直接施加：presence 心跳每 15s 会用真实时段
// 覆盖渲染层，调试口施加的时段活不过一个心跳周期。改 settings 里的时段表
// （[[0,1440,period]] 全天表）让整条生产链路（设置 → 主进程 → 广播 →
// presence.js → live2d → 模型）自己产出要测的时段——测的正是要上线的路径。
//
// 采样口径（沿用 verify-pose 实测逼出来的纪律）：
//   · 强制播 Idle[0]（breathing，不写眼球/口型），以「连续两次采样基本一致」为闸门，
//     挡掉应用层随机轮换的 shy_idle（它写眼球和口型，实测一次能推动 0.26/0.13）；
//   · 断言一律用**增量**（时段 - 配对中立基线）：动作结束不归零会把上一个动作的
//     末值冻结在参数里，增量里冻结项抵消，只剩时段表现的贡献。
//
// 用法：npm run verify:rhythm
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { createCircadian } from '../src/core/presence/circadian.js'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SNAP_DIR = join(tmpdir(), `nagi-rhythm-${Date.now()}`)
const ALL_DAY = (period) => [[0, 1440, period]] // 全天表：让「现在」永远落在指定时段

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EYE_IDS = ['ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY']
const BODY_IDS = ['ParamAngleX', 'ParamBodyAngleX', 'ParamBreath']
const PROBE_IDS = [...EYE_IDS, ...BODY_IDS]
const STABLE_EPS = 0.03
const HIT_EPS = STABLE_EPS + 0.005 // 断言容差略大于闸门：两次采样误差叠加后的安全边界
const near = (actual, target, eps = HIT_EPS) => actual !== null && Math.abs(actual - target) < eps

/* ---------------- 起实例 / 收实例 ---------------- */

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则 electron 会当 node 跑
  return Object.assign(env, { NAGI_RENDERER_SANDBOX: '0' }, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rhythm-'))
  // 无 key → 走本地占位大脑（mockRun）；presence 不配 → 全部默认（时间感全开）
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

async function findPage(browser, timeoutMs = 30000) {
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
  const f = join(SNAP_DIR, `rhythm-${name}.png`)
  writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'))
  info('快照', f)
  return f
}

/* ---------------- 采样：静止闸门 ---------------- */

/** 连续两次采样一致才算数（挡 shy_idle 等写眼球/口型的随机待机动作） */
async function sampleStable(page, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    await page.evaluate(() => window.__nagiTestMotion2('Idle', 0)) // breathing：不写眼球/口型
    await sleep(2300) // 等上一个动作淡出（idle 淡出 2s）
    const a = await page.evaluate((ids) => window.__nagiPoseParams(ids), PROBE_IDS)
    await sleep(200)
    const b = await page.evaluate((ids) => window.__nagiPoseParams(ids), PROBE_IDS)
    if (!a || !b) continue
    const still = Math.abs(a.ParamEyeBallX - b.ParamEyeBallX) < STABLE_EPS &&
      Math.abs(a.ParamEyeLOpen - b.ParamEyeLOpen) < STABLE_EPS &&
      Math.abs(a.ParamEyeBallY - b.ParamEyeBallY) < STABLE_EPS &&
      Math.abs(a.ParamMouthOpenY - b.ParamMouthOpenY) < STABLE_EPS
    if (still) return b
    info(`第 ${i} 次采样`, '眼球/口型在动（疑似 shy_idle 在播），重来')
  }
  return null
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const port = 9411
  console.log('起隔离实例（本地占位大脑）…')
  const child = startApp(port)
  try {
    if (!(await waitForCdp(port))) throw new Error('CDP 未就绪')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = await findPage(browser)
    if (!page) throw new Error('桌宠页未就绪（模型没加载出来？）')
    await sleep(1500) // 等模型把首批帧跑完、presence 初始快照到达

    /** 改 presence 配置（写设置通道；presence 心跳 ≤15s 后广播新快照） */
    const setPresence = (patch) => page.evaluate((p) => window.nagi.settings.set({ presence: p }), patch)
    /** 轮询渲染层收到的 rhythm 快照 */
    const rhythmNow = () => page.evaluate(() => window.__nagiRhythm())
    /** 轮询直到条件满足（心跳 15s 一拍，给 25s 预算） */
    const waitFor = async (label, fn, timeoutMs = 25000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (await fn()) return true
        await sleep(300)
      }
      throw new Error(`等待超时：${label}`)
    }
    /** 等时段表现平滑收敛到目标名（ease rate 3/s，约 2.5s 收敛） */
    const waitPose = (name) => waitFor(`pose=${name}`, async () =>
      (await page.evaluate(() => window.__nagiGetRhythmPose())) === name, 8000)

    /* ⑦ 模型参数清单：预设参数必须真实存在（运行时一侧的过滤依据） */
    const ids = await page.evaluate(() => window.__nagiParamIds())
    const presetIds = ['ParamEyeBallY', 'ParamAngleX', 'ParamBodyAngleX', 'ParamBreath', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY']
    check(
      `模型参数清单含时段表现全部预设参数（共 ${ids.length} 项）`,
      presetIds.every((id) => ids.includes(id)),
      presetIds.filter((id) => !ids.includes(id)).join(',') || '全部命中'
    )

    /* ① 端到端：默认配置下，广播快照的时段与 core 按 rhythm.at 推算的一致 */
    const e2e = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { rhythm: window.__nagiRhythm(), pose: window.__nagiGetRhythmPose() }
    })
    const at = e2e.rhythm?.at || Date.now()
    const expectedPeriod = createCircadian({ now: () => at, getConfig: () => ({}) }).current().period
    const expectedPose = expectedPeriod === 'night' || expectedPeriod === 'afternoon' ? expectedPeriod : 'neutral'
    info('端到端快照', `at=${new Date(at).toLocaleString()} period=${e2e.rhythm?.period} enabled=${e2e.rhythm?.enabled} → pose=${e2e.pose}`)
    check(
      `广播链路落地正确（当前时段 ${expectedPeriod} → ${expectedPose}）`,
      e2e.rhythm?.period === expectedPeriod && (e2e.pose === expectedPose || e2e.pose === `${expectedPose}→neutral`),
      `rhythm=${JSON.stringify(e2e.rhythm)} pose=${e2e.pose}`
    )

    /* 采样前先关掉「待机放大提醒 + 随机换待机动作」：
     * startIdleWatch 每 20s 有 35% 概率随手换一个 Idle 组，shy_idle 会写眼球和口型
     * （实测能推动 0.26/0.3），插进采样窗口就会污染增量。关掉它，采样窗口里
     * 只有我们强制播的 Idle[0]（breathing：不写眼球/口型，同时把眨眼压住）。 */
    await page.evaluate(() => window.nagi.settings.set({ live2d: { idleBoost: false } }))

    /* ②-a 关节律开关 → 收回中立（配对中立基线 restA：后面所有增量都对它） */
    await setPresence({ rhythmEnabled: false })
    await waitFor('rhythm.enabled=false', async () => (await rhythmNow())?.enabled === false)
    await waitPose('neutral')
    await sleep(500)
    const restA = await sampleStable(page)
    if (!restA) throw new Error('采不到静止样本（待机动作一直不消停）')
    info('配对中立基线 A', JSON.stringify(restA))
    const dA = (sample, id) => (sample ? sample[id] - restA[id] : null)

    /* ②-b 全天深夜：生产链路自己产出 night
     *
     * 落地条件必须是「新旧配置不可能同时满足」的组合：此刻旧快照是
     * rhythmEnabled=false（period 仍是真实时钟的 night），所以
     * enabled===true && period==='night' 只有新配置广播后才成立——
     * 只等 period==='night' 会被旧快照秒满足（实测踩过）。 */
    await setPresence({ rhythmEnabled: true, weekdaySchedule: ALL_DAY('night'), weekendSchedule: ALL_DAY('night') })
    await waitFor('night 落地（enabled && period）', async () => {
      const r = await rhythmNow()
      return r?.enabled === true && r?.period === 'night'
    })
    await waitPose('night')
    await sleep(300)
    const night = await sampleStable(page)
    info('night 采样', JSON.stringify(night))
    check(
      '深夜目光微垂（ΔEyeBallY≈-0.15）',
      near(dA(night, 'ParamEyeBallY'), -0.15),
      `Δ=${dA(night, 'ParamEyeBallY')?.toFixed(4)}`
    )
    check(
      '深夜双眼微阖（ΔEyeLOpen/ROpen≈-0.06）',
      near(dA(night, 'ParamEyeLOpen'), -0.06) && near(dA(night, 'ParamEyeROpen'), -0.06),
      `ΔL=${dA(night, 'ParamEyeLOpen')?.toFixed(4)} ΔR=${dA(night, 'ParamEyeROpen')?.toFixed(4)}`
    )
    if (night) {
      info('night 头/身体/呼吸（信息项：自然摆动 ±15°/±10°/±4° 与框架呼吸会干扰，看快照目视）',
        `ΔAngleX=${(night.ParamAngleX - restA.ParamAngleX).toFixed(2)} ΔBodyAngleX=${(night.ParamBodyAngleX - restA.ParamBodyAngleX).toFixed(2)} ΔBreath=${(night.ParamBreath - restA.ParamBreath).toFixed(3)}（目标 -2.5 / -1 / -0.2）`)
    }
    await saveSnap(page, 'night')

    /* ③ 全天午后：night→afternoon 直接改目标（200ms 采标签，中间不许出现 neutral）
     *
     * 落地条件同上（旧快照是全天 night，period==='afternoon' 只有新配置才成立）。
     * 标签循环本身就是落地等待：出现 'afternoon' 即视作新时段已受理。 */
    await setPresence({ weekdaySchedule: ALL_DAY('afternoon'), weekendSchedule: ALL_DAY('afternoon') })
    const labels = []
    const tSwitch = Date.now()
    while (Date.now() - tSwitch < 25000) {
      const pose = await page.evaluate(() => window.__nagiGetRhythmPose())
      if (labels[labels.length - 1] !== pose) labels.push(pose)
      if (pose === 'afternoon') break
      await sleep(200)
    }
    const firstAfternoon = labels.indexOf('afternoon')
    const sawNeutralMidway = labels.slice(0, firstAfternoon === -1 ? labels.length : firstAfternoon).some((l) => l.includes('neutral'))
    check(
      '时段切换不经收回中立（night→afternoon 直达，标签序列无 neutral）',
      firstAfternoon !== -1 && !sawNeutralMidway,
      labels.join(' → ')
    )
    await waitPose('afternoon')
    await sleep(300)
    const afternoon = await sampleStable(page)
    info('afternoon 采样', JSON.stringify(afternoon))
    check(
      '午后半眯眼（ΔEyeLOpen/ROpen≈-0.2）',
      near(dA(afternoon, 'ParamEyeLOpen'), -0.2) && near(dA(afternoon, 'ParamEyeROpen'), -0.2),
      `ΔL=${dA(afternoon, 'ParamEyeLOpen')?.toFixed(4)} ΔR=${dA(afternoon, 'ParamEyeROpen')?.toFixed(4)}`
    )
    check('午后目光微垂（ΔEyeBallY≈-0.12）', near(dA(afternoon, 'ParamEyeBallY'), -0.12), `Δ=${dA(afternoon, 'ParamEyeBallY')?.toFixed(4)}`)
    check('午后微张口（ΔMouthOpenY≈+0.08，近似慵懒；模型无哈欠动作组）', near(dA(afternoon, 'ParamMouthOpenY'), 0.08), `Δ=${dA(afternoon, 'ParamMouthOpenY')?.toFixed(4)}`)
    await saveSnap(page, 'afternoon')

    /* ⑤ 再关节律开关 → 平滑收回中立，增量归零（对同一份配对基线 restA） */
    await setPresence({ rhythmEnabled: false })
    await waitFor('rhythm.enabled=false（第二次）', async () => (await rhythmNow())?.enabled === false)
    await waitPose('neutral')
    await sleep(500)
    const restB = await sampleStable(page)
    info('收回后中立采样', JSON.stringify(restB))
    check(
      '增量归零交还自然动画（眼球/口型对配对基线全部回到 ±0.01）',
      restB !== null && Math.abs(restB.ParamEyeBallY - restA.ParamEyeBallY) < 0.01 &&
        Math.abs(restB.ParamEyeLOpen - restA.ParamEyeLOpen) < 0.01 &&
        Math.abs(restB.ParamEyeROpen - restA.ParamEyeROpen) < 0.01 &&
        Math.abs(restB.ParamMouthOpenY - restA.ParamMouthOpenY) < 0.01,
      restB ? `ΔEyeBallY=${(restB.ParamEyeBallY - restA.ParamEyeBallY).toFixed(4)} ΔEyeLOpen=${(restB.ParamEyeLOpen - restA.ParamEyeLOpen).toFixed(4)} ΔMouth=${(restB.ParamMouthOpenY - restA.ParamMouthOpenY).toFixed(4)}` : '采样失败'
    )
    await saveSnap(page, 'neutral')

    /* ⑥ 无预设时段（全天 morning）：不施加任何叠加 */
    await setPresence({ rhythmEnabled: true, weekdaySchedule: ALL_DAY('morning'), weekendSchedule: ALL_DAY('morning') })
    await waitFor('morning 落地（旧快照是全天 afternoon）', async () => {
      const r = await rhythmNow()
      return r?.enabled === true && r?.period === 'morning'
    })
    await sleep(2500) // 即便有残留也该收完了
    const poseMorning = await page.evaluate(() => window.__nagiGetRhythmPose())
    check('无预设时段不施加叠加（morning → pose 保持 neutral）', poseMorning === 'neutral', String(poseMorning))

    /* ⑦ 设置页表单：回显 / 保存生效 / 拦下非法输入 / 隐私按钮
     * （BLUE-2 新增的「陪伴 · 时间感」区块与时段表编辑器，真机上过一遍才敢算做完）
     *
     * 先把时段表恢复成标准六段表：上一节留下的是全天单行表，编辑器按设计
     * **不渲染输入框**（自定义多段表保留原值），测不了回显与保存。 */
    const DEFAULT_WEEKDAY = [[0, 420, 'night'], [420, 720, 'morning'], [720, 780, 'noon'], [780, 1020, 'afternoon'], [1020, 1380, 'evening'], [1380, 1440, 'night']]
    const DEFAULT_WEEKEND = [[0, 480, 'night'], [480, 720, 'morning'], [720, 780, 'noon'], [780, 1020, 'afternoon'], [1020, 1380, 'evening'], [1380, 1440, 'night']]
    await setPresence({ weekdaySchedule: DEFAULT_WEEKDAY, weekendSchedule: DEFAULT_WEEKEND })
    const uiReport = await page.evaluate(async () => {
      const $ = (id) => document.getElementById(id)
      const times = (id) => [...$(id).querySelectorAll('input[type="time"]')].map((i) => i.value)
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      $('btn-pet-settings').click()
      await wait(600)
      const shown = {
        enabled: $('set-presence-enabled').checked,
        rhythm: $('set-presence-rhythm').checked,
        away: $('set-presence-away').checked,
        reunion: $('set-presence-reunion').checked,
        idle: $('set-presence-idle').value,
        slice: $('set-presence-slice').value,
        min: $('set-presence-reunion-min').value,
        long: $('set-presence-reunion-long').value,
        hours: $('set-presence-reunion-hours').value,
        cooldown: $('set-presence-cooldown').value,
        daily: $('set-presence-daily').value,
        retain: $('set-presence-retain').value,
        maxacts: $('set-presence-maxacts').value,
        weekday: times('presence-sched-weekday'),
        weekend: times('presence-sched-weekend'),
        schedStatus: $('presence-sched-status').textContent
      }

      // A. 改「夜结束于」07:00 → 06:00：应写进设置并即时生效
      $('presence-sched-weekday').querySelector('input[type="time"]').value = '06:00'
      $('btn-save-presence').click()
      await wait(1200)
      const afterSave = {
        status: $('presence-status').textContent,
        weekdaySchedule: (await window.nagi.settings.get()).presence.weekdaySchedule
      }

      // B. 非法边界（早结束于 04:00 < 夜结束于 06:00）：拦下并说明，不写设置
      $('presence-sched-weekday').querySelectorAll('input[type="time"]')[1].value = '04:00'
      $('btn-save-presence').click()
      await wait(1200)
      const afterInvalid = {
        schedStatus: $('presence-sched-status').textContent,
        weekdaySchedule: (await window.nagi.settings.get()).presence.weekdaySchedule
      }
      $('presence-sched-weekday').querySelectorAll('input[type="time"]')[1].value = '12:00'

      // C. 阈值倒挂（30 < 30 不成立）：拦下并说明，不写设置
      $('set-presence-reunion-min').value = '30'
      $('set-presence-reunion-long').value = '30'
      $('btn-save-presence').click()
      await wait(1200)
      const afterReversed = {
        status: $('presence-status').textContent,
        reunionMinMs: (await window.nagi.settings.get()).presence.reunionMinMs
      }
      $('set-presence-reunion-min').value = '5'
      $('set-presence-reunion-long').value = '30'

      // D. 隐私按钮：保留天数 / 条数上限
      $('set-presence-retain').value = '3'
      $('set-presence-maxacts').value = '12'
      $('btn-save-presence-privacy').click()
      await wait(1200)
      const afterPrivacy = {
        status: $('presence-status').textContent,
        retainDays: (await window.nagi.settings.get()).presence.retainDays,
        maxActivities: (await window.nagi.settings.get()).presence.maxActivities
      }
      return { shown, afterSave, afterInvalid, afterReversed, afterPrivacy }
    })
    info('表单回显', JSON.stringify(uiReport.shown))
    check(
      '回显：4 个开关默认全开、9 个数值与两张时段表边界都对',
      uiReport.shown.enabled && uiReport.shown.rhythm && uiReport.shown.away && uiReport.shown.reunion &&
        uiReport.shown.idle === '2' && uiReport.shown.slice === '5' && uiReport.shown.min === '5' &&
        uiReport.shown.long === '30' && uiReport.shown.hours === '90' && uiReport.shown.cooldown === '30' &&
        uiReport.shown.daily === '3' && uiReport.shown.retain === '7' && uiReport.shown.maxacts === '96' &&
        JSON.stringify(uiReport.shown.weekday) === JSON.stringify(['07:00', '12:00', '13:00', '17:00', '23:00']) &&
        JSON.stringify(uiReport.shown.weekend) === JSON.stringify(['08:00', '12:00', '13:00', '17:00', '23:00']),
      `weekday=${uiReport.shown.weekday} weekend=${uiReport.shown.weekend}`
    )
    check(
      '改时段边界能保存并即时生效（夜结束于 06:00 → [[0,360,"night"]]）',
      uiReport.afterSave.status.includes('已保存') &&
        JSON.stringify(uiReport.afterSave.weekdaySchedule?.[0]) === '[0,360,"night"]',
      `${uiReport.afterSave.status} / ${JSON.stringify(uiReport.afterSave.weekdaySchedule?.slice(0, 2))}`
    )
    check(
      '非法时段边界被拦下（递增被破坏 → 中止保存 + 说明 + 设置不变）',
      uiReport.afterInvalid.schedStatus.includes('已中止保存') &&
        JSON.stringify(uiReport.afterInvalid.weekdaySchedule?.[0]) === '[0,360,"night"]',
      `${uiReport.afterInvalid.schedStatus} / ${JSON.stringify(uiReport.afterInvalid.weekdaySchedule?.slice(0, 2))}`
    )
    check(
      '阈值倒挂被拦下（30<30 不成立 → 中止保存 + 说明 + 设置不变）',
      uiReport.afterReversed.status.includes('已中止保存') && uiReport.afterReversed.reunionMinMs === 300000,
      `${uiReport.afterReversed.status} / reunionMinMs=${uiReport.afterReversed.reunionMinMs}`
    )
    check(
      '隐私按钮生效（保留 3 天 / 上限 12 条）',
      uiReport.afterPrivacy.status.includes('已保存') &&
        uiReport.afterPrivacy.retainDays === 3 && uiReport.afterPrivacy.maxActivities === 12,
      `${uiReport.afterPrivacy.status} / ${uiReport.afterPrivacy.retainDays}d ${uiReport.afterPrivacy.maxActivities}`
    )

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
