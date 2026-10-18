// scripts/verify-c5-promise-ui.mjs
// C5-PROMISE-01 / 04（device 层）：遗忘经历后，界面必须真的把关联承诺的处理结果显示出来，
// 并且「一并取消」/「删除」走完整调用链（preload → IPC → main → 承诺簿/提醒本体）真的能点。
//
// 为什么必须真机：单测只能证明 PromiseBook 与 main/promises.js 各自正确；
// "preload 没暴露 / IPC 没注册 / renderer 没按钮"这三跳断了，单测照样全绿。
//
// 覆盖：
//   A preload 暴露 cancel-linked / remove
//   B 提醒行显示「关联的经历已遗忘，仍保留」
//   C 承诺簿显示关联状态（detached / unknown）与对应按钮
//   D 「一并取消」在**真实持久化失败**下不得假装成功（reminders.json 设只读 → renameSync EPERM），
//     承诺行保持不变、可重试
//   E 去掉只读后重试成功：正文与派生内容从界面消失，记录降级为最小履约记录
//   F 已结束记录走「删除」入口
//   G 关联未知（旧数据）只提示自行核对，不提供取消按钮以外的猜测行为
//
// 用法：node scripts/verify-c5-promise-ui.mjs
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9381'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

const SECRET = '蓝区验收私密承诺：周五替她交报告'
// 账本条目的 ID 是 sourceId(type,ref) 的哈希（core/ledger/store.js），
// 手写的 'exp-1' 会让 forget() 的 deleteBySource 重算后找不到条目 → "账本状态未写入"。
const ENTRY_ID = 'e_' + createHash('sha256').update('memory-manual:seed-1').digest('hex').slice(0, 20)
const profile = mkdtempSync(join(tmpdir(), 'nagi-c5-ui-'))
const remindersPath = join(profile, 'reminders.json')
const now = Date.now()

writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  mode: 'workbench',
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false },
  presence: { enabled: false }
}))
// 一条「关联经历已被遗忘、用户选择保留」的提醒（detached）
writeFileSync(remindersPath, JSON.stringify({ version: 1, items: [
  { id: 'seed-1', text: SECRET, at: now + 3600000, repeat: 'none', createdAt: now - 60000 }
] }))
// 承诺簿：detached（有来源 ID 且已脱钩）+ 一条 unknown（旧数据，无来源 ID）
writeFileSync(join(profile, 'promises.json'), JSON.stringify({ version: 1, entries: [
  { id: 'reminder:seed-1', kind: 'reminder', title: SECRET,
    source: { type: 'reminder', id: 'seed-1' }, sourceIds: [ENTRY_ID],
    dueAt: now + 3600000, status: 'scheduled', createdAt: now - 60000, updatedAt: now - 60000,
    detachedAt: now - 30000, evidence: [{ kind: 'notification-dispatched', at: now - 30000 }] },
  { id: 'p-legacy-1', kind: 'reminder', title: '较早的一条，没有来源信息',
    source: { type: 'legacy-reminder', id: 'old-1' }, sourceIds: [],
    dueAt: now + 7200000, status: 'scheduled', createdAt: now - 120000, updatedAt: now - 120000, evidence: [] }
] }))
// 账本：一条与 seed-1 提醒**同源**的经历，供「忘记」走真实链路
mkdirSync(join(profile, 'ledger'), { recursive: true })
writeFileSync(join(profile, 'ledger', 'entries.jsonl'), JSON.stringify({
  id: ENTRY_ID, category: 'experience', text: '蓝区验收经历：周五要替她交报告',
  source: { type: 'memory-manual', ref: 'seed-1' }, occurredAt: now - 90000, recordedAt: now - 90000,
  certainty: 'observed', ragIds: [], meta: {}, revision: 1, correctedAt: null, deletedAt: null
}) + '\n')

const env = { ...process.env, NAGI_RENDERER_SANDBOX: '0', NAGI_MODE: 'workbench',
  // 无头环境点不了原生确认框；该开关只在本脚本里显式设置（见 src/main/ipc/ledger.js 注释）
  NAGI_SELFTEST_AUTO_CONFIRM: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
let logs = ''
child.stdout.on('data', (d) => { logs += String(d) })
child.stderr.on('data', (d) => { logs += String(d) })

let page = null
// 必须认准**工作台**页面：应用会同时开桌宠窗与工作台窗，
// 而「她的日程」入口只在工作台侧栏里。选错窗口 = 所有点击打空、断言全假失败。
const isWorkbench = (p) => p.evaluate(() =>
  document.body?.dataset?.mode === 'workbench' && typeof window.nagi?.promises?.list === 'function'
).catch(() => false)
for (let i = 0; i < 120 && !page; i++) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (await isWorkbench(p)) { page = p; break }
      }
      if (page) break
    }
  } catch { /* 还没起来 */ }
  if (!page) await sleep(400)
}
if (!page) { console.log('连不上渲染进程\n' + logs.slice(-800)); try { child.kill() } catch {}; process.exit(1) }
console.log('page=' + page.url())

