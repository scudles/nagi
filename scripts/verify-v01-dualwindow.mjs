// scripts/verify-v01-dualwindow.mjs
// V01 双窗语音实测（任务书《凪_Nagi_完善任务书》V01：唯一播放者仲裁缺失）。
//
// 实测命题：一次广播（AGENT DONE / PET proactive）发出后，桌宠窗与工作台窗是否都触发 speak。
// 场景：NAGI_MODE=workbench 启动 → 工作台窗可见（在这里发消息），桌宠窗隐藏但仍存活，
// 即「切到工作台继续对话，桌宠窗跟着念」的真实风险场景。
//
// 实锤判据（硬证据，不依赖音频播出）：
//   一次广播若触发双窗 speak，主进程会为每次 speak IPC 创建独立 sessionId，
//   两窗观测到的 sessionId 集合不同且均有值 = 两次独立合成 = 无唯一播放者仲裁。
//
// 前置：隔离 profile 的 settings.json 需将 voice.ttsEngine 设为 'sapi'（edge-tts 依赖外网）。
// 注意：本机 ~/.local/bin/env 是有问题的 PATH shim，`env -u` 会被它吞掉——
// 用 /usr/bin/env，或子 shell：(unset ELECTRON_RUN_AS_NODE; ...)。
// 用法：
//   /usr/bin/env -u ELECTRON_RUN_AS_NODE NAGI_FAKE_LLM=1 NAGI_MODE=workbench \
//     node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 --user-data-dir=<隔离目录>
//   CDP_PORT=9333 node scripts/verify-v01-dualwindow.mjs
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT || 9333)
const SETTLE_MS = 8000
const TOTAL_TIMEOUT = 120000

