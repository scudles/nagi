// 阶段10：隔离用户数据上的真实 Electron 启动、迁移、断网通道、重启与授权撤销。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { CalendarSnapshot } from '../src/core/signals/calendar-store.js'
import { ExperienceLedger } from '../src/core/ledger/store.js'
import { YearbookStore, yearbookMarkdown } from '../src/core/yearbook/store.js'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'
const root = resolve(import.meta.dirname, '..')
const executable = process.env.NAGI_VERIFY_EXECUTABLE
  ? resolve(process.env.NAGI_VERIFY_EXECUTABLE)
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const packaged = !!process.env.NAGI_VERIFY_EXECUTABLE
const profile = mkdtempSync(join(tmpdir(), 'nagi-stage10-'))
const port = Number(process.env.CDP_PORT || 9352)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`)
}

mkdirSync(join(profile, 'journal'))
writeFileSync(join(profile, 'journal', '2026-10-15.json'), JSON.stringify({ entries: [
  { kind: 'chat', t: Date.parse('2026-10-15T12:00:00Z'), user: '我们一起给凪设计年鉴', reply: '我会把事实和创作分开。' }
] }))
writeFileSync(join(profile, 'memory.json'), JSON.stringify({ entries: [
  { id: 'legacy-model-claim', text: '模型猜测我们曾经去过海边', at: Date.now() }
] }))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  llm: { provider: 'ollama', baseURL: 'http://127.0.0.1:1/v1', model: 'missing-model', temperature: 0.2 },
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
  voice: { ttsEngine: 'sapi' }, rag: { enabled: false }
}))
const start = new Date(Date.now() + 2 * 3600000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
new CalendarSnapshot(profile).importText([
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:stage10-offline',
  `DTSTART:${start}`, 'SUMMARY:隔离数据里的日程', 'END:VEVENT', 'END:VCALENDAR'
].join('\r\n'), '阶段10.ics')

let child
let logs = ''
async function launch() {
  const env = { ...process.env, NAGI_SELFTEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: packaged ? resolve(executable, '..') : root, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (part) => { logs += String(part) })
  child.stderr.on('data', (part) => { logs += String(part) })
  let browser
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        break
      }
    } catch { /* starting */ }
    await sleep(400)
  }
  if (!browser) throw new Error('Electron 未启动：' + logs.slice(-1000))
  for (let n = 0; n < 75; n++) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if (await page.evaluate(() => document.body?.dataset?.mode === 'pet' && !!window.nagi?.ledger)) return page
        } catch { /* navigating */ }
      }
    }
    await sleep(400)
  }
  throw new Error('桌宠未就绪：' + logs.slice(-1000))
}

async function stop() {
  if (!child?.pid) return
  const pid = child.pid
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('close', resolve)
    killer.on('error', resolve)
  })
  child = null
  for (let n = 0; n < 30; n++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) }) }
    catch { return }
    await sleep(200)
  }
}

try {
  const first = await launch()
  const round1 = await first.evaluate(async () => {
    const ledger = await window.nagi.ledger.list({ limit: 100 })
    const journal = ledger.entries.find((item) => item.source.type === 'journal' && item.text.includes('设计年鉴'))
    const claim = ledger.entries.find((item) => item.source.type === 'memory' && item.text.includes('海边'))
    const added = journal ? await window.nagi.yearbook.add(journal.id) : null
    const edited = added?.ok ? await window.nagi.yearbook.edit(added.page.id, '迁移来的真实对话', '用户写下：这段可以带走。') : null
    const reminder = await window.nagi.reminders.add({ text: '阶段10重启后仍在的提醒', at: Date.now() + 3600000 })
    const calendar = await window.nagi.calendar.status()
    const offline = await window.nagi.llm.localStatus({ baseURL: 'http://127.0.0.1:1/v1', model: 'missing-model' })
    return { ledger, journal, claim, added, edited, reminder, calendar, offline }
  })
  check('旧流水实机迁移且模型摘录保持未经核实', !!round1.journal &&
    round1.journal.occurredAt === Date.parse('2026-10-15T12:00:00Z') && round1.claim?.tier === 'unverified')
  check('离线本地模型给出明确不可达状态', round1.offline.reason === 'offline')
  check('迁移经历可收入年鉴，用户文字可编辑', round1.added?.ok && round1.edited?.ok)
  check('隔离日历可见，提醒已落盘', round1.calendar.authorized &&
    round1.calendar.events.some((item) => item.title === '隔离数据里的日程') && round1.reminder.ok)
  const migratedCount = round1.ledger.total
  await stop()

  const second = await launch()
  const round2 = await second.evaluate(async (id) => ({
    ledger: await window.nagi.ledger.list({ limit: 100 }),
    yearbook: await window.nagi.yearbook.list(),
    reminders: await window.nagi.reminders.list(),
    promises: await window.nagi.promises.list(),
    calendar: await window.nagi.calendar.status(),
    addedAgain: await window.nagi.yearbook.add(id)
  }), round1.journal?.id)
  check('重启后旧数据迁移不重复', round2.ledger.total === migratedCount &&
    round2.ledger.entries.filter((item) => item.id === round1.journal?.id).length === 1 &&
    existsSync(join(profile, 'ledger', 'migration.json')))
  check('年鉴编辑、提醒及承诺证据跨重启仍在', round2.yearbook.pages.some((item) =>
    item.title === '迁移来的真实对话' && item.note.includes('可以带走')) &&
    round2.addedAgain.existing &&
    round2.reminders.items.some((item) => item.text === '阶段10重启后仍在的提醒') &&
    round2.promises.items.some((item) => item.title?.includes('阶段10重启后仍在的提醒')))
  check('本地日历授权跨重启仍在', round2.calendar.authorized)
  const revoked = await second.evaluate(async () => {
    await window.nagi.calendar.revoke()
    await window.nagi.music.enable()
    await window.nagi.music.revoke()
    return { calendar: await window.nagi.calendar.status(), music: await window.nagi.music.status() }
  })
  check('日历和音乐撤销立即生效', !revoked.calendar.authorized && !revoked.music.authorized)
  await stop()

  const third = await launch()
  const after = await third.evaluate(async () => ({
    calendar: await window.nagi.calendar.status(), music: await window.nagi.music.status(),
    yearbook: await window.nagi.yearbook.list()
  }))
  check('授权撤销跨重启维持且年鉴仍可查看', !after.calendar.authorized &&
    !after.music.authorized && after.yearbook.pages.length === 1)
  await stop()

  const ledger = new ExperienceLedger(profile).load()
  const bundle = new YearbookStore(profile, ledger).load().exportBundle()
  const markdown = yearbookMarkdown(bundle)
  check('离线导出可重读来源与用户编辑', bundle.pages.length === 1 &&
    markdown.includes('迁移来的真实对话') && markdown.includes(round1.journal.id) &&
    markdown.includes('用户写下：这段可以带走。') && !markdown.includes('模型猜测我们曾经去过海边'))
  writeFileSync(join(profile, '年鉴验收导出.md'), markdown)
} catch (error) {
  console.error('✘ 阶段10生命周期验收中断：', error.message)
  console.error(logs.slice(-2000))
  process.exitCode = 1
} finally {
  await stop()
  console.log(`隔离数据：${profile}`)
  console.log(`阶段10生命周期验收：${checks.filter((item) => item.pass).length}/${checks.length}`)
  if (checks.some((item) => !item.pass)) process.exitCode = 1
}
process.exit(process.exitCode || 0)
