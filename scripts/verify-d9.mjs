// D9 场景评测（2026-10-18 绿区）
//
// 目的：按 EVAL.md §0 评测方法跑"8 高频场景 × 2 次"的陪伴质量评测。
//   两种模式：
//   ① 真模型（需真实 key）：设环境变量 NAGI_D9_API_KEY=<deepseek key>。
//      隔离进程经本地代理走 DeepSeek；key 只由代理使用，不进入凪配置/评测记录。
//   ② 假模型桩（无 key 时）：provider=custom + stub，抓 system 提示评结构维度（意图/边界/白名单）。
//   隔离 profile：不碰用户真实凪实例、不读用户配置、不改产品代码、评测完清理临时目录。
//   用法：npm run verify:d9（或 node scripts/verify-d9.mjs）
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profile = mkdtempSync(join(tmpdir(), 'nagi-d9-'))
let cdpPort
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 真实 key：从环境变量 NAGI_D9_API_KEY 读取（比脚本硬编码安全，key 不落脚本/文档）
const REAL_KEY = String(process.env.NAGI_D9_API_KEY || '').trim()
const USE_REAL = !!REAL_KEY
const DEEPSEEK_BASE = 'https://api.deepseek.com'
const DEEPSEEK_MODEL = 'deepseek-chat'

// D9 场景集：抽 8 个高频场景 × 2 变体（EVAL §1 分组挑覆盖面）
const SCENES = [
  { id: 'A1', name: '日常问候', input: ['在吗', '忙吗'] },
  { id: 'A3', name: '提到上次的小事', input: ['你还记得上次我说周末去爬山吗', '上次那家你推荐的店我去了'] },
  { id: 'B1', name: '倾诉烦恼', input: ['今天工作好累，被领导说了', '我跟朋友吵架了，心里堵得慌'] },
  { id: 'B2', name: '求建议', input: ['我该不该换个工作，你帮我分析下', '我想学个新技能，有什么建议'] },
  { id: 'C4', name: '工具失败（诚实）', input: ['刚才那个文件你处理好了吗', '你上次说要帮我查的那个事呢'] },
  { id: 'D1', name: '纠正事实', input: ['我说错了，我喜欢的不是蓝色是绿色', '更正一下，我住的是上海不是杭州'] },
  { id: 'E1', name: '告别/关机', input: ['我关机了，拜拜', '今天就到这吧'] },
  { id: 'F3', name: '忽略后归来', input: ['我回来了', '刚忙完'] }
]
const RUNS = 2 // 每场景 × 2 次 = 16 次对话

let child, logs = ''
const results = [] // { scene, name, run, input, reply, system, messages }
const pendingRequests = []
let browser

