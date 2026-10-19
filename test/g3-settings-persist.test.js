// test/g3-settings-persist.test.js
// G3（B8 必修，涉隐私）：settings.json 写盘静默。
//
// 根因（ff95ee3a 基线即有的漏网，不是本轮新引入）：
//   settings-store.js 的 saveSettings 先 `cache = next` 再 try/writeFileSync，
//   catch 里只有 console.error，然后**无条件 return next**。于是：
//     · 调用方（IPC / 托盘 / 监测授权 / 外部便签）全部"正常成功"，renderer 把开关
//       刷成新值，而磁盘根本没写 → 重启恢复默认；
//     · 调用方写的 `try/catch + reportCatch` **永远不会触发**（这里根本不抛错），
//       是一层假防护；空 catch 扫描也扫不到——它是带 console.error 的非空 catch；
//     · persist.js 的 PERSIST_FILES 只有 memory/history/mood/relation，
//       不含 settings.json，没有第二通道。
//   对 privacy.noticeShown / privacy.monitorAuthorizedAt / 监测开关这类高敏项，
//   这就是"UI 显示已关闭、实际还在采"的隐私假关闭。
//
// 本文件固定四条验收断言（逐条对应任务书的 1-4）：
//   ① 落盘失败时相关 IPC 让 renderer 收到失败（throw / ok:false），绝不回成功；
//   ② 失败进入 getHealth，且 settings.json 作为持久化站点进 persist-warnings；
//   ③ 内存 cache 不得在落盘失败时被当成已生效（隐私项尤其）；
//   ④ 成功路径不回归。
//
// 真机由绿区注入文件锁 / 只读复跑（本文件只用 fs mock 造 EACCES）。

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'nagi-g3-'))
const settingsFile = join(userData, 'settings.json')
const warningsFile = join(userData, 'persist-warnings.json')

// 磁盘上的"旧值"：监测开着、已告知、有授权时间戳。
// 这是用户已经做过的选择——写盘失败后它们必须原样活着。
writeFileSync(settingsFile, JSON.stringify({
  version: 1,
  privacy: { noticeShown: true, monitorEnabled: true, monitorAuthorizedAt: 111 }
}, null, 2))

// 注入开关：只让 settings.json（及其原子写的 tmp）写失败，其余文件照常。
// 目录整体只读/满/被锁时 tmp 也会失败——那正是 flushPersist 要覆盖的路径。
// 注意：mock.module 的 exports 不能 spread 整个 node:fs（含 constants 等不可配置属性，
// 会报 "Cannot redefine property: constants"），按本文件及其依赖实际用到的显式列出。
let failSettingsWrite = false
mock.module('node:fs', {
  exports: {
    readFileSync: realFs.readFileSync,
    writeFileSync: (p, ...rest) => {
      const s = String(p)
      if (failSettingsWrite && (s.endsWith('settings.json') || s.endsWith('settings.json.tmp'))) {
        throw Object.assign(new Error("EACCES: permission denied, open 'settings.json'"), { code: 'EACCES' })
      }
      return realFs.writeFileSync(p, ...rest)
    },
    existsSync: realFs.existsSync,
    mkdirSync: realFs.mkdirSync,
    renameSync: realFs.renameSync,
    unlinkSync: realFs.unlinkSync,
    readdirSync: realFs.readdirSync,
    statSync: realFs.statSync,
    realpathSync: realFs.realpathSync
  }
})

mock.module('electron', {
  exports: {
    app: { getPath: () => userData, getVersion: () => '0.0.0', getName: () => 'Nagi', isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false }
  }
})

