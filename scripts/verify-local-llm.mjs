// M6 真机验收：真实 Electron + 独立 userData + 本机 Ollama 模型。
// 前置：ollama serve && ollama pull qwen2.5；构建后运行 npm run verify:local-llm。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const root = resolve(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const port = Number(process.env.CDP_PORT || 9340)
const model = process.env.OLLAMA_TEST_MODEL || 'qwen2.5'
const baseURL = process.env.OLLAMA_TEST_BASE_URL || 'http://127.0.0.1:11434/v1'
const profile = mkdtempSync(join(tmpdir(), 'nagi-local-llm-'))
const fileRoot = join(profile, 'files')
mkdirSync(fileRoot)
writeFileSync(join(fileRoot, 'm6-proof.txt'), 'local tool proof\n')
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  llm: { provider: 'ollama', baseURL, model, temperature: 0.2 },
  tools: { fileRoot },
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
  voice: { ttsEngine: 'sapi' },
  rag: { enabled: true, provider: 'local' }
}))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms}ms`)), ms) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

let child
let logs = ''
let fixture
try {
  const env = { ...process.env, NAGI_SELFTEST: '1', NAGI_SELFTEST_DIARY_WRITE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (data) => { logs += String(data) })
  child.stderr.on('data', (data) => { logs += String(data) })

  let ready = false
  for (let n = 0; n < 100; n++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok
    } catch { /* starting */ }
    if (ready) break
    await sleep(400)
  }
  if (!ready) throw new Error('Electron CDP 未启动：' + logs.slice(-1500))
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  let page
  for (let n = 0; n < 75; n++) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        try {
          if (await candidate.evaluate(() => document.body?.dataset?.mode === 'pet')) page = candidate
        } catch { /* navigating */ }
      }
    }
    if (page) break
    await sleep(400)
  }
  if (!page) throw new Error('找不到桌宠页面：' + logs.slice(-1500))

  const status = await page.evaluate((args) => window.nagi.llm.localStatus(args), { baseURL, model })
  check('主进程探测本机已安装模型', status.ok && status.models.some((name) => name.startsWith(model)), JSON.stringify(status))
  const keyState = await page.evaluate(() => window.nagi.secrets.status())
  check('无云端 API Key 仍能进入本地通道', !keyState.llmApiKey)
  const invalid = await page.evaluate((args) => window.nagi.llm.localStatus(args), { baseURL: 'https://example.com/v1', model })
  check('本地通道拒绝远端地址', invalid.reason === 'invalid-url')
  const missing = await page.evaluate((args) => window.nagi.llm.localStatus(args), { baseURL, model: 'nagi-missing-model:never' })
  check('本机缺少所选模型时给出明确状态', missing.reason === 'model-missing' && missing.models.length > 0)
  const offline = await page.evaluate((args) => window.nagi.llm.localStatus(args), { baseURL: 'http://127.0.0.1:1/v1', model })
  check('本机服务不可达时给出明确状态', offline.reason === 'offline')

  await page.evaluate(() => document.getElementById('btn-pet-settings')?.click())
  await page.waitForFunction(() => document.getElementById('set-local-llm-status')?.textContent?.includes('已就绪'), null, { timeout: 10000 })
  const localUi = await page.evaluate(() => ({
    localVisible: !document.getElementById('set-local-llm')?.classList.contains('hidden'),
    keyHidden: document.getElementById('set-cloud-key-wrap')?.classList.contains('hidden'),
    optionCount: document.getElementById('set-local-model-list')?.options.length
  }))
  check('设置页显示本机状态与模型并隐藏云端 Key', localUi.localVisible && localUi.keyHidden && localUi.optionCount >= 2)
  await page.evaluate(() => {
    const provider = document.getElementById('set-provider')
    provider.value = 'openai'
    provider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const cloudUi = await page.evaluate(() => ({
    localHidden: document.getElementById('set-local-llm')?.classList.contains('hidden'),
    keyVisible: !document.getElementById('set-cloud-key-wrap')?.classList.contains('hidden')
  }))
  check('切换到云端提供商后表单随之切换', cloudUi.localHidden && cloudUi.keyVisible)
  await page.evaluate(({ baseURL, model }) => {
    const provider = document.getElementById('set-provider')
    provider.value = 'ollama'
    provider.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('set-baseurl').value = baseURL
    document.getElementById('set-model').value = model
    document.getElementById('btn-close-settings')?.click()
  }, { baseURL, model })

  await page.evaluate(() => {
    window.__m6Events = []
    window.nagi.on('agent:event', (event) => window.__m6Events.push(event))
  })
  const first = await withTimeout(page.evaluate(() => window.nagi.chat.send('请用一句简短中文介绍你自己。')), 120000)
  const events = await page.evaluate(() => window.__m6Events)
  check('真实模型流式回复', first.ok && events.some((event) => event.type === 'text-delta') && events.some((event) => event.type === 'done'),
    events.find((event) => event.type === 'done')?.text?.slice(0, 80) || first.error || '')

  await page.evaluate(() => { window.__m6Events = [] })
  const second = await withTimeout(page.evaluate(() => window.nagi.chat.send('请务必调用 file_list 工具列出当前授权目录，再告诉我里面的文件名。')), 120000)
  const toolEvents = await page.evaluate(() => window.__m6Events)
  check('真实模型调用 file_list 并接收结果', second.ok &&
    toolEvents.some((event) => event.type === 'tool-call' && event.name === 'file_list') &&
    toolEvents.some((event) => event.type === 'tool-result' && event.name === 'file_list' && event.ok),
    toolEvents.filter((event) => event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'error').map((event) => JSON.stringify(event)).join(' | ').slice(0, 350))

  const rag = await page.evaluate(() => window.nagi.rag.status())
  check('本地回复进入长期档案流水', rag.chunks + rag.pending >= 2, `chunks=${rag.chunks} pending=${rag.pending}`)
  const journalDir = join(profile, 'journal')
  const journal = existsSync(journalDir) ? readdirSync(journalDir).map((name) => readFileSync(join(journalDir, name), 'utf8')).join('\n') : ''
  check('本地对话写入日记素材流水', journal.includes('请用一句简短中文介绍你自己'))

  for (let n = 0; n < 60 && !logs.includes('[diary] 生成一条'); n++) await sleep(1000)
  const diaryDir = join(profile, 'monologue')
  check('本地模型生成独白并落盘', logs.includes('[diary] 生成一条') && existsSync(diaryDir) && readdirSync(diaryDir).some((name) => name.endsWith('.md')))
  const pendingFile = join(profile, 'rag', 'pending.jsonl')
  const pending = existsSync(pendingFile)
    ? readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const diaryChunk = pending.find((item) => item.kind === 'diary' && item.meta?.kind === 'inner')
  check('新独白进入记忆档案并标注为心里话', !!diaryChunk)
  if (process.env.NAGI_VERIFY_RAG_RECALL === '1' && diaryChunk) {
    const downloaded = await page.evaluate(() => window.nagi.rag.downloadModel())
    check('本机嵌入模型下载完成', downloaded?.ok === true, downloaded?.error || '')
    if (downloaded?.ok) {
      let indexed = false
      for (let n = 0; n < 60; n++) {
        const state = await page.evaluate(() => window.nagi.rag.status())
        if (state.pending === 0 && state.chunks > 0) { indexed = true; break }
        await sleep(1000)
      }
      check('独白已进入本地向量索引', indexed)
      const recalled = await page.evaluate((query) => window.nagi.rag.recallTest(query), diaryChunk.text)
      check('能召回独白且提示词标明心里话边界', recalled?.results?.some((item) => item.kind === 'diary') &&
        recalled?.text?.includes('不要逐字说出'), String(recalled?.text || recalled?.reason || '').slice(0, 180))
    }
  }

  // 在同一 Electron 会话里真实往返一次兼容提供商，验证设置保存与对话路由。
  const fixtureRequests = []
  fixture = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    fixtureRequests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8')
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    response.write('data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '[calm] 兼容提供商已回复。' }, finish_reason: null }]
    }) + '\n\n')
    response.write('data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolve)
  })
  const fixtureURL = `http://127.0.0.1:${fixture.address().port}/v1`
  await page.evaluate(async ({ fixtureURL }) => {
    await window.nagi.secrets.set('llmApiKey', 'fixture-secret')
    document.getElementById('btn-pet-settings')?.click()
    const provider = document.getElementById('set-provider')
    provider.value = 'custom'
    provider.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('set-baseurl').value = fixtureURL
    document.getElementById('set-model').value = 'fixture-model'
    document.getElementById('btn-save-llm')?.click()
  }, { fixtureURL })
  await page.waitForFunction((fixtureURL) => window.nagi.settings.get().then((value) =>
    value.llm?.provider === 'custom' && value.llm?.baseURL === fixtureURL), fixtureURL)
  await page.evaluate(() => { window.__m6Events = [] })
  const compatible = await withTimeout(page.evaluate(() => window.nagi.chat.send('请确认兼容通道可以回复。')), 30000)
  const compatibleEvents = await page.evaluate(() => window.__m6Events)
  check('保存兼容提供商后同会话流式回复', compatible.ok &&
    compatibleEvents.some((event) => event.type === 'text-delta') &&
    compatibleEvents.some((event) => event.type === 'done' && event.text?.includes('兼容提供商已回复')))
  check('兼容通道使用独立保存的 Key 与模型', fixtureRequests.some((request) => {
    try {
      const body = JSON.parse(request.body)
      return request.path === '/v1/chat/completions' && request.authorization === 'Bearer fixture-secret' && body.model === 'fixture-model'
    } catch { return false }
  }))
  check('提供商切换时延续同一段会话历史', fixtureRequests.some((request) => {
    try {
      const body = JSON.parse(request.body)
      return body.messages?.some((message) => message.role === 'user' && message.content?.includes('请用一句简短中文介绍你自己'))
    } catch { return false }
  }))

  await page.evaluate(({ baseURL, model }) => {
    const provider = document.getElementById('set-provider')
    provider.value = 'ollama'
    provider.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('set-baseurl').value = baseURL
    document.getElementById('set-model').value = model
    document.getElementById('btn-save-llm')?.click()
  }, { baseURL, model })
  await page.waitForFunction(({ baseURL, model }) => window.nagi.settings.get().then((value) =>
    value.llm?.provider === 'ollama' && value.llm?.baseURL === baseURL && value.llm?.model === model), { baseURL, model })
  await page.evaluate(() => { window.__m6Events = [] })
  const back = await withTimeout(page.evaluate(() => window.nagi.chat.send('现在请用一句中文确认你已经回来。')), 120000)
  const backEvents = await page.evaluate(() => window.__m6Events)
  check('保留云端 Key 后切回本地仍可对话', back.ok &&
    backEvents.some((event) => event.type === 'text-delta') &&
    backEvents.some((event) => event.type === 'done' && event.text?.length > 0))
  const saved = await page.evaluate(() => window.nagi.settings.get())
  check('往返切换后本地配置仍持久化', saved.llm?.provider === 'ollama' &&
    saved.llm?.baseURL === baseURL && saved.llm?.model === model)
  // connectOverCDP 下不调用 browser.close()，否则会关掉目标 Electron。
} catch (error) {
  console.error('✘ 验收中断：', error.message)
  console.error(logs.slice(-2000))
  process.exitCode = 1
} finally {
  fixture?.closeAllConnections()
  if (fixture) await new Promise((resolve) => fixture.close(resolve))
  if (child?.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
  }
  console.log(`隔离数据：${profile}`)
  console.log(`M6 验收：${checks.filter((item) => item.ok).length}/${checks.length} 通过`)
  if (checks.some((item) => !item.ok)) process.exitCode = 1
}
process.exit(process.exitCode || 0)
