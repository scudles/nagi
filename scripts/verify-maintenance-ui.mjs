// scripts/verify-maintenance-ui.mjs
// B8-HEALTH-01（device 层）：设置页的「维护状态」真的能通过 IPC 拿到主进程健康快照。
//
// 为什么要真机：单测只能证明 health() 与 HTML 各自存在；
// "preload 暴露 → IPC 注册 → 渲染层渲染"这三跳断了，单测照样全绿。
//
// 用法：node scripts/verify-maintenance-ui.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9379'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

const profile = mkdtempSync(join(tmpdir(), 'nagi-maint-ui-'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  mode: 'workbench',
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false },
  presence: { enabled: false }
}))

const env = { ...process.env, NAGI_RENDERER_SANDBOX: '0', NAGI_MODE: 'workbench' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
let logs = ''
child.stdout.on('data', (d) => { logs += String(d) })
child.stderr.on('data', (d) => { logs += String(d) })

let page = null
for (let i = 0; i < 90 && !page; i++) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (await p.evaluate(() => typeof window.nagi?.maintenance?.health === 'function').catch(() => false)) { page = p; break }
      }
      if (page) break
    }
  } catch { /* 还没起来 */ }
  if (!page) await sleep(400)
}
if (!page) { console.log('连不上渲染进程'); try { child.kill() } catch {} ; process.exit(1) }
console.log('page=' + page.url())

// ① preload 暴露
const api = await page.evaluate(() => ({
  health: typeof window.nagi.maintenance.health,
  clear: typeof window.nagi.maintenance.clear
}))
check('A1 preload 暴露 maintenance.health/clear', api.health === 'function' && api.clear === 'function', JSON.stringify(api))

// ② IPC 往返（真调一次）
const health = await page.evaluate(() => window.nagi.maintenance.health())
check('A2 IPC 返回健康快照', health && typeof health.healthy === 'boolean' && Array.isArray(health.sites),
  'healthy=' + health?.healthy + ' sites=' + (health?.sites?.length ?? 'n/a'))
check('A3 快照里带轨迹字段', Array.isArray(health?.trace), 'trace=' + (health?.trace?.length ?? 'n/a'))

// ③ 设置页真的渲染出这块状态
// 走真实入口：设置按钮（工作台是 #btn-open-settings，桌宠是 #btn-pet-settings）。
// 直接去掉 hidden 会绕过 openSettings() 里的刷新，把"没刷新"误判成"没实现"。
const opened = await page.evaluate(() => {
  const btn = document.getElementById('btn-open-settings') || document.getElementById('btn-pet-settings')
  if (!btn) return false
  btn.click()
  return true
})
check('B0 设置入口可点开', opened)
await sleep(600)
await page.evaluate(() => document.querySelector('.sp-nav-item[data-group="connect"]')?.click())
await sleep(1200)
const ui = await page.evaluate(() => {
  const box = document.getElementById('maint-status')
  const group = document.querySelector('.sp-group[data-group="connect"]')
  return { text: box?.textContent || '', hiddenGroup: group?.classList.contains('hidden') ?? null }
})
check('B1 设置页有维护状态区块', !!ui.text && ui.text !== '正在读取…', ui.text.slice(0, 40))
check('B2 默认显示"正常"（没有失败点）', /一切正常/.test(ui.text) || /出过问题/.test(ui.text), ui.text.slice(0, 60))

// ④ 清空是可删操作
const cleared = await page.evaluate(() => window.nagi.maintenance.clear())
check('C1 清空返回成功', cleared?.ok === true, JSON.stringify(cleared))

// ---- D：作者裁决 B —— 设置页显示「监测于 <时间> 授权」 ----
// 走设置保存的真实通道改隐私设置，再由主进程打戳/清零，最后重开设置面板读那一行。
async function reopenSettings() {
  await page.evaluate(() => document.getElementById('btn-close-settings')?.click())
  await sleep(300)
  await page.evaluate(() => (document.getElementById('btn-open-settings') || document.getElementById('btn-pet-settings'))?.click())
  await sleep(700)
}
const readAt = () => page.evaluate(() => {
  const el = document.getElementById('monitor-authorized-at')
  return { hidden: el?.hidden ?? null, text: el?.textContent || '' }
})

const d0 = await readAt()
check('D1 未授权时不显示授权行', d0.hidden === true && d0.text === '', JSON.stringify(d0))

await page.evaluate(() => window.nagi.settings.set({ privacy: { monitorEnabled: true } }))
await sleep(500)
const stamp = await page.evaluate(async () => (await window.nagi.settings.get())?.privacy?.monitorAuthorizedAt)
check('D2 开启监测后主进程打了授权戳', Number(stamp) > 0, 'monitorAuthorizedAt=' + stamp)

await reopenSettings()
const d1 = await readAt()
check('D3 授权行显示出来且格式为「监测于 … 授权」', d1.hidden === false && /^监测于 .+ 授权$/.test(d1.text), d1.text)

await page.evaluate(() => window.nagi.settings.set({ privacy: { monitorEnabled: false } }))
await sleep(500)
const stampOff = await page.evaluate(async () => (await window.nagi.settings.get())?.privacy?.monitorAuthorizedAt)
check('D4 关掉监测后授权戳清零', Number(stampOff) === 0, 'monitorAuthorizedAt=' + stampOff)
await reopenSettings()
const d2 = await readAt()
check('D5 关掉后授权行重新隐藏', d2.hidden === true && d2.text === '', JSON.stringify(d2))

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('\n--- 主进程日志（末 25 行）---')
  console.log(logs.split('\n').slice(-25).join('\n'))
}
try { child.kill() } catch { /* 已退出 */ }
process.exit(failed.length ? 1 : 0)