// IPC 测试用的捕获器
const handlers = new Map()
const broadcasts = []
const refreshCalls = []
mock.module('../src/main/ipc/trusted.js', {
  exports: {
    trustedHandle: (channel, handler) => { handlers.set(channel, handler) },
    trustedOn: (channel, handler) => { handlers.set(channel, handler) }
  }
})
mock.module('../src/main/windows.js', {
  exports: {
    broadcast: (channel, payload) => { broadcasts.push({ channel, payload }) },
    switchMode: () => {}, getMode: () => 'pet', getPetWindow: () => null, getWorkbenchWindow: () => null,
    openDiaryWindow: () => {}, resizePetWindow: () => {}, movePetWindow: () => {}
  }
})
mock.module('../src/main/keystore.js', {
  exports: { setSecret: () => ({ ok: true }), hasSecret: () => false, deleteSecret: () => ({ ok: true }) }
})
mock.module('../src/main/agent.js', {
  exports: { memoryList: () => [], memoryAdd: () => ({}), historyClear: () => ({}), abortChat: () => ({ ok: true }) }
})
mock.module('../src/main/ledger.js', {
  exports: { recordLedger: () => true, deleteLedgerSource: () => true, getLedger: () => ({ list: () => [] }) }
})
mock.module('../src/main/ledger-actions.js', { exports: { forgetExperience: () => ({ ok: true }) } })
mock.module('../src/main/paths.js', { exports: { modelsDir: join(userData, 'models'), projectRoot: userData } })
mock.module('../src/main/monitor/index.js', {
  exports: { refreshMonitorPrivacy: () => { refreshCalls.push('monitor') } }
})
mock.module('../src/main/signals/ha.js', { exports: { refreshHaSignals: () => {} } })
mock.module('../src/main/presence.js', { exports: { refreshPresence: () => { refreshCalls.push('presence') } } })
mock.module('../src/main/ambient-host.js', { exports: { syncAmbientHost: () => {} } })

const { saveSettings, getSettings } = await import('../src/main/settings-store.js')
const { maintenanceHealth, maintenanceTrace, clearMaintenanceTrace } = await import('../src/main/maintenance.js')
const { flushPersist, consumePersistWarnings } = await import('../src/main/persist.js')
const { registerSettingsIpc } = await import('../src/main/ipc/settings.js')
const { IPC, EVT } = await import('../src/shared/protocol.js')

const diskPrivacy = () => JSON.parse(readFileSync(settingsFile, 'utf8')).privacy

/* ================= ① + ③ saveSettings 本身 ================= */

test('G3-A 落盘失败：抛错、内存 cache 不更新、磁盘不变、单点上报', () => {
  clearMaintenanceTrace()
  // 先正常读一次建立 cache（旧值：监测开着）
  assert.equal(getSettings().privacy.monitorEnabled, true)

  failSettingsWrite = true
  assert.throws(
    () => saveSettings({ privacy: { monitorEnabled: false } }),
    /保存设置失败.*无法写入 settings\.json/,
    '落盘失败必须抛错，绝不静默 return next'
  )
  failSettingsWrite = false

  // ③ 内存不得被当成已生效：cache 仍是旧值，与磁盘一致
  assert.equal(getSettings().privacy.monitorEnabled, true,
    '落盘失败后内存 cache 必须还是旧值——否则本轮会话的行为会和重启后对不上')
  // 磁盘也没被碰
  assert.equal(diskPrivacy().monitorEnabled, true, '磁盘必须保持上一版')

  // ② 单点上报：站点 + 类
  const site = maintenanceHealth().sites.find((s) => s.site === 'settings.saveSettings')
  assert.ok(site, '必须进健康状态')
  assert.equal(site.lastClass, 'must-persist', '写盘失败属 MUST_PERSIST')
  assert.equal(maintenanceHealth().healthy, false, '健康状态不能仍显示一切正常')
})

test('G3-A2 上报与轨迹脱敏：不含文件路径，也不含用户设置正文', () => {
  clearMaintenanceTrace()
  failSettingsWrite = true
  assert.throws(() => saveSettings({ privacy: { monitorEnabled: false } }))
  failSettingsWrite = false

  const site = maintenanceHealth().sites.find((s) => s.site === 'settings.saveSettings')
  assert.ok(site, '站点要记下来')
  assert.ok(!site.lastMessage.includes(userData), '健康快照不得出现 userData 绝对路径')
  assert.ok(!site.lastMessage.includes('monitorEnabled'), '不得把用户设置字段名/值塞进健康快照')
  assert.match(site.lastMessage, /settings\.json/, '要能看出是 settings.json 出事')
  assert.match(site.lastMessage, /EACCES/, '要能看出失败原因（fs code）')

  const trace = maintenanceTrace(5)
  assert.ok(trace.some((t) => t.site === 'settings.saveSettings' && t.cls === 'must-persist'),
    '失败轨迹里也要有这一条')
  assert.ok(!trace.some((t) => String(t.message || '').includes(userData)), '轨迹同样不得泄露路径')
})

