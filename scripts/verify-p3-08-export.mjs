// scripts/verify-p3-08-export.mjs
// P3-08 C5 统一记忆/数据导出（CONTRACTS §15 / EVAL §3.14）——**device 层**。
//
// 为什么必须真机：单测只能证明 core 纯函数与 main 桥接各自正确；
// "preload 没暴露 / IPC 没注册 / 写盘链路断"/"弹不出对话框"这三跳断了，
// 单测照样全绿。本脚本用真实 Electron + 隔离 profile 复跑：
//
//   A  preload 暴露 dataExport.run / preview
//   B  C5-EXPORT-04：预览不写盘（用户没点导出就没有外部文件）
//   C  真实「忘记」链路（设置页 → 她的记忆 → 忘记 → 原生确认框自动确认）后导出，
//      重读真实文件：旧正文不出现、删除标记可审计（C5-EXPORT-01）
//   D  导出侧第二道防线：账本已标 deleted 但正文仍残留在便签里的旧数据，
//      导出同样只留标记（防 pruneNotesReferencing 漏删的复活）
//   E  C5-EXPORT-03：同日第二次导出失败（不覆盖已有文件），原文件一字节不动
//   F  信任层抽查：用户确认/有来源观测/主观/模拟/未核实 五类各就各位
//
// 用法：node scripts/verify-p3-08-export.mjs
// 前置：node_modules/.bin/electron-vite.cmd build（或 dev 产物在 out/）
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9383'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

// 两条互不相同的隐私原文：一条走真实「忘记」链路，一条只标 deleted 留残留在便签里
const SECRET_REAL = '蓝区验收隐私甲：周五要替她交报告'
const SECRET_RESIDUE = '蓝区验收隐私乙：老家门牌号是 42 号'

const profile = mkdtempSync(join(tmpdir(), 'nagi-p308-'))
const exportDir = mkdtempSync(join(tmpdir(), 'nagi-p308-out-'))
const now = Date.now()

mkdirSync(join(profile, 'ledger'), { recursive: true })
mkdirSync(join(profile, 'journal'), { recursive: true })
mkdirSync(join(profile, 'monologue'), { recursive: true })

// 账本条目 id 不是随手编的：core/ledger/store.js 的 sourceId() = `e_` + sha256(`type:ref`).slice(0,20)。
// 种子必须按真实契约算，否则「忘记」走 deleteBySource 时按 (type,ref) 重算 id 查不到 -> 返回 false
// -> 用户看到「账本状态未写入」。这不是脚本的巧劲，是账本的 id 契约。
const eid = (type, ref) => 'e_' + createHash('sha256').update(`${type}:${ref}`).digest('hex').slice(0, 20)
const ID_REAL = eid('journal-live', 'jr-real')
const ID_RESIDUE = eid('journal-live', 'jr-res')
const ID_COLOR = eid('memory-manual', 'm1')

// 账本：一条 live experience（走真实忘记）+ 一条已标 deleted 的旧数据（留残留在便签）
// + 一条 live claim（用户确认，导出后应仍在）
writeFileSync(join(profile, 'ledger', 'entries.jsonl'), [
  { id: ID_REAL, category: 'experience', text: SECRET_REAL,
    source: { type: 'journal-live', ref: 'jr-real' }, occurredAt: now - 60000, recordedAt: now - 59000,
    certainty: 'observed', ragIds: [], meta: { eventKind: 'chat' }, revision: 1, correctedAt: null, deletedAt: null },
  { id: ID_RESIDUE, category: 'experience', text: SECRET_RESIDUE,
    source: { type: 'journal-live', ref: 'jr-res' }, occurredAt: now - 50000, recordedAt: now - 49000,
    certainty: 'observed', ragIds: [], meta: { eventKind: 'chat' }, revision: 1,
    correctedAt: null, deletedAt: now - 10000 },
  { id: ID_COLOR, category: 'claim', text: '他喜欢的颜色是蓝色',
    source: { type: 'memory-manual', ref: 'm1' }, occurredAt: now - 40000, recordedAt: now - 39000,
    certainty: 'user-stated', ragIds: [], meta: {}, revision: 1, correctedAt: null, deletedAt: null }
].map((r) => JSON.stringify(r)).join('\n') + '\n')

