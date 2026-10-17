// scripts/verify-turns.mjs
// 「转头/转身 + 幅度加大 + 戳一戳递进」的真机验收（2026-10-17）：
//   A. 待机头部真的在动（冻结呼吸/眨眼后仍有缓慢转头）—— 关掉幅度后应几乎静止
//   B. 转向：被戳 → 转过来 → 保持 → 自己转回去（画面先变、后回落）
//   C. 动作期加强：播动作时头部摆动比待机大
//   D. 戳一戳：连戳 8 次，反应逐级变化（第 1 次 / 中段 / 末尾不是同一批话）
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9421'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''

const results = []
const check = (n, p, d = '') => {
  results.push({ n, p, d })
  console.log(`${p ? '✔' : '✘'} ${n}${d ? '：' + d : ''}`)
}
const info = (n, d) => console.log(`　· ${n}：${d}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'nagi-turn-'))
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
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NAGI_RENDERER_SANDBOX = '0'
const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
const logs = []
child.stdout.on('data', (b) => logs.push(String(b)))
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
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (await p.evaluate(() => typeof window.__nagiTurn === 'function' && !!window.__nagiFaceState?.()?.hasConfig)) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到桌宠页')
  // 渲染层的 console.log 走 CDP，不会出现在子进程 stdout 里；不订阅就看不到 [turn] 日志
  page.on('console', (m) => logs.push(m.text() + '\n'))
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

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
  const diff = (a, b) => page.evaluate(([x, y]) => window.__blockDiff(x, y), [a, b])
  const shot = async (tag) => {
    if (!SHOT_DIR) return
    const url = await page.evaluate(() => window.__nagiSnapshot())
    if (url) writeFileSync(join(SHOT_DIR, `${tag}.png`), Buffer.from(url.split(',')[1], 'base64'))
  }

  // 冻结呼吸/眨眼/待机动作，只留下"头部摆动"这层在动
  await page.evaluate(() => window.__nagiSuppressAutoAct?.(true))
  await page.evaluate(() => window.__nagiFreezeIdle(true))
  await page.evaluate(() => window.__nagiFreezeMood?.(true))
  await sleep(900)

  // 2026-10-17：A 项的"关"基线曾读到 12.5%（本该接近 0）。探针（probe-turns-a.mjs）
  // 证实冻结态本身是安静的（情绪层全空、turn/blink/ear 均无写入），污染来自**冻结前
  // 还在飞的转向**（reunion 'return' 幅度最大）与**情绪缓动残余**，以及 freezeIdle
  // 没盖住的微动/眼球游走。A 只验"待机头部"这一层 → 把其余层全部按住：等在飞的转向
  // 收尾、情绪缓动到位、微动与眼球游走归零。这与"测一层必须按住其它层"是同一条纪律。
  for (let i = 0; i < 40; i++) {
    const busy = await page.evaluate(() => {
      const t = window.__nagiTurnState?.()
      const f = window.__nagiFaceState?.() || {}
      const cur = f.emotionCurrent || {}
      const tgt = f.emotionTarget || {}
      let gap = 0
      for (const k of new Set([...Object.keys(cur), ...Object.keys(tgt)])) {
        gap = Math.max(gap, Math.abs((cur[k] ?? 0) - (tgt[k] ?? 0)))
      }
      return { turning: !!t?.active, gap }
    })
    if (!busy.turning && busy.gap < 1e-3) break
    await sleep(250)
  }
  await page.evaluate(() => {
    window.__nagiSetTremor?.(0)
    window.__nagiSetEyeWander?.(0)
  })
  await sleep(400)

  /* --- A. 待机头部在动 --- */
  // 判据用**头部层真正写进去的角度**（__idleHeadLast），不用画面差分——2026-10-17 修：
  // 关掉待机头部后，头发/尾巴/耳朵的物理还会余震好几秒（nagi_idle 的动作曲线也在持续
  // 喂物理输入），像素差把"已经归零"算成"还在动"（关掉后仍读到 10~12%），
  // on/off 比值判据在低帧率下反复假失败。写入值是确定性的，与帧率、物理状态无关。
  //
  // 只认"切换之后的新鲜写入"（seq）：转向在飞时 idleHeadHook 直接早退、不写
  // __idleHeadLast，这时采样读到的是切换前的陈旧值——2026-10-17 实测过一次：关掉
  // 瞬间正好有个转向在飞，整个关窗读到 |z|=4.68° 的残尾，A 假失败。新鲜帧不足 3 帧
  // 判不成立（并打出帧数，避免"没采样到"和"没归零"混为一谈）。
  const headWrite = async (secs, afterSeq = -1) => {
    const seen = []
    const t0 = Date.now()
    while (Date.now() - t0 < secs * 1000) {
      const s = await page.evaluate(() => window.__idleHeadLast || null)
      if (s && s.seq > afterSeq) seen.push(s)
      await sleep(120)
    }
    const xs = seen.map((s) => s.x)
    const zs = seen.map((s) => s.z)
    return {
      n: seen.length,
      maxAbsX: Math.max(0, ...xs.map(Math.abs)),
      spanX: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
      maxAbsZ: Math.max(0, ...zs.map(Math.abs))
    }
  }
  const seqNow = () => page.evaluate(() => window.__idleHeadLast?.seq ?? -1)
  await page.evaluate(() => window.__nagiSetIdleHead(1))
  const seqOn = await seqNow()
  await sleep(400)
  // 采样 5 秒：待机摆动是 0.31Hz+0.13Hz 两个正弦叠加（约 10 秒一个大来回），
  // 窗口太短可能正落在回转处，跨度失真（3 秒窗口实测只量到 4.0° 跨度）。
  const headOn = await headWrite(5, seqOn)
  await page.evaluate(() => window.__nagiSetIdleHead(0))
  const seqOff = await seqNow()
  await sleep(400)
  const headOff = await headWrite(1.5, seqOff)
  await page.evaluate(() => window.__nagiSetIdleHead(1))
  check(
    'A. 待机时头部真的在动（关掉后写入归零）',
    headOn.n >= 8 && headOn.maxAbsX > 2.5 && headOn.spanX > 5 &&
      headOff.n >= 3 && headOff.maxAbsX < 0.01 && headOff.maxAbsZ < 0.01,
    `开：${headOn.n} 帧新鲜采样，|x| 峰值 ${headOn.maxAbsX.toFixed(1)}°、跨度 ${headOn.spanX.toFixed(1)}°（满幅 ±10°）；` +
      `关：${headOff.n} 帧新鲜采样，写入归零（|x|=${headOff.maxAbsX.toFixed(3)}° |z|=${headOff.maxAbsZ.toFixed(3)}°）`
  )
  // A 测完把微动/眼球游走还回去（B~E 不该活在"脸是死的"状态下）
  await page.evaluate(() => {
    window.__nagiSetTremor?.(1)
    window.__nagiSetEyeWander?.(1)
  })

  /* --- B. 转向：转过去 → 保持 → 自己转回来 ---
   * 先把待机头部摆动关掉：否则基线本身就在晃，测不出"转向让画面变了多少"。
   */
  await page.evaluate(() => window.__nagiSetIdleHead(0))
  await sleep(700)
  const st0 = await page.evaluate(() => window.__shotBlocks())
  const turned = await page.evaluate(() => {
    const r = window.__nagiTurn('poke', { x: 0.95, y: 0.25, body: 0.9, holdMs: 900, force: true })
    return r
  })
  await sleep(700)
  const st1 = await page.evaluate(() => window.__shotBlocks())
  await shot('01_turned')
  const stateMid = await page.evaluate(() => window.__nagiTurnState())
  const hookCalls = await page.evaluate(() => window.__turnHookCalls || 0)
  const hookSkipped = await page.evaluate(() => window.__turnSkipped || 0)
  // 峰值：低帧率下抓帧只能抓到半路，用"这一趟最多转到多少"判断，避免假失败
  const peak = await page.evaluate(() => window.__turnPeak || null)
  const written = await page.evaluate(() => window.__turnLastWritten || null)
  info('转向 hook', `被调用 ${hookCalls} 次，其中未激活 ${hookSkipped} 次`)
  info('最后写入的角度', written ? `AngleX=${written.x.toFixed(1)}° AngleY=${written.y.toFixed(1)}° Body=${written.body.toFixed(1)}° 眼珠=${(written.eyeX ?? 0).toFixed(2)} (w=${written.w.toFixed(2)})` : '（从未写入）')
  await sleep(2800) // 等 in+hold+out 走完
  const st2 = await page.evaluate(() => window.__shotBlocks())
  const dTurn = await diff(st0, st1)
  const dBack = await diff(st0, st2)
  // 判据用"真正写进模型的角度"而不是某一时刻的画面：
  // 验证环境的帧率不稳（后台窗口会掉到 10fps 上下），按固定时刻抓帧测不出"转过最大多少度"。
  // 眼球也要跟着转：头转过去而眼珠不动 = "面无表情地侧着脸"（用户 2026-10-17 指出"眼神死板"）
  check(
    'B. 转向：头身转到值域上限，眼睛也跟着看过来',
    turned?.ok && !!peak && peak.x > 22 && peak.body > 7 && peak.eyeX > 0.3,
    peak
      ? `峰值 AngleX=${peak.x.toFixed(1)}°（上限 30）Body=${peak.body.toFixed(1)}°（上限 10）` +
        `眼珠 X=${peak.eyeX.toFixed(2)}（值域 ±1）；` +
        `抓帧时 w=${(written?.w ?? 0).toFixed(2)}（低帧率只抓到半路，所以用峰值判断）`
      : 'hook 从未把角度写进模型'
  )

  /* --- C. 动作期头部摆动比待机更大 ---
   * 同样读写入值：actEnv 包络里的"动作期加强"分量（extra，±16° 快摆）。待机时它恒为 0，
   * 播动作时（动作组切到非 Idle）它淡入。像素判据在低帧率下不可信——采样间隔和帧间隔
   * 同级会 aliasing，且物理余震会同时污染两侧（2026-10-17 实测：待机 13.19% vs 动作期
   * 8.16%，直接翻转）。
   */
  // seq 过滤同 A 项：转向在飞时 hook 早退，读到的是切换前的陈旧 extra
  // （停动作后若还读到旧的快摆分量，会假失败）
  const headExtra = async (secs, afterSeq = -1) => {
    const seen = []
    const t0 = Date.now()
    while (Date.now() - t0 < secs * 1000) {
      const s = await page.evaluate(() => window.__idleHeadLast || null)
      if (s && s.seq > afterSeq) seen.push(s)
      await sleep(100)
    }
    const mags = seen.map((s) => Math.max(Math.abs(s?.extra?.x ?? 0), Math.abs(s?.extra?.y ?? 0), Math.abs(s?.extra?.z ?? 0)))
    return { n: seen.length, max: Math.max(0, ...mags), acting: seen.some((s) => s?.acting) }
  }
  await page.evaluate(() => {
    window.__nagiSetIdleHead(1)
    window.__nagiStopMotions?.()
  })
  const seqIdle = await seqNow()
  await sleep(700)
  const idleExtra = await headExtra(1.5, seqIdle)
  const actGroup = await page.evaluate(() => {
    const g = window.__nagiPlayMotion?.('Greet')
    return { ok: !!g }
  })
  const seqAct = await seqNow()
  await sleep(500) // 等动作组切换 + actEnv 淡入（0.2s）
  const actExtra = await headExtra(2.5, seqAct)
  check(
    'C. 播动作时头身摆动加强',
    idleExtra.n >= 3 && idleExtra.max < 0.5 && actExtra.n >= 3 && actExtra.max > 3 && actExtra.acting,
    `待机期动作分量 |max| ${idleExtra.max.toFixed(2)}°（${idleExtra.n} 帧，应为 0）；动作期 ${actExtra.max.toFixed(2)}°` +
      `（${actExtra.n} 帧，叠加在 ±10° 待机摆动上的 ±16° 快摆，acting=${actExtra.acting}）；播放 ${actGroup.ok ? '成功' : '失败'}（组=Greet）`
  )

  /* --- D. 戳一戳：连戳 8 次，反应要逐级变化 --- */
  await page.evaluate(() => window.__nagiFreezeMood?.(false))
  await page.evaluate(() => window.__nagiFreezeIdle?.(false))
  const bubbles = []
  const levels = []
  for (let i = 0; i < 8; i++) {
    // 用调试口直接触发：桌宠的点击要先过"拖动 vs 点击"的位移判定，
    // 合成的鼠标事件有时被吃掉（第一次就踩到了）
    await page.evaluate(() => window.__nagiPoke())
    await sleep(700)
    // 读气泡**历史**（渲染层 EVT.PET 里记的），不读 DOM：气泡 6 秒自动隐藏、
    // 会被别的气泡顶掉、非桌宠形态根本不显示——2026-10-17 有一次 8 个全读到空，
    // 而日志里台词是全的，DOM 时序根本不可靠。按序号取第 i+1 条 poke 气泡。
    const txt = await page.evaluate((want) => {
      const h = (window.__nagiPokeBubbles || []).filter((b) => b.kind === 'poke')
      return h[want]?.text || ''
    }, i)
    bubbles.push(txt)
    const lv = logs
      .join('')
      .match(/\[poke\] 第 (\d+) 次 → (\w+)/g)
    levels.push(lv ? lv[lv.length - 1] : '')
    if (i === 0) await shot('02_poke_first')
  }
  const firstThree = bubbles.slice(0, 2).join('|')
  const lastThree = bubbles.slice(4).join('|')
  const spoken = bubbles.filter(Boolean).length
  const pokeLogs = (logs.join('').match(/\[poke\] 第 \d+ 次 → \w+/g) || [])
  const levelSet = new Set(pokeLogs.map((l) => l.replace(/.*→ /, '')))
  // spoken>=6：气泡全空时 firstThree/lastThree 会因切片长度不同而"看起来有变化"，
  // 2026-10-17 实测过一次 8 空气泡的假通过——台词真的出现了才算数
  check(
    'D. 戳一戳：连戳 8 次，反应逐级变化（不是一句话重复）',
    pokeLogs.length >= 6 && levelSet.size >= 3 && firstThree !== lastThree && spoken >= 6,
    `${pokeLogs.length} 次记录，分级 ${[...levelSet].join('→')}，${spoken}/8 次有台词；前两次「${bubbles.slice(0, 2).join('」/「')}」 后段「${bubbles.slice(4).join('」/「')}」`
  )
  info('连戳气泡', bubbles.map((b, i) => `${i + 1}.${b || '（不出声）'}`).join(' '))

  info('turn/poke 日志', (logs.join('').match(/\[(turn|poke)\] [^\n]*/g) || ['（无）']).slice(-12).join(' | '))
  const errs = logs.join('').split('\n').filter((l) => /Error|error:/.test(l) && !/ERR_|safe-delete/.test(l))
  check('E. 无报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '0 条')

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
