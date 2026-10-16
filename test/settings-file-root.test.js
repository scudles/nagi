// test/settings-file-root.test.js
// B07：R01 文件授权根撤销 / 换根 / 防绕过回归固化（真实 settings IPC 处理函数 + 模拟依赖）。
// 场景来源：HANDOFF B07 输入的 15 项临时验证中的 4 项 settings IPC 场景。
// 保护的契约：
//   1) 文件根撤销 / 换根必须先中止旧回合，再落盘新授权——不能自动用新根继续旧请求；
//   2) 取消系统选择窗不改授权、不中止；
//   3) 文件授权目录只能通过系统选择窗口修改，通用设置通道不得替换。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'nagi-settings-ipc-'))

/* ---------------- 模拟依赖（在导入 settings.js 之前注册） ---------------- */
const handlers = new Map()  // trustedHandle 捕获的 IPC 处理函数
const listeners = new Map() // trustedOn 捕获的 IPC 监听函数
const order = []          // 记录 abort / save 的先后
const abortCalls = []     // abortChat 调用次数
const saveCalls = []      // saveSettings 调用参数
const broadcasts = []     // SETTINGS_CHANGED 广播
let pickerResult = { canceled: true }
let currentSettings = { tools: { fileRoot: '' }, privacy: {} }
const settingsFile = join(userData, 'settings.json')
writeFileSync(settingsFile, JSON.stringify(currentSettings))

const abortChat = () => {
  order.push('abort')
  abortCalls.push(1)
  return { ok: true }
}
const saveSettings = (patch) => {
  order.push('save')
  saveCalls.push(patch)
  const next = { ...currentSettings, ...patch }
  if (patch && patch.tools) next.tools = { ...currentSettings.tools, ...patch.tools }
  currentSettings = next
  writeFileSync(settingsFile, JSON.stringify(currentSettings))
  return currentSettings
}

mock.module('electron', {
  exports: {
    app: { getPath: () => userData, getVersion: () => '0.0.0', getName: () => 'Nagi', isPackaged: false },
    dialog: { showOpenDialog: async () => pickerResult },
    BrowserWindow: { fromWebContents: () => null },
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
mock.module('../src/main/ipc/trusted.js', {
  exports: {
    trustedHandle: (channel, handler) => { handlers.set(channel, handler) },
    trustedOn: (channel, handler) => { listeners.set(channel, handler) }
  }
})
mock.module('../src/main/settings-store.js', {
  exports: { getSettings: () => currentSettings, saveSettings, settingsPath: () => settingsFile }
})
mock.module('../src/main/keystore.js', {
  exports: { setSecret: () => ({ ok: true }), hasSecret: () => false, deleteSecret: () => ({ ok: true }) }
})
mock.module('../src/main/windows.js', {
  exports: {
    broadcast: (channel, payload) => { broadcasts.push({ channel, payload }) },
    switchMode: () => {}, getMode: () => 'pet', getPetWindow: () => null, getWorkbenchWindow: () => null,
    openDiaryWindow: () => {}, resizePetWindow: () => {}, movePetWindow: () => {}
  }
})
mock.module('../src/main/agent.js', {
  exports: { memoryList: () => [], memoryAdd: () => ({}), historyClear: () => ({}), abortChat }
})
mock.module('../src/main/ledger.js', { exports: { getLedger: () => ({ list: () => [] }) } })
mock.module('../src/main/ledger-actions.js', { exports: { forgetExperience: () => ({ ok: true }) } })
mock.module('../src/main/paths.js', { exports: { modelsDir: join(userData, 'models'), projectRoot: userData } })
mock.module('../src/main/monitor/index.js', { exports: { refreshMonitorPrivacy: () => {} } })
mock.module('../src/main/signals/ha.js', { exports: { refreshHaSignals: () => {} } })

const { registerSettingsIpc } = await import('../src/main/ipc/settings.js')
const { IPC, EVT } = await import('../src/shared/protocol.js')

registerSettingsIpc()
const fakeEvent = { sender: {} }
const call = (channel, ...args) => handlers.get(channel)(fakeEvent, ...args)

/* ---------------- 场景 ---------------- */

test('撤销授权根：先中止旧回合，再落盘空根', () => {
  const r = call(IPC.TOOLS_REVOKE_ROOT)
  assert.deepEqual(r, { ok: true })
  assert.equal(abortCalls.length, 1, '撤销必须立即中止旧回合')
  assert.equal(saveCalls.length, 1, '撤销必须落盘')
  assert.ok(order.indexOf('abort') < order.indexOf('save'), '必须先取消再保存')
  assert.equal(currentSettings.tools.fileRoot, '', '撤销后授权根为空')
  assert.ok(broadcasts.some((b) => b.channel === EVT.SETTINGS_CHANGED), '应广播设置变化')
})

test('换根：先中止旧回合，再替换授权目录', async () => {
  const picked = mkdtempSync(join(tmpdir(), 'nagi-pick-'))
  pickerResult = { canceled: false, filePaths: [picked] }
  const abortBefore = abortCalls.length
  const saveBefore = saveCalls.length
  const r = await call(IPC.TOOLS_PICK_ROOT)
  assert.deepEqual(r, { ok: true, fileRoot: realpathSync(picked) })
  assert.equal(abortCalls.length, abortBefore + 1, '换根必须中止旧回合')
  const saveIndex = order.lastIndexOf('save')
  const abortIndex = order.lastIndexOf('abort')
  assert.ok(abortIndex < saveIndex, '必须先取消再保存新授权')
  assert.equal(currentSettings.tools.fileRoot, realpathSync(picked), '新授权根生效')
  const onDisk = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.equal(onDisk.tools.fileRoot, realpathSync(picked), '授权根已落盘')
  rmSync(picked, { recursive: true, force: true })
})

test('取消选择窗：不改授权、不中止、不落盘', async () => {
  pickerResult = { canceled: true }
  const before = currentSettings.tools.fileRoot
  const abortBefore = abortCalls.length
  const saveBefore = saveCalls.length
  const r = await call(IPC.TOOLS_PICK_ROOT)
  assert.deepEqual(r, { ok: false, canceled: true })
  assert.equal(abortCalls.length, abortBefore, '取消 picker 不得中止回合')
  assert.equal(saveCalls.length, saveBefore, '取消 picker 不得落盘')
  assert.equal(currentSettings.tools.fileRoot, before, '授权保持不变')
})

test('通用设置通道不能替换文件授权根', () => {
  const before = currentSettings.tools.fileRoot
  const saveBefore = saveCalls.length
  assert.throws(
    () => call(IPC.SETTINGS_SET, { tools: { fileRoot: 'C:/attacker' } }),
    /文件授权目录只能通过系统选择窗口修改/,
    '不同值必须被拒绝'
  )
  assert.equal(saveCalls.length, saveBefore, '被拒绝的补丁不得落盘')
  assert.equal(currentSettings.tools.fileRoot, before, '授权根未被改动')
  // 同值放行（设置页回显场景）
  const same = { tools: { fileRoot: before } }
  assert.doesNotThrow(() => call(IPC.SETTINGS_SET, same))
  // 不含 fileRoot 的常规补丁放行
  assert.doesNotThrow(() => call(IPC.SETTINGS_SET, { privacy: { doNotDisturb: true } }))
  assert.equal(currentSettings.privacy.doNotDisturb, true)
})