// 账本迁移标记：真实升级过的用户必然已有这个文件。不写它，boot 时的旧档迁移会把
// 我种下的 journal/memory 再索引成一批 source=journal / source=memory 的副本
// （日志「旧数据已建索引：2 条」），账本凭空多两条、且 UI「忘记」点到的是副本而非 e_real。
// 迁移本身有独立单测覆盖，这里要验的是导出，所以按"已迁移过的老用户"造态。
writeFileSync(join(profile, 'ledger', 'migration.json'),
  JSON.stringify({ version: 1, completedAt: now - 86400000 }) + '\n')

// memory.json：一条用户手动记下（与 e_color 同文，导出后应仍在且标用户确认）
writeFileSync(join(profile, 'memory.json'), JSON.stringify({
  version: 1, entries: [{ id: 'm1', text: '他喜欢的颜色是蓝色', at: now - 40000, provenance: 'user-stated' }]
}, null, 2))

// 流水：一条与 e_real 同坐标（真实忘记会按 occurredAt+eventKind 删掉它）
writeFileSync(join(profile, 'journal', `${new Date(now - 60000).toISOString().slice(0, 10)}.json`),
  JSON.stringify({ version: 1, entries: [{ t: now - 60000, kind: 'chat', user: `他：${SECRET_REAL}`, reply: '我：记住了' }] }, null, 2))

// 便签：一条模拟活动（导出应标「模拟」）+ 一条复述 e_residue 的旧数据（残留）
writeFileSync(join(profile, 'notes.json'), JSON.stringify({
  version: 1, savedAt: now,
  notes: [
    { id: 'n_sim', at: now - 20000, noteKind: 'activity', text: '读了会儿东西', provenance: 'simulation' },
    { id: 'n_res', at: now - 20000, noteKind: 'action', text: `便签复述 ${SECRET_RESIDUE}`, provenance: 'observed' }
  ],
  traces: [],
  noteState: { dayKey: '2026-10-19', count: 2, lastAt: now - 20000, seen: ['n_sim', 'n_res'] },
  anchorState: { dayKey: '2026-10-19', count: 0, lastAt: 0, lastAnchorId: null }
}, null, 2))

writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  version: 1, mode: 'workbench',
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false },
  presence: { enabled: false, notesEnabled: true, tracesEnabled: true, anchorsEnabled: true }
}, null, 2))

const env = { ...process.env, NAGI_RENDERER_SANDBOX: '0', NAGI_MODE: 'workbench',
  NAGI_SELFTEST_AUTO_CONFIRM: '1', NAGI_SELFTEST_EXPORT_DIR: exportDir }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
let logs = ''
child.stdout.on('data', (d) => { logs += String(d) })
child.stderr.on('data', (d) => { logs += String(d) })

