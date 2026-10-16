// 真实 Electron + 本机兼容流夹具 + Windows SAPI：量首句提前开播和会话创建中的打断。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'
const root = resolve(import.meta.dirname, '..')
const executable = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profile = mkdtempSync(join(tmpdir(), 'nagi-stage8-voice-'))
const port = Number(process.env.CDP_PORT || 9348)
const prompt = '阶段八语音流式验收：请回答。'
const first = '我已经听到了你的话。'
const second = '这是稍后才生成的第二句。'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`)
}
function sendDelta(response, content, finish = null) {
  response.write('data: ' + JSON.stringify({ id: 'voice-fixture', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] }) + '\n\n')
}

let child
let fixture
let logs = ''
try {
  fixture = createServer(async (request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'fixture-model' }] }))
      return
    }
    const parts = []
    for await (const part of request) parts.push(part)
    let body = {}
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { /* malformed request */ }
    const isProbe = body.messages?.at(-1)?.content === prompt
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    sendDelta(response, `[calm] ${isProbe ? first : '好的。'}`)
    if (isProbe) await sleep(2500)
    sendDelta(response, isProbe ? second : '', 'stop')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${fixture.address().port}/v1`
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    llm: { provider: 'ollama', baseURL, model: 'fixture-model', temperature: 0.2 },
    privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
    voice: { ttsEngine: 'sapi', ttsEnabled: true, speakOnReply: true },
    rag: { enabled: false }
  }))
  const env = { ...process.env, NAGI_SELFTEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
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
  if (!browser) throw new Error('Electron CDP 未启动：' + logs.slice(-1000))
  let page
  for (let n = 0; n < 75 && !page; n++) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        try {
          if (await candidate.evaluate(() => document.body?.dataset?.mode === 'pet' && !!window.__nagiVoice)) page = candidate
        } catch { /* navigation */ }
      }
    }
    if (!page) await sleep(400)
  }
  if (!page) throw new Error('桌宠及语音渲染层未就绪：' + logs.slice(-1000))
  page.on('pageerror', (error) => { logs += '\n[pageerror] ' + error.message })

  const earlyRelease = await page.evaluate(async () => {
    const media = navigator.mediaDevices
    const original = media.getUserMedia
    let stopped = false
    let resolveMedia
    Object.defineProperty(media, 'getUserMedia', { configurable: true, value: () => new Promise((resolve) => { resolveMedia = resolve }) })
    try {
      const started = window.__nagiVoice.startRecording()
      const cancelled = await window.__nagiVoice.stopRecording()
      resolveMedia({ getTracks: () => [{ stop: () => { stopped = true } }] })
      const settled = await started
      return { cancelled, settled, stopped, recording: window.__nagiVoice.isRecording() }
    } finally {
      Object.defineProperty(media, 'getUserMedia', { configurable: true, value: original })
    }
  })
  check('权限返回前松开麦克风不会迟发录音', earlyRelease.stopped && !earlyRelease.recording &&
    earlyRelease.settled.reason === '已松开麦克风', JSON.stringify(earlyRelease))

  // 不等待 IPC 返回就打断，覆盖过去会在 stop 后重新开播的竞态。
  const raced = await page.evaluate(async () => {
    const pending = window.__nagiVoice.speak('这段声音应该立刻被打断。')
    window.__nagiVoice.stopSpeaking()
    const result = await pending
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { result, state: window.__nagiVoice.state() }
  })
  check('创建中的语音会话被打断后不重新开播', !raced.result.ok && raced.state === null,
    JSON.stringify(raced))

  const send = page.evaluate((text) => window.nagi.chat.send(text), prompt)
  await page.waitForFunction(() => window.__nagiVoice.latencyTrace()?.firstAudioAt != null,
    null, { timeout: 12000 })
  const whileStreaming = await page.evaluate(() => window.__nagiVoice.latencyTrace())
  const result = await send
  const trace = await page.evaluate(() => window.__nagiVoice.latencyTrace())
  const metrics = {
    modelFirstMs: Math.round(trace.firstModelTokenAt - trace.chatSubmittedAt),
    ttsRequestMs: Math.round(trace.ttsRequestedAt - trace.chatSubmittedAt),
    firstAudioMs: Math.round(trace.firstAudioAt - trace.chatSubmittedAt),
    modelDoneMs: Math.round(trace.modelDoneAt - trace.chatSubmittedAt)
  }
  check('首句在模型整段完成前真实开播', result.ok && whileStreaming.modelDoneAt == null &&
    trace.firstAudioAt < trace.modelDoneAt, JSON.stringify(metrics))
  check('首音与模型完成时间均可量测', Object.values(metrics).every((value) => Number.isFinite(value) && value >= 0),
    JSON.stringify(metrics))
  writeFileSync(join(profile, 'stage8-metrics.json'), JSON.stringify({ trace, metrics, raced }, null, 2))
  const interrupted = await page.evaluate(() => ({ stopped: window.__nagiVoice.stopSpeaking(), state: window.__nagiVoice.state() }))
  check('正在朗读时可立即停止并清空队列', interrupted.stopped && interrupted.state === null)
  const warmSend = page.evaluate((text) => window.nagi.chat.send(text), prompt)
  await page.waitForFunction((previous) => {
    const next = window.__nagiVoice.latencyTrace()
    return next?.chatSubmittedAt > previous && next.firstAudioAt != null
  }, trace.chatSubmittedAt, { timeout: 12000 })
  const warmResult = await warmSend
  const warmTrace = await page.evaluate(() => window.__nagiVoice.latencyTrace())
  const warmMetrics = {
    modelFirstMs: Math.round(warmTrace.firstModelTokenAt - warmTrace.chatSubmittedAt),
    firstAudioMs: Math.round(warmTrace.firstAudioAt - warmTrace.chatSubmittedAt),
    modelDoneMs: Math.round(warmTrace.modelDoneAt - warmTrace.chatSubmittedAt)
  }
  check('热态首音也早于模型完结', warmResult.ok && warmTrace.firstAudioAt < warmTrace.modelDoneAt,
    JSON.stringify(warmMetrics))
  await page.evaluate(() => window.__nagiVoice.stopSpeaking())
  writeFileSync(join(profile, 'stage8-metrics.json'), JSON.stringify({ cold: { trace, metrics }, warm: { trace: warmTrace, metrics: warmMetrics }, raced }, null, 2))
} catch (error) {
  console.error('✘ 阶段8语音验收中断：', error.message)
  console.error(logs.slice(-1500))
  process.exitCode = 1
} finally {
  fixture?.closeAllConnections()
  if (fixture) await new Promise((resolve) => fixture.close(resolve))
  if (child?.pid) await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('close', resolve)
    killer.on('error', resolve)
  })
  console.log(`隔离数据：${profile}`)
  console.log(`阶段8语音验收：${checks.filter((item) => item.ok).length}/${checks.length}`)
  if (checks.some((item) => !item.ok)) process.exitCode = 1
}
process.exit(process.exitCode || 0)
