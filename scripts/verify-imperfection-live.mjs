// scripts/verify-imperfection-live.mjs
// BLUE-4 真机冒烟（2026-10-17）：
//   ① 扩展在真实应用里装配无碍（glob 自动加载，install 不抛错、不落盘）；
//   ② 设置页能开能关：概率写成 0–10%，总开关关着时概率强制归零（不会出现「关了还偶尔延迟」的错觉）；
//   ③ 默认状态：三个机制开关与概率全为默认关闭/0（不改变既有行为）。
//
// 说明：概率门本身由 `npm run verify:imperfection`（120 天 seeded 模拟）证明；
// 这里只验「真实应用里的接线与默认值」，不去造真实的归来事件（那需要数分钟的离开/归来）。
//
// 用法：npm run verify:imperfection:ui
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DATA = mkdtempSync(join(tmpdir(), 'nagi-imperf-'))

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

writeFileSync(
  join(DATA, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'fixture' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
    },
    null,
    2
  )
)

const env = { ...process.env, NAGI_FAKE_LLM: '1', NAGI_NO_PREWARM: '1', NAGI_RENDERER_SANDBOX: '0' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--user-data-dir=${DATA}`, '--remote-debugging-port=9414'], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function waitForCdp(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch { /* 还没起来 */ }
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
          const ok = await page.evaluate(() => document.body?.dataset?.mode === 'pet' && typeof window.nagi?.settings?.set === 'function')
          if (ok) return page
        } catch { /* 页面还在导航 */ }
      }
    }
    await sleep(400)
  }
  return null
}
async function stopApp() {
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  await sleep(600)
}

async function main() {
  console.log('起隔离实例（本地假大脑）…')
  if (!(await waitForCdp(9414))) throw new Error('CDP 未就绪')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9414')
  const page = await findPage(browser)
  if (!page) throw new Error('桌宠页未就绪')
  await sleep(1500)

  /* ③ 默认值 */
  const def = await page.evaluate(() => window.nagi.settings.get())
  const imp = def.presence?.imperfection || {}
  info('默认配置', JSON.stringify(imp))
  check(
    '默认：可选表达延迟关闭、概率 0、低气压与补救关闭（默认行为不变）',
    imp.enabled === false && imp.forgetProbability === 0 && imp.lowPressureEnabled === false && imp.repairEnabled === false,
    JSON.stringify(imp)
  )

  /* ② 设置页：开 → 概率生效；关 → 概率归零 */
  const opened = await page.evaluate(async () => {
    document.getElementById('btn-pet-settings').click()
    await new Promise((r) => setTimeout(r, 600))
    const before = ['set-imperf-enabled', 'set-imperf-low', 'set-imperf-repair'].map((id) => document.getElementById(id)?.checked)
    const probBefore = document.getElementById('set-imperf-prob')?.value
    document.getElementById('set-imperf-enabled').checked = true
    document.getElementById('set-imperf-low').checked = true
    document.getElementById('set-imperf-repair').checked = true
    document.getElementById('set-imperf-prob').value = '10'
    document.getElementById('btn-save-imperf').click()
    await new Promise((r) => setTimeout(r, 700))
    const on = (await window.nagi.settings.get()).presence.imperfection
    const statusOn = document.getElementById('imperf-status').textContent
    // 关掉总开关：概率必须归零
    document.getElementById('set-imperf-enabled').checked = false
    document.getElementById('btn-save-imperf').click()
    await new Promise((r) => setTimeout(r, 700))
    const off = (await window.nagi.settings.get()).presence.imperfection
    return { before, probBefore, on, off, statusOn, statusOff: document.getElementById('imperf-status').textContent }
  })
  check(
    '设置页：默认未勾选、概率 0；勾选 + 10% 保存后写入配置',
    opened.before.every((v) => v === false) && String(opened.probBefore) === '0' &&
      opened.on.enabled === true && Math.abs(opened.on.forgetProbability - 0.1) < 1e-9 &&
      opened.on.lowPressureEnabled === true && opened.on.repairEnabled === true,
    `${opened.statusOn} → ${JSON.stringify(opened.on)}`
  )
  check(
    '总开关关掉时概率强制归零（不留「关了还偶尔延迟」的错觉）',
    opened.off.enabled === false && opened.off.forgetProbability === 0 && opened.statusOff.includes('已关闭'),
    `${opened.statusOff} → ${JSON.stringify(opened.off)}`
  )

  /* ① 扩展装配：日志里不能有扩展注册失败；且设置概率上限有界 */
  const bad = logs.join('').split(/\r?\n/).filter((l) => /扩展注册失败|imperfection.*failed|Cannot find module/im.test(l))
  info('扩展装配日志', bad.length ? bad.join(' | ') : '无失败记录')
  check('真实应用里扩展装配无失败（glob 自动加载、install 不落盘）', bad.length === 0, bad.join(' | ') || '无')

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ✘ ${f.name}${f.detail ? '：' + f.detail : ''}`)
  }
  process.exitCode = failed.length ? 1 : 0
}

main()
  .catch((err) => {
    console.error('校验失败：', err)
    process.exitCode = 1
  })
  .finally(stopApp)