const setReadOnly = (on) => {
  try {
    execSync(`attrib ${on ? '+R' : '-R'} "${remindersPath}"`, { stdio: 'ignore' })
    return true
  } catch { return false }
}

try {
  // ---- A：preload 暴露 ----
  const api = await page.evaluate(() => ({
    list: typeof window.nagi.promises.list,
    cancelLinked: typeof window.nagi.promises.cancelLinked,
    remove: typeof window.nagi.promises.remove
  }))
  check('A1 preload 暴露 promises.cancelLinked / remove',
    api.cancelLinked === 'function' && api.remove === 'function', JSON.stringify(api))

  // ---- B/C：打开「她的日程」（真实按钮），读提醒行与承诺簿 ----
  await page.evaluate(() => document.getElementById('btn-open-reminder')?.click())
  await sleep(700)
  // 承诺簿在 <details> 里：展开它（不绕过 UI 直接改 class）
  await page.evaluate(() => {
    const d = document.querySelector('.promise-details')
    if (d && !d.open) d.querySelector('summary')?.click()
  })
  await sleep(500)

  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#reminder-list .rm-item')]
    const seeds = [...document.querySelectorAll('#promise-list .rm-item')]
    return {
      reminderHint: rows[0]?.querySelector('.rm-hint')?.textContent || '',
      detachedHint: seeds[0]?.querySelector('.rm-hint')?.textContent || '',
      unknownHint: seeds[1]?.querySelector('.rm-hint')?.textContent || '',
      detachedTitle: seeds[0]?.querySelector('.rm-text')?.textContent || '',
      detachedButtons: [...(seeds[0]?.querySelectorAll('button') || [])].map((b) => b.textContent),
      unknownButtons: [...(seeds[1]?.querySelectorAll('button') || [])].map((b) => b.textContent)
    }
  })
  check('B1 提醒行显示「关联的经历已遗忘，仍保留」', /关联的经历已遗忘/.test(before.reminderHint), before.reminderHint)
  check('C1 承诺簿显示 detached 关联提示', /关联的经历已遗忘/.test(before.detachedHint), before.detachedHint)
  check('C2 detached 行提供「一并取消」入口', before.detachedButtons.includes('一并取消'), before.detachedButtons.join(','))
  check('C3 关联未知只提示自行核对，且不冒用「一并取消」的说法',
    /没有来源信息/.test(before.unknownHint) && !before.unknownButtons.includes('一并取消') &&
    before.unknownButtons.includes('取消提醒'),
    before.unknownHint + ' | ' + before.unknownButtons.join(','))

  // ---- H：遗忘经历后的结果 note 必须真的显示给用户 ----
  // 走真实界面：设置 → 她的记忆 → 找到那条经历 → 点「忘记」→ 读面板级状态条。
  await page.evaluate(() => document.getElementById('btn-close-reminder')?.click())
  await sleep(300)
  await page.evaluate(() => document.getElementById('btn-open-settings')?.click())
  await sleep(700)
  await page.evaluate(() => document.querySelector('.sp-nav-item[data-group="memory"]')?.click())
  await sleep(1500)
  const h0 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ledger-list .ledger-item')]
    const target = rows.find((r) => (r.textContent || '').includes('周五要替她交报告'))
    if (!target) return { found: false, rows: rows.length }
    const btn = [...(target.querySelectorAll('button') || [])].find((b) => b.textContent === '忘记')
    btn?.click()
    return { found: true }
  })
  check('H1 账本里能找到带关联承诺的经历并点下「忘记」', h0.found === true, JSON.stringify(h0))
  await sleep(1500)
  const h1 = await page.evaluate(() => {
    const panel = document.getElementById('ledger-status')
    return { text: panel?.textContent || '', hasJump: !!panel?.querySelector('button') }
  })
  check('H2 结果 note 显示给用户：说明了保留了几个关联提醒',
    /关联着 1 个你单独设的提醒/.test(h1.text), h1.text.slice(0, 120))
  check('H3 note 里有去「她的日程」处理的入口', h1.hasJump === true, String(h1.hasJump))

  // ---- D：真实持久化失败下不得假装成功 ----
  // H 把界面切到了设置页，这里切回「她的日程」并重新展开承诺簿
  await page.evaluate(() => document.getElementById('btn-close-settings')?.click())
  await sleep(300)
  await page.evaluate(() => document.getElementById('btn-open-reminder')?.click())
  await sleep(600)
  await page.evaluate(() => {
    const d = document.querySelector('.promise-details')
    if (d && !d.open) d.querySelector('summary')?.click()
  })
  await sleep(500)
  check('D0 注入手法可用（reminders.json 设为只读）', setReadOnly(true))
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#promise-list .rm-item')][0]
    row?.querySelector('button')?.click()
  })
  await sleep(900)
  const failed = await page.evaluate(() => ({
    result: document.getElementById('promise-result')?.textContent || '',
    firstTitle: document.querySelector('#promise-list .rm-item .rm-text')?.textContent || '',
    firstButtons: [...(document.querySelector('#promise-list .rm-item')?.querySelectorAll('button') || [])].map((b) => b.textContent),
    promiseList: window.nagi.promises.list
  }))
  const listAfterFail = await page.evaluate(async () => (await window.nagi.promises.list()).items
    .find((p) => p.id === 'reminder:seed-1'))
  check('D1 取消失败时界面显示失败原因（不是"已取消"）',
    failed.result.length > 0 && !/已取消这条提醒/.test(failed.result), failed.result)
  check('D2 失败后承诺状态与正文都没被改（仍可管理、可重试）',
    listAfterFail?.status === 'scheduled' && listAfterFail?.title === SECRET &&
    failed.firstTitle === SECRET && failed.firstButtons.includes('一并取消'),
    `status=${listAfterFail?.status} buttons=${failed.firstButtons.join(',')}`)

  // ---- E：恢复后重试成功 ----
  check('E0 解除只读注入', setReadOnly(false))
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#promise-list .rm-item')][0]
    row?.querySelector('button')?.click()
  })
  await sleep(900)
  const done = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('#promise-list .rm-item')]
    const first = rows[0]
    const item = (await window.nagi.promises.list()).items.find((p) => p.id === 'reminder:seed-1')
    return {
      result: document.getElementById('promise-result')?.textContent || '',
      status: first?.querySelector('.rm-when')?.textContent || '',
      title: first?.querySelector('.rm-text')?.textContent || '',
      buttons: [...(first?.querySelectorAll('button') || [])].map((b) => b.textContent),
      itemStatus: item?.status,
      itemTitle: item?.title
    }
  })
  check('E1 重试成功：界面提示已取消并说明正文已清除',
    /已取消这条提醒/.test(done.result), done.result)
  check('E2 界面上的正文被清除（不再显示原文）',
    !done.title.includes(SECRET) && done.itemTitle === '' && done.itemStatus === 'cancelled',
    `ui="${done.title}" status=${done.itemStatus}`)
  check('E3 降级后入口变成「删除」', done.buttons.includes('删除'), done.buttons.join(','))
  const reminderGone = await page.evaluate(async () => (await window.nagi.reminders.list()).items
    .some((r) => r.id === 'seed-1'))
  check('E4 提醒本体确实被取消（不只清了记录）', reminderGone === false, 'seed-1 仍在列表=' + reminderGone)

  // ---- F：删除入口 ----
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#promise-list .rm-item')][0]
    const del = [...(row?.querySelectorAll('button') || [])].find((b) => b.textContent === '删除')
    del?.click()
  })
  await sleep(800)
  const afterDelete = await page.evaluate(async () => ({
    result: document.getElementById('promise-result')?.textContent || '',
    stillThere: (await window.nagi.promises.list()).items.some((p) => p.id === 'reminder:seed-1')
  }))
  check('F1 已结束记录可删除且不再重放外部操作',
    /已删除这条记录/.test(afterDelete.result) && afterDelete.stillThere === false,
    afterDelete.result + ' | stillThere=' + afterDelete.stillThere)

  // ---- G：删除入口对未结束记录的拒绝要走真实链路 ----
  const refuse = await page.evaluate(() => window.nagi.promises.remove('p-legacy-1'))
  check('G1 未结束记录走删除入口会被拒绝并说明原因',
    refuse?.ok === false && /取消流程/.test(refuse.error || ''), JSON.stringify(refuse))

} finally {
  try { setReadOnly(false) } catch { /* 尽力还原 */ }
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) {
    console.log('\n--- 主进程日志（末 25 行）---')
    console.log(logs.split('\n').slice(-25).join('\n'))
  }
  try { child.kill() } catch { /* 已退出 */ }
  process.exit(failed.length ? 1 : 0)
}
