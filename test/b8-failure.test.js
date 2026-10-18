// test/b8-failure.test.js
// B8（P2-04）：**失败路径**的验收（EVAL §3.11 B8-DEGRADE-01 / B8-PERSIST-01 / B8-PROMISE-01）。
//
// 用户要求里最要害的一句：「正常路径 12/12 不能代替失败路径验收」。
// 所以这个文件跑的全是**失败**：真的把存储搞坏、真的让承诺失败，
// 然后检查四件事——错误可见、状态可查、恢复后可重试、轨迹脱敏且可清除。
//
// 注入手法与 test/persist.test.js 一致：纯文件系统技巧（半行数据 / 目标占成目录），
// 不 mock 任何 fs，也不用假的 catch 替身。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const userData = mkdtempSync(join(process.cwd(), '.nagi-b8-failure-'))
after(() => { try { rmSync(userData, { recursive: true, force: true }) } catch {} })

const { RagStoreIo } = await import('../src/main/rag/store-io.js')
const { createReminderDelivery } = await import('../src/core/reminders/delivery.js')
const { maintenanceHealth, maintenanceTrace, clearMaintenanceTrace, reportCatch, CATCH_CLASS } =
  await import('../src/main/maintenance.js')
const { scanCatches } = await import('../scripts/b8-catch-audit.mjs')

const siteOf = (name) => maintenanceHealth().sites.find((s) => s.site === name)

test('B8-AUDIT-01：主进程与 core 里没有"既不上报也不分级"的空 catch', () => {
  const sites = scanCatches()
  assert.ok(sites.length > 0, '扫描本身要读到东西，否则这条断言是假绿')
  const unhandled = sites.filter((s) => !s.reported && !s.cls)
  assert.deepEqual(unhandled.map((s) => `${s.file}:${s.line}`), [],
    '新写的空 catch 必须补 /* B8:<类> — 理由 */ 或接 reportCatch')
  // 接线的点已经不再是"空 catch"，所以要直接数源码里的上报点——
  // 这样"把 reportCatch 删掉改回空注释"会让这条断言变红（防回潮）。
  let wired = 0
  const files = []
  for (const rel of ['src/main', 'src/core']) {
    for (const f of readdirSync(join(ROOT, rel), { recursive: true })) {
      const p = join(ROOT, rel, f)
      if (!p.endsWith('.js') || statSync(p).isDirectory()) continue
      const hits = readFileSync(p, 'utf8').match(/reportCatch\('/g)
      if (hits) { wired += hits.length; files.push(`${rel}/${f}`.replace(/\\/g, '/')) }
    }
  }
  assert.ok(wired >= 25, `接线点应有规模（当前 ${wired} 处），低于阈值说明上报被成片删掉了`)
  assert.ok(files.length >= 8, `接线应覆盖多个模块（当前 ${files.length} 个）`)
  // 关键站点清单：这几处是"静默就把用户卖了"的地方，删掉任何一处都必须让这条测试变红。
  const CRITICAL = ['store-io.loadMeta', 'store-io.readPending', 'store-io.rewritePending',
    'delivery.createReminderDelivery', 'reminders.addReminder', 'reminders.removeReminder',
    'reminders.completeReminder', 'persist.consumePersistWarnings', 'journal.pruneJournals',
    'relation.pruneTimeline', 'agent.syncFactsToRag', 'windows.resizePetWindow',
    'outfit.registerOutfitIpc', 'store.readJsonLines']
  const all = new Set()
  for (const f of files) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/reportCatch\('([^']+)'/g)) all.add(m[1])
  }
  for (const site of CRITICAL) assert.ok(all.has(site), `关键站点 ${site} 的上报不见了`)
})

test('B8-PERSIST-01：真实持久化失败 → 健康状态翻红 + 轨迹可查 + 被脱敏', () => {
  clearMaintenanceTrace()
  const root = join(userData, 'rag-persist')
  mkdirSync(root, { recursive: true })
  const io = new RagStoreIo(root)

  // 注入：待嵌队列里留半行（进程被杀留下的真实形态）
  writeFileSync(io.pendingFile, '{"text":"完整的一条","hash":"a"}\n{"text":"被截断的半行', 'utf8')
  assert.equal(maintenanceHealth().healthy, true, '自检：还没读的时候应该是绿的')

  const pending = io.readPending()
  assert.equal(pending.length, 1, '完整那条照常读出，半行被丢')

  // ① 错误可见：健康状态不再全绿，且点名到具体站点
  const health = maintenanceHealth()
  assert.equal(health.healthy, false, '持久化失败不能静默：healthy 必须翻红')
  const site = siteOf('store-io.readPending')
  assert.ok(site, `轨迹要点名站点，现有：${health.sites.map((s) => s.site).join(',')}`)
  assert.equal(site.lastClass, 'must-persist')
  assert.equal(site.count, 1)

  // ② 状态可查：只读快照里能看到次数与最近消息
  const trace = maintenanceTrace(10)
  assert.ok(trace.length >= 1)
  const last = trace.at(-1)
  assert.equal(last.site, 'store-io.readPending')
  assert.equal(last.cls, 'must-persist')
  // ③ 脱敏：不得带绝对路径
  assert.equal(/[A-Za-z]:\\/.test(last.message), false, `消息里的盘符路径要被打码：${last.message}`)
  assert.ok(last.message.length <= 121, '消息要有长度上限')

  // ④ 恢复后可重试：换成完整数据，同一站点不再报错
  writeFileSync(io.pendingFile, '{"text":"修好的一条","hash":"b"}\n', 'utf8')
  assert.equal(io.readPending().length, 1)
  assert.equal(siteOf('store-io.readPending').count, 1, '修复后不应再有新的失败累计')
})

