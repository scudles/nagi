// scripts/verify-reminder-delivery.mjs
// B1（S1-03）真机验收：重要提醒的「确定性送达」。
//
// 为什么需要它（2026-10-18）：
//   红区把提醒从「LLM 措辞」里拆了出来，单测（reminder-delivery / reminder-recovery）已证明
//   去重与重试逻辑。但这些单测是**注入假 present/notify** 跑的——
//   "在真实 Electron 里、没有模型、窗口还藏着的时候，提醒到底有没有真的发出去"没人验过。
//   PENDING-CODEX.md 里这条明确写着「Windows 真机通知展示仍需 WorkBuddy 验收」。
//
// 做法：用临时 user-data-dir 起真实 Electron（不配 API key = 占位大脑，等同断网/无模型），
//   把提醒检查间隔调到 1.2 秒，然后：
//     A 无模型时到点仍送达，且正文逐字是用户原文
//     B 两条同一时刻到期：都送达、各自一次
//     C 重复 tick 不会把同一次发生弹两遍
//     D 送达记账（firedAt）
//     E 系统通知通道真的走过（承诺簿 evidence=notification-dispatched）
//     F 窗口全部隐藏时仍记为送达（气泡发不出去，但通知照发）
//
// 用法：node scripts/verify-reminder-delivery.mjs
// 注意：**不要** browser.close()——connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9373'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log((pass ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

const profile = mkdtempSync(join(tmpdir(), 'nagi-reminder-'))
// 没有 API key = 走占位大脑，等价于「断网 / 无模型」。提醒不该因此消失。
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  llm: { provider: 'openai', model: 'gpt-4o-mini', baseURL: 'http://127.0.0.1:9/v1' },
  privacy: { monitorEnabled: false, noticeShown: true }
}, null, 2))

const env = {
  ...process.env,
  NAGI_RENDERER_SANDBOX: '0', // 受限环境必需，否则 GPU 崩溃、桌宠页 ready 不了
  NAGI_SELFTEST_REMINDER: '1', // 检查间隔 1.2s（否则默认 20s，验收会慢到没法用）
  NAGI_SELFTEST_REMINDER_SEED: '0' // 不塞种子提醒，免得干扰计数
}
delete env.ELECTRON_RUN_AS_NODE

console.log('启动真实实例（临时 profile）…')
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false
})
let logs = ''
child.stdout.on('data', (d) => { logs += String(d) })
child.stderr.on('data', (d) => { logs += String(d) })

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          // 只有注入了 preload 的页面才有 window.nagi
          const ok = await page.evaluate(() => typeof window.nagi?.reminders?.add === 'function').catch(() => false)
          if (ok) return { browser, page }
        }
      }
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  throw new Error('连不上渲染进程（CDP 未就绪）')
}

const { browser, page } = await connect()
console.log('已连上渲染进程：' + page.url())

// 收集桌宠气泡（PET 事件）里的提醒正文
await page.evaluate(() => {
  window.__reminderSeen = []
  window.nagi.on('pet:event', (e) => {
    if (e && e.kind === 'reminder') window.__reminderSeen.push({ text: e.text, at: Date.now() })
  })
})

const addReminder = (text, inMs) => page.evaluate(
  ({ text, at }) => window.nagi.reminders.add({ text, at }),
  { text, at: Date.now() + inMs }
)

// ---- A：无模型时到点仍送达，且是原文 ----
const A = 'A · 三点开会（原文，不许改写）'
const aRes = await addReminder(A, 3000)
check('A0 提醒创建成功', !!aRes?.ok, aRes?.ok ? '' : JSON.stringify(aRes?.error))
await sleep(7000)
const seenA = await page.evaluate(() => window.__reminderSeen)
check('A1 无模型/断网时到点仍送达', seenA.some((x) => x.text === A), seenA.map((x) => x.text).join(' | ') || '（没有气泡）')
check('A2 正文逐字一致（未被模型改写）', seenA.filter((x) => x.text === A).length === 1)

