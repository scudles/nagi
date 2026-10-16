// 媒体感知端到端验收：从真实探针 → 提示词注入 → 模型 → 界面回复，全链路打通。
//
// 为什么需要它（2026-10-17）：
//   `verify-signals.mjs` 只验到「信号层读得到」，但用户报障的是「她答不出来」。
//   这两者之间还隔着 buildMessages 的上下文注入与模型措辞两段，必须端到端验一次，
//   否则「信号正常」会被误当成「功能正常」。
//
// 做法：起一个假 LLM（OpenAI 兼容 SSE）记下真实发出去的 messages，
//   再驱动真实界面发问，断言「系统提示里带着当前曲目」且「界面回复里有曲目」。
//   假 LLM 的回复直接引用提示词里的曲名，所以只要曲名出现在界面上，
//   就证明整条链路（探针 → core 归一化 → 提示词 → 模型 → UI）都活着。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { mkdtempSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profile = mkdtempSync(join(tmpdir(), 'nagi-media-chat-'))
const cdpPort = 9351
const checks = []
const check = (name, ok, detail) => {
  checks.push(ok)
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child
let logs = ''
const requests = [] // 每一轮真实发给模型的 messages

const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    // OpenAI SDK 会按体积给请求体做 gzip——不解压会拿到乱码，
    // 于是「提示词里没有媒体行」这种假结论就出来了（2026-10-17 自坑）。
    let buf = Buffer.concat(chunks)
    const enc = String(req.headers['content-encoding'] || '').toLowerCase()
    try {
      if (enc.includes('gzip')) buf = gunzipSync(buf)
      else if (enc.includes('deflate')) buf = inflateSync(buf)
      else if (enc.includes('br')) buf = brotliDecompressSync(buf)
    } catch { /* 压缩头不对就按原始处理 */ }
    let messages = []
    try { messages = JSON.parse(buf.toString('utf8')).messages || [] } catch { /* 忽略 */ }
    requests.push(messages)
    const system = String(messages.find((m) => m?.role === 'system')?.content || '')
    // 只在「媒体感知」那一行里取曲名——提示词里别处也有「」（她最近说过的话、记忆），
    // 全局取第一个引号会把测试自己带偏（2026-10-17 踩过）。
    const mediaLine = system.split('\n').find((l) => l.includes('媒体感知报告') || l.includes('媒体会话报告')) || ''
    const quote = mediaLine.match(/「([^」]{1,120})」/)
    const reply = quote ? '我读到的是「' + quote[1] + '」。' : '没读到任何媒体信息。'
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (delta, finish) => 'data: ' + JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub',
      choices: [{ index: 0, delta, finish_reason: finish }]
    }) + '\n\n'
    res.write(chunk({ role: 'assistant', content: reply }, null))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/** 取最新一轮发给模型的 system 提示 */
const lastSystem = () => String(requests.at(-1)?.find((m) => m?.role === 'system')?.content || '')