/* ================= ① + ④ IPC 层 ================= */

test('G3-B 落盘失败时 SETTINGS_SET 让 renderer 收到失败，且不广播假成功', () => {
  clearMaintenanceTrace()
  registerSettingsIpc()
  const call = (patch) => handlers.get(IPC.SETTINGS_SET)({ sender: {} }, patch)

  failSettingsWrite = true
  assert.throws(
    () => call({ privacy: { monitorEnabled: false } }),
    /保存设置失败/,
    'IPC 必须把失败传给 renderer（ipcMain.handle 的 throw → invoke reject）'
  )
  failSettingsWrite = false

  // 绝不广播"设置已变化"——那会让 renderer 把开关刷成新值（隐私假关闭）
  assert.equal(broadcasts.length, 0, '落盘失败不得广播 SETTINGS_CHANGED')
  // 后置刷新动作也不该跑（它们属于"保存成功"的副作用）
  assert.deepEqual(refreshCalls, [], '失败时不得执行保存成功才有的后置刷新')
  // renderer 下次 get 到的仍是旧值
  assert.equal(getSettings().privacy.monitorEnabled, true)
  assert.equal(diskPrivacy().monitorEnabled, true)
})

test('G3-C 成功路径不回归：正常保存 resolve、广播、cache 与磁盘都更新', () => {
  clearMaintenanceTrace()
  broadcasts.length = 0
  refreshCalls.length = 0
  registerSettingsIpc()
  const call = (patch) => handlers.get(IPC.SETTINGS_SET)({ sender: {} }, patch)

  const before = getSettings().privacy.monitorEnabled
  const next = call({ privacy: { monitorEnabled: !before } })
  assert.equal(next.privacy.monitorEnabled, !before, 'handler 要返回新设置')
  assert.equal(getSettings().privacy.monitorEnabled, !before, 'cache 要更新')
  assert.equal(diskPrivacy().monitorEnabled, !before, '磁盘要更新')
  assert.ok(broadcasts.some((b) => b.channel === EVT.SETTINGS_CHANGED), '成功才广播')
  assert.ok(refreshCalls.includes('monitor'), '成功才跑后置刷新')
  assert.equal(maintenanceHealth().healthy, true, '成功路径不留下红站点')

  // 还原，别影响后续用例
  call({ privacy: { monitorEnabled: before } })
})

/* ================= ② persist-warnings 第二通道 ================= */

test('G3-D settings.json 纳入持久化站点：flushPersist 失败进 persist-warnings', () => {
  clearMaintenanceTrace()
  if (existsSync(warningsFile)) rmSync(warningsFile, { force: true })

  // 成功时：settings.json 被纳入刷盘清单，且不产生 warnings
  const ok = flushPersist()
  assert.ok(ok.written.includes('settings.json'),
    'settings.json 必须作为持久化站点纳入退出刷盘')
  assert.deepEqual(ok.failed, [], '正常情况不该有失败')
  assert.equal(existsSync(warningsFile), false, '没有失败就不该造出 warnings 文件')

  // 失败时：和其他文件一起进 persist-warnings（可追溯）
  failSettingsWrite = true
  const bad = flushPersist()
  failSettingsWrite = false

  assert.equal(bad.ok, false)
  assert.ok(bad.failed.some((f) => f.file === 'settings.json'),
    'settings.json 写失败必须出现在 failed 里')
  assert.ok(existsSync(warningsFile), '失败必须落 persist-warnings（可追溯）')
  const events = JSON.parse(readFileSync(warningsFile, 'utf8')).events
  assert.ok(events.length > 0, 'warnings 要有事件')
  const files = events.at(-1).failed.map((f) => f.file)
  assert.ok(files.includes('settings.json'), 'warnings 里要能看出是 settings.json')

  // 重启后能取回并清空（一次一提示）
  assert.equal(consumePersistWarnings().length, 1)
  assert.equal(existsSync(warningsFile), false, '消费后要清掉，不复读')
})