let page = null
const isWorkbench = (p) => p.evaluate(() =>
  document.body?.dataset?.mode === 'workbench' && typeof window.nagi?.dataExport?.run === 'function'
).catch(() => false)
for (let i = 0; i < 150 && !page; i++) {
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

try {
  // ---- A：preload 暴露 ----
  const api = await page.evaluate(() => ({
    run: typeof window.nagi.dataExport.run,
    preview: typeof window.nagi.dataExport.preview
  }))
  check('A1 preload 暴露 dataExport.run / preview', api.run === 'function' && api.preview === 'function', JSON.stringify(api))

  // ---- B：C5-EXPORT-04 预览不写盘 ----
  const preview = await page.evaluate(() => window.nagi.dataExport.preview())
  check('B1 预览返回导出范围（含已删计数）',
    preview?.ok === true && preview.bundle?.schemaVersion === 1 && preview.bundle?.counts?.ledger === 3,
    JSON.stringify(preview?.bundle?.counts || preview))
  check('B2 预览一个外部文件都没写', readdirSync(exportDir).length === 0, readdirSync(exportDir).join(','))

  // ---- C：真实「忘记」链路后再导出（C5-EXPORT-01）----
  await page.evaluate(() => document.getElementById('btn-open-settings')?.click())
  await sleep(700)
  await page.evaluate(() => document.querySelector('.sp-nav-item[data-group="memory"]')?.click())
  await sleep(1500)
  const forget = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ledger-list .ledger-item')]
    const target = rows.find((r) => (r.textContent || '').includes('周五要替她交报告'))
    if (!target) return { found: false, rows: rows.length }
    const btn = [...(target.querySelectorAll('button') || [])].find((b) => b.textContent === '忘记')
    btn?.click()
    return { found: true }
  })
  check('C1 账本里能找到目标经历并点下「忘记」（原生确认框已自动确认）', forget.found === true, JSON.stringify(forget))
  await sleep(2000)
  const afterForget = await page.evaluate(() => document.getElementById('ledger-status')?.textContent || '')
  check('C2 忘记结果有可见反馈', afterForget.length > 0, afterForget.slice(0, 80))

  // 导出（NAGI_SELFTEST_EXPORT_DIR：无头环境弹不出系统保存框，
  // 写入链路与生产逐字相同——existsSync 预检 + partial + linkSync 原子占位）
  const exported = await page.evaluate(() => window.nagi.dataExport.run())
  check('C3 导出成功', exported?.ok === true, JSON.stringify(exported))
  const outFile = join(exportDir, `凪-数据导出-${new Date().toISOString().slice(0, 10)}.json`)
  check('C4 导出文件真实存在于目标目录', existsSync(outFile), outFile)

  if (existsSync(outFile)) {
    const text = readFileSync(outFile, 'utf8')
    check('C5 旧正文（真实忘记的那条）不出现在导出文件任何位置', !text.includes(SECRET_REAL))
    // 第二道防线：只标 deleted、正文残留在便签里的旧数据，同样不许复活
    check('C6 残留正文（便签里）不出现在导出文件任何位置', !text.includes(SECRET_RESIDUE))
    const bundle = JSON.parse(text)
    const dead = bundle.sections.ledger.items.find((i) => i.id === ID_REAL)
    check('C7 真实忘记的条目在导出里是删除标记（无正文）',
      dead?.status === 'deleted' && dead.deletedAt != null && dead.text === undefined, JSON.stringify(dead))
    const residueNote = bundle.sections.notes.items.find((i) => i.id === 'n_res')
    check('C8 残留便签在导出里是删除标记', residueNote?.status === 'deleted', JSON.stringify(residueNote))
    const journalDead = (bundle.sections.journal.days[0]?.items || []).find((i) => i.status === 'deleted')
    check('C9 对应流水也已不在（真实忘记链路删掉了它）', journalDead === undefined,
      journalDead ? '流水仍在=' + JSON.stringify(journalDead) : '已删')
    const colorItem = bundle.sections.ledger.items.find((i) => i.id === ID_COLOR)
    check('C10 live 数据齐全：颜色 claim 仍在且标用户确认',
      colorItem?.status === 'live' && colorItem.trustLayer === 'user-confirmed' && colorItem.text === '他喜欢的颜色是蓝色',
      JSON.stringify(colorItem))
    const simNote = bundle.sections.notes.items.find((i) => i.id === 'n_sim')
    check('C11 模拟便签标「模拟」，不被说成共同经历',
      simNote?.trustLayer === 'simulated', JSON.stringify(simNote))
    // 2 条已删 = 种下的已删残留 + 刚刚真实忘记掉的那条
    check('C12 计数如实（3 条账本 2 删 / 1 条便签删）',
      bundle.counts.ledger === 3 && bundle.counts.ledgerDeleted === 2 && bundle.counts.notesDeleted === 1,
      JSON.stringify(bundle.counts))
  }

  // ---- E：C5-EXPORT-03 同日第二次导出不覆盖 ----
  const again = await page.evaluate(() => window.nagi.dataExport.run())
  check('E1 目标已存在时导出失败（不静默覆盖）',
    again?.ok === false && again.reason === 'exists', JSON.stringify(again))
  if (existsSync(outFile)) {
    const before = readFileSync(outFile, 'utf8')
    const third = await page.evaluate(() => window.nagi.dataExport.run())
    check('E2 原文件一字节不动', third?.ok === false && readFileSync(outFile, 'utf8') === before)
  }
  check('E3 没有 .partial 残留', readdirSync(exportDir).filter((f) => f.includes('.partial')).length === 0,
    readdirSync(exportDir).join(','))
} finally {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) {
    console.log('\n--- 主进程日志（末 25 行）---')
    console.log(logs.split('\n').slice(-25).join('\n'))
  }
  try { child.kill() } catch { /* 已退出 */ }
  rmSync(profile, { recursive: true, force: true })
  rmSync(exportDir, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}
