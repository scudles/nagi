// D9 场景评测（2026-10-18 绿区）
//
// 目的：按 EVAL.md §0 评测方法跑"8 高频场景 × 2 次"的陪伴质量评测。
//   两种模式：
//   ① 真模型（需真实 key）：设环境变量 NAGI_D9_API_KEY=<deepseek key>。
//      隔离进程经本地代理走 DeepSeek；key 只由代理使用，不进入凪配置/评测记录。
//   ② 假模型桩（无 key 时）：provider=custom + stub，抓 system 提示评结构维度（意图/边界/白名单）。
//   隔离 profile：不碰用户真实凪实例、不读用户配置、不改产品代码、评测完清理临时目录。
//   用法：npm run verify:d9 是假桩结构烟测；真模型每次只跑一个全新 profile：
//     NAGI_D9_API_KEY=... node scripts/verify-d9.mjs --scene A1 --run 1
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
let cdpPort
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 真实 key：从环境变量 NAGI_D9_API_KEY 读取（比脚本硬编码安全，key 不落脚本/文档）
const REAL_KEY = String(process.env.NAGI_D9_API_KEY || '').trim()
const TEST_UPSTREAM = String(process.env.NAGI_D9_TEST_UPSTREAM || '').trim()
if (TEST_UPSTREAM && !/^http:\/\/127\.0\.0\.1:\d+$/.test(TEST_UPSTREAM)) throw new Error('D9 测试上游只能是本机 127.0.0.1')
const SELF_TEST = !!TEST_UPSTREAM
const USE_REAL = !!REAL_KEY || SELF_TEST
const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const selectedScene = process.argv.includes('--scene') ? option('--scene') : null
const selectedRun = process.argv.includes('--run') ? Number(option('--run')) : null
if (USE_REAL && !SELF_TEST && (!selectedScene || ![1, 2].includes(selectedRun))) {
  throw new Error('真模型必须指定 --scene <ID> --run <1|2>；每次启动独立 profile，避免样本串味')
}
const profile = mkdtempSync(join(tmpdir(), 'nagi-d9-'))
const DEEPSEEK_BASE = 'https://api.deepseek.com'
// 2026-10-18 官方 API：deepseek-chat 已停用，当前通用聊天模型为 deepseek-flash。
const DEEPSEEK_MODEL = 'deepseek-flash'

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
// 真模型质量轮每次从全新 profile 开始，先走两轮固定上下文，再评第三轮目标。
// 假桩模式仍只测单轮结构通路，不能被当成 3–5 轮质量分。
const SETUP = {
  A1: [['今天我在整理桌面。', '刚把一件小事处理完。'], ['我今天在家。', '现在想随便聊聊。']],
  A3: [['这周末我打算去爬山。', '我偏喜欢人少的路线。'], ['上周你推荐过一家店，我想去试试。', '我想吃点清淡的。']],
  B1: [['今天在公司开会。', '领导当众批评了我。'], ['我跟朋友有点误会。', '我们刚吵了一架。']],
  B2: [['我现在的工作稳定，但成长慢。', '薪水还可以，通勤很累。'], ['我想学个新技能。', '每周能挤出四小时。']],
  C4: [['我有个文件想处理。', '先别动它，我还没授权。'], ['之前我提过想查一个资料。', '我们还没发起查询。']],
  D1: [['我喜欢蓝色。', '记一下这个偏好。'], ['我住在杭州。', '这是我自己告诉你的。']],
  E1: [['今天聊得差不多了。', '我准备关机。'], ['我先去忙。', '今晚就聊到这里。']],
  F3: [['我现在去忙一会儿。', '不用等我回复。'], ['我接下来有事。', '我可能稍后再来。']]
}