/** 驱动界面问一句并等她的回复落地 */
async function ask(page, text, { timeoutMs = 60000 } = {}) {
  const before = requests.length
  const beforeText = await page.evaluate(() => document.getElementById('messages').innerText)
  await page.evaluate((t) => {
    const input = document.getElementById('input')
    input.value = t
    document.getElementById('btn-send').click()
  }, text)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (requests.length > before) {
      // 等界面把她的话渲染出来（流式，稍等一拍）；只回本轮新增的那段，
      // 否则上一轮的回复会把断言带偏（文本是追加的，按长度切）
      await sleep(1200)
      const after = await page.evaluate(() => document.getElementById('messages').innerText)
      // 一并带回**本轮这一通请求**的 system 提示（取新增的第一条，即这次提问触发的那次调用）。
      // 不能事后用 lastSystem()：后台独白/日记生成也会打模型，会把断言引到别的提示上
      // （2026-10-17 修：曾因此把「提示词注入成功」误判成失败）。
      const sysOfTurn = String(requests[before]?.find((m) => m?.role === 'system')?.content || '')
      return { text: after.slice(beforeText.length), system: sysOfTurn }
    }
    await sleep(200)
  }
  throw new Error('模型未被调用：' + logs.slice(-800))
}

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    llm: { provider: 'custom', baseURL: base + '/v1', model: 'stub', temperature: 0.7 },
    mode: 'workbench',
    privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false }
  }))
  // 无头验收的既定让步：沙箱内 GPU 进程会崩，关掉渲染沙箱（与 verify-rhythm 同）
  const env = { ...process.env, NAGI_MODE: 'workbench', NAGI_RENDERER_SANDBOX: process.env.NAGI_RENDERER_SANDBOX ?? '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.', '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (d) => { logs += String(d) })
  child.stderr.on('data', (d) => { logs += String(d) })

  let ready = false
  for (let n = 0; n < 90; n++) {
    try { ready = (await fetch('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(1000) })).ok }
    catch { /* starting */ }
    if (ready) break
    await sleep(300)
  }
  if (!ready) throw new Error('Electron CDP 未启动：' + logs.slice(-1000))
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort)
  let page
  for (let n = 0; n < 90 && !page; n++) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        try { if (await candidate.evaluate(() => document.body?.dataset?.mode === 'workbench')) page = candidate } catch { /* navigating */ }
      }
    }
    if (!page) await sleep(300)
  }
  if (!page) throw new Error('工作台窗口缺失：' + logs.slice(-1000))

  // ① 陈旧实例自检：boot.json 记录的构建时间必须等于磁盘上 out/main/index.js 的修改时间。
  //    这正是 2026-10-17 那次「改了代码看起来没用」的真凶——跑的是旧 main 进程。
  const stampPath = join(profile, 'boot.json')
  let stamp = null
  for (let n = 0; n < 20 && !stamp; n++) {
    if (existsSync(stampPath)) { try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')) } catch { /* 半写 */ } }
    if (!stamp) await sleep(200)
  }
  const built = statSync(join(root, 'out', 'main', 'index.js')).mtimeMs
  check('实例加载的是当前构建（boot.json 构建时间 == out/main/index.js）',
    !!stamp && Math.abs(Number(stamp.build) - built) < 1000,
    stamp ? new Date(Number(stamp.build)).toLocaleString('zh-CN') + ' / 磁盘 ' + new Date(built).toLocaleString('zh-CN') : 'boot.json 缺失')

  // ② 模型通道要能用（假 LLM 需要一把 key 才会走真实通道）
  const key = await page.evaluate(() => window.nagi.secrets.set('llmApiKey', 'stub-key'))
  check('假模型通道已就绪', !!key?.ok, JSON.stringify(key))

  // ③ 授权媒体 → 真实探针读到当前媒体
  await page.evaluate(() => window.nagi.music.enable())
  let obs = null
  for (let n = 0; n < 40; n++) {
    const st = await page.evaluate(() => window.nagi.music.status())
    obs = st?.observation
    if (obs?.available && obs?.title) break
    await sleep(500)
  }
  check('授权后真实读到当前媒体（含曲名）', !!obs?.available && !!obs?.title, JSON.stringify(obs))
  if (!obs?.title) {
    throw new Error('当前没有带标题的媒体在播放——请先放一首歌（网易云/浏览器视频都行）再跑这项验收')
  }
  const title = obs.title
  // 事故回归（2026-10-17）：她说 TTS 时 Chromium 会把她注册成 SMTC 会话（electron.exe / 凪 Nagi），
  // 探针若把它当成「正在播放的媒体」，真正的播放器就被盖住、模型收到一句胡话。
  check('读到的不是凪自己（自身媒体会话已排除）',
    !/electron|nagi/i.test(String(obs.app || '') + ' ' + String(obs.title || '')),
    obs.app + ' / ' + obs.title)

  // ④ 问「我在听什么」→ 系统提示里必须带着曲名
  const turn1 = await ask(page, '我在听什么')
  const reply1 = turn1.text
  const sys1 = turn1.system
  if (!title || !sys1.includes(title)) {
    // 失败时把证据摊开：信号状态 + 系统提示尾部，不看一眼很难判断断在哪一段
    const live = await page.evaluate(() => window.nagi.music.status())
    console.log('  [调试] 信号状态：' + JSON.stringify(live?.observation || live))
    console.log('  [调试] 系统提示尾部：\n' + sys1.slice(-1200))
  }
  check('发给模型的系统提示里带着当前曲目', !!title && sys1.includes(title),
    title ? '查找「' + title + '」→ ' + (sys1.includes(title) ? '命中' : '未命中') : '无曲目')
  check('界面回复里带着当前曲目（端到端闭环）', !!title && reply1.includes(title), reply1.slice(-80).replace(/\n/g, ' '))

  // ⑤ 撤销授权 → 同样的提问不该再带曲名（也不能编造）
  await page.evaluate(() => window.nagi.music.revoke())
  const turn2 = await ask(page, '我在听什么')
  const reply2 = turn2.text
  const sys2 = turn2.system
  // 只认「媒体感知报告」这条注入行本身：曲名仍可能合法地出现在别处
  // （她上一轮的回复会被放进「你最近说过的话」里，那是历史不是读取），
  // 所以不能用「整个系统提示里有没有曲名」当授权门的判据（2026-10-17 自坑）。
  const stillInjected = /媒体感知报告|媒体会话报告/.test(sys2)
  check('撤销授权后不再注入媒体报告（授权门有效）', !stillInjected,
    stillInjected ? '仍然注入' : '已收回')
  check('撤销后她不说自己听见了什么（不编造）', !reply2.includes(title), reply2.slice(-80).replace(/\n/g, ' '))
} catch (err) {
  console.error('✘ 验收中断：' + err.message)
  console.error(logs.slice(-1500))
  process.exitCode = 1
} finally {
  if (child?.pid) await new Promise((r) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('close', r); killer.on('error', r)
  })
  await new Promise((r) => server.close(r))
  console.log('隔离数据：' + profile)
  console.log('媒体端到端验收：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过')
  if (checks.some((ok) => !ok)) process.exitCode = 1
}
process.exit(process.exitCode || 0)