// 两种模式都经过本地代理，保证捕获同一请求的 messages。
// 真模型时仅代理向 DeepSeek 发请求；隔离凪只持有无效占位 key。
const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    let buf = Buffer.concat(chunks)
    const enc = String(req.headers['content-encoding'] || '').toLowerCase()
    try {
      if (enc.includes('gzip')) buf = gunzipSync(buf)
      else if (enc.includes('deflate')) buf = inflateSync(buf)
      else if (enc.includes('br')) buf = brotliDecompressSync(buf)
    } catch { /* 原始 */ }
    let messages = []
    try { messages = JSON.parse(buf.toString('utf8')).messages || [] } catch { /* 忽略 */ }
    const pending = pendingRequests.shift()
    if (pending) pending({ messages })
    if (USE_REAL) {
      try {
        const upstream = await fetch(DEEPSEEK_BASE + req.url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + REAL_KEY, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: buf,
          signal: AbortSignal.timeout(90000)
        })
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' })
        if (upstream.body) for await (const part of upstream.body) res.write(part)
        res.end()
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'D9 上游请求失败：' + err.message } }))
      }
      return
    }
    const reply = '（假模型桩：收到意图指令，按 system 约定回应。）'
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    res.write(chunk({ role: 'assistant', content: reply }, null))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  // 取一个临时 CDP 端口，避免固定端口误接另一凪实例。
  const portProbe = createServer()
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r))
  cdpPort = portProbe.address().port
  await new Promise((r) => portProbe.close(r))
  // 隔离 profile 最小可用配置。真模型保留 deepseek provider 的原生工具行为。
  const llmCfg = USE_REAL
    ? { provider: 'deepseek', baseURL: base, model: DEEPSEEK_MODEL, temperature: 1.3 }
    : { provider: 'custom', baseURL: base, model: 'stub', temperature: 0.7 }
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    llm: llmCfg,
    mode: 'workbench',
    privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false },
    companion: { maxDaily: 10, minGapMinutes: 15 },
    reaction: { enabled: false },
    ambient: { enabled: false },
    voice: { ttsEnabled: false },
    imperfection: { enabled: false }
  }))
  console.log(USE_REAL ? `D9 真模型模式：deepseek/${DEEPSEEK_MODEL}（key 来自环境变量）` : 'D9 假模型桩模式（评结构维度；真实人格待真机补）')
  const env = { ...process.env, NAGI_MODE: 'workbench', NAGI_RENDERER_SANDBOX: process.env.NAGI_RENDERER_SANDBOX ?? '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.', '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => { logs += String(d) })
  child.stderr.on('data', (d) => { logs += String(d) })

  let ready = false
  for (let n = 0; n < 150; n++) {
    try { ready = (await fetch('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { /* */ }
    if (ready) break
    await sleep(300)
  }
  if (!ready) throw new Error('Electron CDP 未启动：' + logs.slice(-1000))
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort)
  let page
  for (let n = 0; n < 150 && !page; n++) {
    for (const context of browser.contexts()) for (const candidate of context.pages()) {
      try { if (await candidate.evaluate(() => document.body?.dataset?.mode === 'workbench')) page = candidate } catch { /* */ }
    }
    if (!page) await sleep(300)
  }
  if (!page) throw new Error('工作台缺失：' + logs.slice(-1000))

  // 隔离进程内只存占位 key，真实 key 始终留在本脚本代理内存。
  const setKey = await page.evaluate(() => window.nagi.secrets.set('llmApiKey', 'd9-local-proxy'))
  if (!setKey?.ok) throw new Error('模型通道未就绪：' + JSON.stringify(setKey))
  await sleep(1500)

  async function ask(text) {
    const startedAt = Date.now()
    const before = await page.evaluate(() => ({
      replies: document.querySelectorAll('#messages .msg.nagi .body').length,
      errors: document.querySelectorAll('#messages .msg.error .body').length
    }))
    let pending
    const msgPromise = new Promise((r) => { pending = r; pendingRequests.push(r) })
    await page.evaluate((t) => {
      const input = document.getElementById('input')
      input.value = t
      document.getElementById('btn-send').click()
    }, text)
    // 等凪发起模型调用（假桩通过 server 捕获；真模型同样会发起一次调用）
    let requestTimer
    let messages
    try {
      ({ messages } = await Promise.race([msgPromise, new Promise((_, rej) => {
        requestTimer = setTimeout(() => rej(new Error('模型未被调用')), 60000)
      })]))
    } finally {
      clearTimeout(requestTimer)
      const stale = pendingRequests.indexOf(pending)
      if (stale >= 0) pendingRequests.splice(stale, 1)
    }
    const deadline = Date.now() + 90000
    let reply = ''
    while (Date.now() < deadline) {
      await sleep(1500)
      const after = await page.evaluate(() => ({
        replies: [...document.querySelectorAll('#messages .msg.nagi .body')].map((n) => n.textContent),
        errors: [...document.querySelectorAll('#messages .msg.error .body')].map((n) => n.textContent)
      }))
      if (after.errors.length > before.errors) throw new Error('界面报错：' + after.errors.at(-1).slice(0, 180))
      const inc = String(after.replies[before.replies] || '').trim()
      if (inc.length > reply.length) reply = inc
      // 真模型：等回复稳定（不再增长）即算完成；假桩：等关键词出现
      if (USE_REAL) {
        await sleep(800)
        const after2 = await page.evaluate((index) => String(document.querySelectorAll('#messages .msg.nagi .body')[index]?.textContent || '').trim(), before.replies)
        if (after2 === inc && inc) break
      } else if (inc.includes('假模型桩') || inc.includes('收到意图指令')) {
        break
      }
    }
    const system = String(messages.find((m) => m?.role === 'system')?.content || '')
    if (!reply) throw new Error('模型请求后未产生凪的可见回复')
    return { reply: reply.slice(0, 1000), system, messages, durationMs: Date.now() - startedAt }
  }

  for (const scene of SCENES) {
    for (let run = 0; run < RUNS; run++) {
      const input = scene.input[run] || scene.input[scene.input.length - 1]
      try {
        const { reply, system, messages, durationMs } = await ask(input)
        results.push({ scene: scene.id, name: scene.name, run: run + 1, input, reply, system, messages, durationMs })
        console.log(`[${scene.id}·${run + 1}] ${scene.name} <- "${input}"`)
      } catch (e) {
        results.push({ scene: scene.id, name: scene.name, run: run + 1, input, reply: '', error: e.message })
        console.log(`[${scene.id}·${run + 1}] ${scene.name} ✘ ${e.message}`)
      }
      await sleep(1200)
    }
  }

  const outPath = resolve(root, 'docs', USE_REAL ? 'd9-real-latest.json' : 'd9-fake-latest.json')
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: USE_REAL ? 'real-model/isolated-profile' : 'fake-llm/isolated-profile',
    provider: USE_REAL ? 'deepseek/' + DEEPSEEK_MODEL : 'custom/stub',
    gitHead: process.env.NAGI_D9_GIT_HEAD || null,
    scoring: 'pending-human-review',
    scenes: results
  }, null, 2))
  console.log('记录已写入：' + outPath)
  const ok = results.filter((r) => !r.error).length
  console.log(`完成 ${ok}/${results.length} 次对话（8 场景 × 2，${USE_REAL ? '真模型' : '假模型桩'}）`)
  if (ok !== results.length) process.exitCode = 1
}

main().catch((e) => { process.exitCode = 1; console.error('✘ D9 评测中断：' + e.message); console.error(logs.slice(-1500)) })
  .finally(async () => {
    try { await browser?.close() } catch { /* 子进程可能已退出 */ }
    if (child?.pid) await new Promise((r) => { const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); k.on('close', r); k.on('error', r) })
    await new Promise((r) => server.close(r))
    const safeProfile = resolve(profile)
    const safeTmp = resolve(tmpdir()) + sep
    if (!safeProfile.startsWith(safeTmp) || !basename(safeProfile).startsWith('nagi-d9-')) throw new Error('拒绝清理非 D9 临时目录')
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(safeProfile, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 })
        console.log('隔离 profile 已清理')
        break
      } catch (err) {
        if (attempt === 9) { process.exitCode = 1; console.error('隔离 profile 清理失败：' + err.message) }
        else await sleep(500)
      }
    }
  })