// ---- B：两条同一时刻到期 ----
const B1 = 'B1 · 交房租'
const B2 = 'B2 · 给妈妈回电话'
const t = 3000
await addReminder(B1, t)
await addReminder(B2, t)
await sleep(8000)
const seenB = await page.evaluate(() => window.__reminderSeen)
const gotB1 = seenB.filter((x) => x.text === B1).length
const gotB2 = seenB.filter((x) => x.text === B2).length
check('B3 两条同时到期都送达', gotB1 === 1 && gotB2 === 1, `${B1}×${gotB1} ${B2}×${gotB2}`)

// ---- C：重复 tick 不重复弹（同一次发生只一次）----
await sleep(4000)
const seenC = await page.evaluate(() => window.__reminderSeen)
check('C4 同一次发生不重复弹（跨多个 tick）',
  seenC.filter((x) => x.text === A).length === 1 && seenC.filter((x) => x.text === B1).length === 1,
  `A×${seenC.filter((x) => x.text === A).length} B1×${seenC.filter((x) => x.text === B1).length}`)

// ---- D：送达记账 ----
const list = await page.evaluate(() => window.nagi.reminders.list())
const items = Array.isArray(list) ? list : (list?.items || [])
const itemA = items.find((x) => x.text === A)
check('D5 送达后在 store 里记了 firedAt', !!itemA?.firedAt, itemA ? `firedAt=${itemA.firedAt}` : '没找到这条提醒')

// ---- E：系统通知通道真的走过 ----
// evidence 只在 notify() 返回 true（即 new Notification().show() 成功执行）时才写，
// 这条是"Windows 接受并展示了这次通知"的应用侧证据；是否真的在屏幕上被看到仍需人眼。
const promises = await page.evaluate(() => window.nagi.promises.list())
const pItems = promises?.items || []
const pA = pItems.find((p) => String(p.id) === `reminder:${itemA?.id}`)
const dispatched = (pA?.evidence || []).filter((e) => e.kind === 'notification-dispatched')
check('E6 系统通知已派发（notification-dispatched 有记录）', dispatched.length >= 1,
  pA ? `evidence=${(pA.evidence || []).map((e) => e.kind).join(',')}` : '没找到承诺簿条目')

// ---- F：窗口全部隐藏时仍记送达 ----
// 她有两个窗（桌宠 + 工作台）：只隐藏其中一个，另一个仍然可见，气泡照发——
// 第一版脚本就是这么误判的（2026-10-18 自坑，F7 假失败）。要验"没有可见窗口"必须全隐。
const allPages = []
for (const ctx of browser.contexts()) allPages.push(...ctx.pages())
for (const p of allPages) {
  await p.evaluate(() => window.nagi?.win?.hide?.()).catch(() => {})
}
await sleep(1200)
const F = 'F · 隐藏窗也要提醒'
const beforeF = (await page.evaluate(() => window.__reminderSeen)).length
const fRes = await addReminder(F, 2500)
check('F0 隐藏状态下仍能创建提醒', !!fRes?.ok, fRes?.ok ? '' : JSON.stringify(fRes?.error))
await sleep(6000)
const afterF = await page.evaluate(() => window.__reminderSeen)
const listF = await page.evaluate(() => window.nagi.reminders.list())
const itemsF = Array.isArray(listF) ? listF : (listF?.items || [])
const itemF = itemsF.find((x) => x.text === F)
check('F7 隐藏窗时气泡不发（按设计）', afterF.length === beforeF, `气泡数 ${beforeF} → ${afterF.length}`)
check('F8 隐藏窗时仍记为送达（firedAt 有值）', !!itemF?.firedAt, itemF ? `firedAt=${itemF.firedAt}` : '没找到本条')

// ---- 汇总 ----
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map((r) => r.name).join('；'))
}
if (process.env.NAGI_SHOW_LOG === '1') {
  console.log('\n--- 主进程日志 ---\n' + logs.split('\n').filter((l) => l.includes('reminder')).join('\n'))
}

// 只杀自己起的子进程（这个 profile 是临时目录，属于本脚本）
try { child.kill() } catch { /* 已经退出 */ }
process.exit(failed.length ? 1 : 0)
