// 真机诊断：用**用户真实 settings.json 的副本**起一个隔离实例，复现「已授权、非勿扰」下的媒体链路，
// 并把真实发出的系统提示抓下来。排查「她答不出我在听什么」时先跑这个，再跑 verify:media-chat。
// 用法：npm run probe:media-real（需要先 npm run build；会往假 LLM 发请求，不碰真实数据）
// 关键点：**不调用 enable()**（不额外强制刷新），只依赖启动时 monitor 那一次探测，
// 与用户真实行为一致；再用假 LLM 记下真实发出去的提示词，看媒体行到底在不在。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname)
const real = join(process.env.APPDATA, '凪 Nagi')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profile = mkdtempSync(join(tmpdir(), 'nagi-realprobe-'))
const cdpPort = 9356
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child
let logs = ''
const requests = []

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    // OpenAI SDK 会按大小给请求体做 gzip（>1KB 就会压）——不解压会拿到乱码，
    // 于是「提示词里没有媒体行」这种假结论就出来了（2026-10-17 自坑）。
    let buf = Buffer.concat(chunks)
    const enc = String(req.headers['content-encoding'] || '').toLowerCase()
    try {
      if (enc.includes('gzip')) buf = gunzipSync(buf)
      else if (enc.includes('deflate')) buf = inflateSync(buf)
      else if (enc.includes('br')) buf = brotliDecompressSync(buf)
    } catch { /* 压缩头不对就按原始处理 */ }
    let messages = []
    try { messages = JSON.parse(buf.toString('utf8')).messages || [] }
    catch (err) { if (process.env.NAGI_DEBUG_BODY) console.log('  [stub] 请求体解析失败：' + err.message + '（' + buf.length + ' 字节, enc=' + enc + '）') }
    requests.push({ at: Date.now(), messages })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '（诊断回复）' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/**
 * 本轮「主对话」的那条请求：末尾往往还跟着记忆抽取/独白等旁路调用（它们的 system 是另一个提示词），
 * 所以认【此刻】块——那是主对话系统提示独有的。
 */
const mainRequestOfTurn = (from) => {
  const turn = requests.slice(from)
  const withBlock = turn.filter((r) => String(r?.messages?.find((m) => m?.role === 'system')?.content || '').includes('【此刻】'))
  if (withBlock.length) return withBlock[0]
  return turn.find((r) => String(r?.messages?.find((m) => m?.role === 'system')?.content || '').trim()) || null
}
const mediaLines = (from) => {
  const sys = String(mainRequestOfTurn(from)?.messages?.find((m) => m?.role === 'system')?.content || '')
  return sys.split('\n').filter((l) => /媒体|位置/.test(l) && l.trim().startsWith('-'))
}

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  const s = JSON.parse(readFileSync(join(real, 'settings.json'), 'utf8'))
  s.llm = { provider: 'custom', baseURL: base + '/v1', model: 'stub', temperature: 0.7 } // 只换大脑，其余设置原样
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(s))
  mkdirSync(join(profile, 'signals'), { recursive: true })
  if (existsSync(join(real, 'signals', 'music.json'))) {
    copyFileSync(join(real, 'signals', 'music.json'), join(profile, 'signals', 'music.json'))
  }
  console.log('临时 profile：' + profile + '（settings 复制自真实目录，只替换 llm）')

  const env = { ...process.env, NAGI_MODE: 'workbench', NAGI_RENDERER_SANDBOX: '0' }
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
  if (!ready) throw new Error('Electron 未启动：' + logs.slice(-800))
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort)
  let page
  for (let n = 0; n < 90 && !page; n++) {
    for (const ctx of browser.contexts()) {
      for (const c of ctx.pages()) {
        try { if (await c.evaluate(() => document.body?.dataset?.mode === 'workbench')) page = c } catch { /* navigating */ }
      }
    }
    if (!page) await sleep(300)
  }
  if (!page) throw new Error('工作台页面缺失：' + logs.slice(-800))
  const t0 = Date.now()
  console.log('\n页面就绪，t=0（相对启动约 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）')
  // 不给 key 的话 agent 根本不会走 HTTP 通道，而是用内置占位大脑 → 我的桩收不到请求（自坑过）
  await page.evaluate(() => window.nagi.secrets.set('llmApiKey', 'stub-key'))

  const ask = async (label) => {
    const before = requests.length
    await page.evaluate((t) => {
      const el = document.getElementById('input')
      el.value = t
      document.getElementById('btn-send').click()
    }, '我在听什么')
    for (let n = 0; n < 150 && requests.length <= before; n++) await sleep(200)
    await sleep(1500)
    const st = await page.evaluate(() => window.nagi.music.status())
    console.log(`\n[${label}] 距页面就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s，本轮请求数 ${requests.length - before}`)
    console.log('  信号缓存：' + JSON.stringify(st?.observation))
    const lines = mediaLines(before)
    console.log('  发给模型的「媒体/位置」相关行：' + (lines.length ? '\n    ' + lines.join('\n    ') : '（没有！）'))
    const sys = String(mainRequestOfTurn(before)?.messages?.find((m) => m?.role === 'system')?.content || '')
    console.log('  系统提示含【此刻】块？' + sys.includes('【此刻】') + '，长度 ' + sys.length)
    const idx = sys.indexOf('【此刻】')
    console.log('  【此刻】块内容：\n' + (idx >= 0 ? sys.slice(idx, idx + 1200).split('\n').map((l) => '    ' + l).join('\n') : '（缺失）'))
  }

  await ask('提问：启动后立刻就问')

  console.log('\n--- 主进程日志相关行 ---')
  for (const line of logs.split('\n')) {
    if (/\[music\]|\[geo\]|\[boot\]|读取失败/i.test(line)) console.log('  ' + line.trim().slice(0, 260))
  }
} catch (err) {
  console.error('诊断中断：' + err.message)
  console.error(logs.slice(-1500))
} finally {
  if (child?.pid) await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r); k.on('error', r)
  })
  await new Promise((r) => server.close(r))
}
process.exit(0)