test('B8-PERSIST-02：meta 损坏也要被点到，且可被一键清除（不留副本）', () => {
  clearMaintenanceTrace()
  const root = join(userData, 'rag-meta')
  mkdirSync(root, { recursive: true })
  const io = new RagStoreIo(root)
  writeFileSync(io.metaFile, '{ 这不是合法的 json', 'utf8')

  io.loadMeta()
  assert.ok(siteOf('store-io.loadMeta'), 'meta 损坏要被记录')
  assert.equal(maintenanceHealth().healthy, false)

  clearMaintenanceTrace()
  assert.equal(maintenanceTrace().length, 0, '可删：轨迹清空')
  assert.equal(maintenanceHealth().healthy, true, '可删：健康状态复位')
  assert.deepEqual(maintenanceHealth().sites, [], '健康站点也不留副本')
})

test('B8-PERSIST-03：清队列时目标占成目录 → 失败不静默，也不要谎报成功', () => {
  clearMaintenanceTrace()
  const root = join(userData, 'rag-blocked')
  mkdirSync(root, { recursive: true })
  const io = new RagStoreIo(root)
  writeFileSync(io.pendingFile, '{"text":"先有一条","hash":"c"}\n', 'utf8')
  // 注入：unlinkSync 目标是目录 → 必败（真实 EPERM/EISDIR）
  const guard = join(io.pendingFile + '.guard')
  rmSync(io.pendingFile, { force: true })
  mkdirSync(io.pendingFile)
  try {
    const items = io.readPending()
    assert.deepEqual(items, [], '读不到应返回空，而不是抛出去')
    io.rewritePending([]) // 目标被占成目录，unlink 会失败
    const site = maintenanceHealth().sites.find((s) => s.site.startsWith('store-io'))
    assert.ok(site, '删不掉队列必须被记录，不许假装清干净了')
    assert.equal(site.lastClass, 'must-persist')
  } finally {
    rmSync(guard, { force: true })
  }
})

test('B8-PROMISE-01：提醒交付失败 → 记 PROMISE 类 + 修复后可重试', () => {
  clearMaintenanceTrace()
  let presentThrows = true
  let notifyThrows = true
  let presented = 0
  let notified = 0
  const delivery = createReminderDelivery({
    present: () => { if (presentThrows) throw new Error('ENOENT: 弹窗起不来'); presented++; return true },
    notify: () => { if (notifyThrows) throw new Error('通知服务不可用'); notified++; return true }
  })
  const item = { id: 'r1', text: '喝水', at: 1000, repeat: 'none' }

  const first = delivery(item)
  assert.equal(first, false, '两种通道都失败时要如实返回未送达（不许误报完成）')
  const promised = maintenanceHealth().sites.filter((s) => s.lastClass === 'promise')
  assert.ok(promised.length >= 1, '提醒失败必须归到 promise 类')
  assert.equal(maintenanceHealth().healthy, false)
  assert.ok(maintenanceTrace().some((t) => t.cls === 'promise'), '轨迹里要有承诺失败')

  // 恢复后可重试：通道好了就真的送达
  presentThrows = false
  notifyThrows = false
  const second = delivery(item)
  assert.equal(second, true, '恢复后必须能重试成功')
  assert.equal(presented, 1)
  assert.equal(notified, 1)
})

test('B8-DEGRADE-01：可降级失败只进轨迹，不翻红也不打扰用户', () => {
  clearMaintenanceTrace()
  reportCatch('cache.someProbe', CATCH_CLASS.DEGRADE, new Error('读可选缓存失败'))
  // 轨迹里要查得到（出了事总得能诊断）
  assert.ok(maintenanceTrace().some((t) => t.site === 'cache.someProbe'))
  // 但用户侧不得被判定为"不健康"——可降级错误不许打扰
  assert.equal(maintenanceHealth().healthy, true)
  // 对照：同一条 станция 换成必须出声的类，立刻翻红（证明上面的 true 不是恒真）
  reportCatch('cache.someProbe', CATCH_CLASS.MUST_PERSIST, new Error('ENOENT'))
  assert.equal(maintenanceHealth().healthy, false)
  const site = siteOf('cache.someProbe')
  assert.equal(site.count, 2, '同一站点累计次数')
  assert.equal(site.lastClass, 'must-persist', '取最近一次的分类')
})
