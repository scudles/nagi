// Real Electron acceptance with a simulated Home Assistant server and no physical device.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const root = resolve(import.meta.dirname, '..')
const packagedExecutable = process.env.NAGI_VERIFY_EXECUTABLE
const electron = packagedExecutable ? resolve(packagedExecutable)
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profile = mkdtempSync(join(tmpdir(), 'nagi-signals-'))
const cdpPort = 9348
const checks = []
const check = (name, ok) => { checks.push(ok); console.log((ok ? '✔ ' : '✘ ') + name) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child
let logs = ''
let subscribed = null
let calls = 0
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end(); return }
  if (req.method === 'GET' && req.url === '/api/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('API running.'); return
  }
  if (req.method === 'GET' && req.url === '/api/states') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{ entity_id: 'light.fixture', state: 'off', attributes: { friendly_name: '模拟台灯' } }]))
    return
  }
  if (req.method === 'POST' && req.url.startsWith('/api/services/')) {
    calls++
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
  }
  res.writeHead(404); res.end()
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/websocket') { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'auth_required' }))
  ws.on('message', (raw) => {
    const data = JSON.parse(String(raw))
    if (data.type === 'auth') ws.send(JSON.stringify(data.access_token === 'fixture-token' ? { type: 'auth_ok' } : { type: 'auth_invalid' }))
    if (data.type === 'subscribe_events') {
      subscribed = ws
      ws.send(JSON.stringify({ id: data.id, type: 'result', success: true, result: null }))
    }
  })
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = 'http://127.0.0.1:' + server.address().port
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    llm: { provider: 'custom', model: 'fixture' },
    homeassistant: { enabled: true, baseURL },
    privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false }
  }))
  const env = { ...process.env, NAGI_MODE: 'workbench' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [...(packagedExecutable ? [] : ['.']), '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort], {
    cwd: packagedExecutable ? resolve(electron, '..') : root, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (d) => { logs += String(d) })
  child.stderr.on('data', (d) => { logs += String(d) })
  let ready = false
  for (let n = 0; n < 75; n++) {
    try { ready = (await fetch('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(1000) })).ok }
    catch { /* starting */ }
    if (ready) break
    await sleep(300)
  }
  if (!ready) throw new Error('Electron CDP did not start: ' + logs.slice(-1000))
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort)
  let page
  for (let n = 0; n < 75 && !page; n++) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        try { if (await candidate.evaluate(() => document.body?.dataset?.mode === 'workbench')) page = candidate }
        catch { /* navigating */ }
      }
    }
    if (!page) await sleep(300)
  }
  if (!page) throw new Error('Workbench page missing: ' + logs.slice(-1000))
  const before = await page.evaluate(() => window.nagi.ha.signalStatus())
  const denied = await page.evaluate(() => window.nagi.ha.list())
  check('旧连接配置不会自动授权设备读取', !before.readAuthorized && !denied.ok && !subscribed)
  const token = await page.evaluate(() => window.nagi.secrets.set('haToken', 'fixture-token'))
  check('模拟 Token 经系统密钥存储保存', token.ok)
  const read = await page.evaluate(() => window.nagi.ha.enableRead())
  for (let n = 0; n < 30 && !subscribed; n++) await sleep(200)
  check('单独只读授权后建立 HA 事件订阅', read.readAuthorized && !read.controlAuthorized && !!subscribed)
  const devices = await page.evaluate(() => window.nagi.ha.list())
  check('模拟设备状态通过只读 IPC 返回', devices.ok && devices.entities?.[0]?.entity_id === 'light.fixture')
  if (subscribed) subscribed.send(JSON.stringify({ type: 'event', event: { event_type: 'state_changed', data: {
    entity_id: 'light.fixture', old_state: { state: 'off' },
    new_state: { state: 'on', attributes: { friendly_name: '模拟台灯' } }
  } } }))
  for (let n = 0; n < 30; n++) {
    const state = await page.evaluate(() => window.nagi.ha.signalStatus())
    if (state.lastEvent?.summary?.includes('模拟台灯')) break
    await sleep(200)
  }
  const observed = await page.evaluate(() => window.nagi.ha.signalStatus())
  check('模拟状态变化带来源进入信号记录', observed.lastEvent?.summary === '模拟台灯 已打开')
  check('未授权控制时服务调用数仍为零', calls === 0)
  await page.evaluate(() => window.nagi.settings.set({ privacy: { doNotDisturb: true } }))
  const muted = await page.evaluate(() => window.nagi.ha.signalStatus())
  check('勿扰立即暂停 HA 信号', muted.paused && muted.readAuthorized)
  const revoked = await page.evaluate(() => window.nagi.ha.revokeSignal())
  const secret = await page.evaluate(() => window.nagi.secrets.status())
  const after = await page.evaluate(() => window.nagi.ha.list())
  check('撤销 HA 独立授权并删除 Token', revoked.ok && !revoked.readAuthorized &&
    !secret.haToken && !after.ok && revoked.lastEvent === null)
  await page.evaluate(() => window.nagi.settings.set({ privacy: { doNotDisturb: false } }))
  const music = await page.evaluate(async () => {
    const enabled = await window.nagi.music.enable()
    const revoked = await window.nagi.music.revoke()
    return { enabled, revoked }
  })
  check('授权后真实读取 Windows 媒体会话并可独立撤销',
    music.enabled.authorized && !music.enabled.error && !!music.enabled.observation &&
    music.revoked.authorized === false)
  console.log('  媒体观测：' + JSON.stringify(music.enabled.observation))
  const geo = await page.evaluate(async () => {
    const enabled = await window.nagi.geo.enable()
    const revoked = await window.nagi.geo.revoke()
    return { enabled, revoked }
  })
  check('授权后可读取位置（系统定位失败回退 IP），并可独立撤销',
    geo.enabled.authorized && !geo.enabled.error && !!geo.enabled.observation &&
    geo.revoked.authorized === false)
  console.log('  位置观测：' + JSON.stringify(geo.enabled.observation))
} catch (err) {
  console.error('✘ 验收中断：' + err.message)
  console.error(logs.slice(-1200))
  process.exitCode = 1
} finally {
  if (child?.pid) await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('close', resolve); killer.on('error', resolve)
  })
  for (const ws of wss.clients) ws.terminate()
  await new Promise((resolve) => server.close(resolve))
  console.log('隔离数据：' + profile)
  console.log('生活信号验收：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过')
  if (checks.some((ok) => !ok)) process.exitCode = 1
  // 一个检查都没跑到 = 应用根本没起来（本机 GPU 进程会崩，需 NAGI_RENDERER_SANDBOX=0）。
  // 这种情况必须判失败，否则「0/0 通过」会被当成绿灯（2026-10-17 踩过）。
  if (!checks.length) {
    console.error('✘ 没有执行到任何检查——应用未就绪，视为失败。受限环境请加 NAGI_RENDERER_SANDBOX=0')
    process.exitCode = 1
  }
}
process.exit(process.exitCode || 0)