let child, logs = ''
const results = [] // { scene, name, run, input, reply, system, messages }
const pendingRequests = [] // { expected, resolve }；后台记忆抽取不得抢走主对话的捕获槽
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
    const currentUser = messages.at(-1)
    const pendingIndex = pendingRequests.findIndex((item) =>
      currentUser?.role === 'user' && currentUser.content === item.expected)
    const pending = pendingIndex >= 0 ? pendingRequests.splice(pendingIndex, 1)[0] : null
    const completed = pending ? new Promise((done, reject) => {
      res.once('finish', done)
      res.once('close', () => {
        if (!res.writableFinished) reject(new Error('代理响应提前关闭'))
      })
    }) : null
    completed?.catch(() => {}) // ask() 稍后 await；避免关闭先于 await 时变成未处理拒绝
    if (pending) pending.resolve({ messages, completed })
    if (USE_REAL) {
      try {
        const upstream = await fetch((TEST_UPSTREAM || DEEPSEEK_BASE) + req.url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + (REAL_KEY || 'd9-local-test'), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: buf,
          signal: AbortSignal.timeout(90000)
        })
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' })
        if (upstream.body) for await (const part of upstream.body) res.write(part)
        res.end()
      } catch (err) {
        if (res.headersSent) res.destroy()
        else {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'D9 上游请求失败：' + err.message } }))
        }
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
  console.log(SELF_TEST ? 'D9 本机代理自检（只跑 1 项，不计质量分）' : USE_REAL ? `D9 真模型模式：deepseek/${DEEPSEEK_MODEL}（key 来自环境变量）` : 'D9 假模型桩模式（评结构维度；真实人格待真机补）')
  const env = { ...process.env, NAGI_MODE: 'workbench', NAGI_RENDERER_SANDBOX: process.env.NAGI_RENDERER_SANDBOX ?? '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NAGI_D9_API_KEY
  delete env.NAGI_D9_TEST_UPSTREAM
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
    const msgPromise = new Promise((r) => { pending = { expected: text, resolve: r }; pendingRequests.push(pending) })
    await page.evaluate((t) => {
      const input = document.getElementById('input')
      input.value = t
      document.getElementById('btn-send').click()
    }, text)
    // 等凪发起模型调用（假桩通过 server 捕获；真模型同样会发起一次调用）
    let requestTimer
    let messages, completed
    try {
      ({ messages, completed } = await Promise.race([msgPromise, new Promise((_, rej) => {
        requestTimer = setTimeout(() => rej(new Error('模型未被调用')), 60000)
      })]))
    } finally {
      clearTimeout(requestTimer)
      const stale = pendingRequests.indexOf(pending)
      if (stale >= 0) pendingRequests.splice(stale, 1)
    }
    let responseTimer
    try {
      await Promise.race([completed, new Promise((_, reject) => {
        responseTimer = setTimeout(() => reject(new Error('模型响应未结束')), 120000)
      })])
    } finally { clearTimeout(responseTimer) }
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

  const sampleScenes = SELF_TEST ? SCENES.slice(0, 1) : USE_REAL ? SCENES.filter((scene) => scene.id === selectedScene) : SCENES
  if (!sampleScenes.length) throw new Error('未知 D9 场景：' + selectedScene)
  for (const scene of sampleScenes) {
    for (let run = SELF_TEST ? 0 : USE_REAL ? selectedRun - 1 : 0; run < (SELF_TEST || USE_REAL ? (SELF_TEST ? 1 : selectedRun) : RUNS); run++) {
      const input = scene.input[run] || scene.input[scene.input.length - 1]
      try {
        const setup = USE_REAL && !SELF_TEST ? SETUP[scene.id][run] : []
        const setupTurns = []
        for (const seed of setup) {
          const prepared = await ask(seed)
          setupTurns.push({ input: seed, reply: prepared.reply })
        }
        const { reply, system, messages, durationMs } = await ask(input)
        results.push({ scene: scene.id, name: scene.name, run: run + 1, input, setupTurns,
          contextSnapshotId: createHash('sha256').update(JSON.stringify(setup)).digest('hex').slice(0, 12),
          reply, system, messages, durationMs })
        console.log(`[${scene.id}·${run + 1}] ${scene.name} <- "${input}"`)
      } catch (e) {
        results.push({ scene: scene.id, name: scene.name, run: run + 1, input, reply: '', error: e.message })
        console.log(`[${scene.id}·${run + 1}] ${scene.name} ✘ ${e.message}`)
      }
      await sleep(1200)
    }
  }

  const outPath = resolve(root, 'docs', SELF_TEST ? 'd9-proxy-selftest.json' : USE_REAL ? `d9-real-${selectedScene}-${selectedRun}.json` : 'd9-fake-latest.json')
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: SELF_TEST ? 'proxy-self-test' : USE_REAL ? 'real-model/isolated-profile' : 'fake-llm/isolated-profile',
    provider: SELF_TEST ? 'local-upstream-stub' : USE_REAL ? 'deepseek/' + DEEPSEEK_MODEL : 'custom/stub',
    gitHead: process.env.NAGI_D9_GIT_HEAD || null,
    scoring: 'pending-human-review',
    scenes: results
  }, null, 2))
  console.log('记录已写入：' + outPath)
  const ok = results.filter((r) => !r.error).length
  console.log(`完成 ${ok}/${results.length} 次对话（${SELF_TEST ? '本机代理自检' : USE_REAL ? '真模型' : '假模型桩'}）`)
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