async function waitEndpoint(ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

if (!(await waitEndpoint())) {
  console.log('✘ CDP 未就绪（应用没起来？端口 ' + PORT + '）')
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const pages = ctx.pages()
const pet = pages.find((p) => p.url().includes('mode=pet'))
const wb = pages.find((p) => p.url().includes('mode=workbench'))
check('双窗并存（pet + workbench 页面都存在）', !!pet && !!wb, `pet=${!!pet} wb=${!!wb}`)
if (!pet || !wb) {
  console.log('✘ 双窗不齐，无法实测 V01')
  process.exit(1)
}

// reload 诊断：记录每次页面导航
const navLog = []
for (const [name, p] of [['pet', pet], ['wb', wb]]) {
  p.on('framenavigated', (f) => navLog.push({ win: name, t: Date.now(), url: String(f.url()).slice(-60) }))
}

// 页面内持续观测器：积分 + 会话集合（防重复）
async function watch(page) {
  await page.evaluate(() => {
    if (window.__v01Watch) return
    window.__v01Watch = {
      installedAt: Date.now(),
      agentDone: 0,
      petEvents: 0,
      stateSeen: 0,
      speakingSeen: 0,
      sessions: new Set()
    }
    try {
      window.nagi.on('agent:event', (evt) => {
        if (evt && evt.type === 'done') window.__v01Watch.agentDone++
      })
      window.nagi.on('pet:event', (evt) => {
        if (evt && evt.text) window.__v01Watch.petEvents++
      })
    } catch (e) {
      window.__v01Watch.onError = String(e && e.message)
    }
    setInterval(() => {
      try {
        const s = window.__nagiVoice.state()
        if (s) {
          window.__v01Watch.stateSeen++
          window.__v01Watch.sessions.add(String(s.sessionId))
        }
        if (window.__nagiVoice.isSpeaking()) window.__v01Watch.speakingSeen++
      } catch {
        /* ignore */
      }
    }, 100)
  })
}
await watch(pet)
await watch(wb)

const readWatch = (page) =>
  page.evaluate(() => {
    const w = window.__v01Watch
    if (!w) return null
    return { installedAt: w.installedAt, agentDone: w.agentDone, petEvents: w.petEvents, stateSeen: w.stateSeen, speakingSeen: w.speakingSeen, sessions: [...w.sessions] }
  })

// 基线：发送消息前两窗状态（区分启动期 proactive 与后续 DONE）
await new Promise((r) => setTimeout(r, 5000))
const base = { pet: await readWatch(pet), wb: await readWatch(wb) }
console.log('基线（发送前）：', JSON.stringify(base))
console.log('导航记录（至今）：', JSON.stringify(navLog))

// 确定性前置：显式切到工作台形态（不依赖 NAGI_MODE 是否穿透启动环境）。
// 已是工作台形态时 switchMode 是幂等的；从桌宠形态切入正是真实用户路径。
console.log('\n--- 切换到工作台形态（pet 窗点「打开工作台」）---')
try {
  await pet.click('#btn-open-workbench', { timeout: 5000 })
} catch {
  await pet.$eval('#btn-open-workbench', (el) => el.click())
}
await new Promise((r) => setTimeout(r, 2000))

// 在工作台窗发一条消息（fake LLM：两轮对话，第二轮产生带文本的 DONE）
console.log('\n--- 在工作台窗发送消息（NAGI_FAKE_LLM 链路）---')
await wb.fill('#input', '帮我看看文档目录里有什么')
// 点击韧性：Playwright 的 click 带 actionability 检查（含「帧稳定」），
// 若页面渲染循环停滞（无 GPU 沙箱 / WebGL 循环卡住），click 会干等超时——
// 此时退回 JS 派发点击：验证的是消息链路，不是像素。
try {
  await wb.click('#btn-send', { timeout: 8000 })
} catch {
  console.log('  （click actionability 超时，改用 JS 派发点击）')
  await wb.$eval('#btn-send', (el) => el.click())
}

const t0 = Date.now()
let lastTotal = -1
let lastChange = Date.now()
let snap = { pet: null, wb: null }
const timeline = []
while (Date.now() - t0 < TOTAL_TIMEOUT) {
  let p, w
  try {
    ;[p, w] = await Promise.all([readWatch(pet), readWatch(wb)])
  } catch (err) {
    console.log('  读取异常：', err.message)
    await new Promise((r) => setTimeout(r, 500))
    continue
  }
  snap = { pet: p, wb: w }
  const total = (p?.stateSeen || 0) + (w?.stateSeen || 0)
  if (total !== lastTotal) {
    lastTotal = total
    lastChange = Date.now()
    const line = `  t+${((Date.now() - t0) / 1000).toFixed(1)}s  pet: state=${p?.stateSeen} sessions=${JSON.stringify(p?.sessions)} | wb: state=${w?.stateSeen} sessions=${JSON.stringify(w?.sessions)} (DONE: pet=${p?.agentDone} wb=${w?.agentDone}, PET: pet=${p?.petEvents} wb=${w?.petEvents})`
    console.log(line)
    timeline.push(line)
  }
  if ((p?.agentDone > 0 || w?.agentDone > 0) && Date.now() - lastChange > SETTLE_MS) break
  await new Promise((r) => setTimeout(r, 500))
}

console.log('\n--- 实测结果 ---')
console.log('pet ：', JSON.stringify(snap.pet))
console.log('wb  ：', JSON.stringify(snap.wb))
console.log('导航记录：', JSON.stringify(navLog))

// 判定：以「发送后新增的朗读会话」为准（扣除基线）
const baseSessions = new Set([...(base.pet?.sessions || []), ...(base.wb?.sessions || [])])
const petSessions = (snap.pet?.sessions || []).filter((s) => !baseSessions.has(s))
const wbSessions = (snap.wb?.sessions || []).filter((s) => !baseSessions.has(s))
const petSpoke = petSessions.length > 0
const wbSpoke = wbSessions.length > 0

check('工作台窗（发起窗）产生新朗读会话', wbSpoke, wbSessions.join(','))
check('桌宠窗（隐藏窗）未产生新朗读会话（唯一播放者）', !petSpoke, petSessions.join(','))

const v01Confirmed = petSpoke && wbSpoke // 修复前：双窗各自合成
const v01Fixed = wbSpoke && !petSpoke // 修复后：仅归属窗朗读
console.log('\n==== V01 判定：' + (v01Confirmed
  ? '问题实锤 —— 双窗各自独立合成（sessionId 不同），无唯一播放者仲裁'
  : v01Fixed
    ? '已修复 —— 仅归属窗（工作台）朗读，隐藏的桌宠窗未合成（唯一播放者仲裁生效）'
    : !wbSpoke && !petSpoke
      ? '发送后双窗均无新朗读（DONE 未触发或开关关闭），需进一步排查'
      : '异常：仅桌宠窗朗读而工作台窗未读，归属判定反了') + ' ====')

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const outDir = join(process.cwd(), 'docs', 'verify')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, `v01-dualwindow-${stamp}.json`),
  JSON.stringify({ at: new Date().toISOString(), scenario: 'NAGI_MODE=workbench；工作台发起对话；桌宠隐藏；TTS=sapi', base, final: snap, navLog, timeline, petSessions, wbSessions, v01Confirmed, v01Fixed, results }, null, 2),
  'utf8'
)
console.log('报告已存 docs/verify/v01-dualwindow-' + stamp + '.json')
process.exit(v01Confirmed ? 2 : v01Fixed ? 0 : 1)
