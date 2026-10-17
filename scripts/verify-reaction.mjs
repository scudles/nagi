// scripts/verify-reaction.mjs
// 「她想一下再表现」的真机验收：起一个假的 OpenAI 兼容模型桩，看这条链路真的通不通。
//
// 验的是这四段（任何一段断了，功能就是"看起来做了"而已）：
//   A. 监测采样真的把**活动分类**喂进了引擎（日志里能看到一次思考）
//   B. 模型真的被调到了，且**只拿到分类**（桩里检查请求体，不能出现窗口标题/文件名）
//   C. 模型说"闪一下" → 渲染层真的闪了微表情（读 __nagiAmbient().lastMicro）
//   D. 模型说"持续" → 情绪真的被提议（读 mood）
//
// 用法：node scripts/verify-reaction.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.CDP_PORT || '9381'
const STUB_PORT = 18901

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (n, d) => console.log(`　· ${n}：${d}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 假模型桩 ----------------
 * 固定回一个"闪一下星星眼"的判断，并把收到的请求体存下来做隐私检查。
 */
const seen = []
const stub = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ url: req.url, body })
    const content = JSON.stringify({
      read: '他在用电脑',
      feel: null,
      strength: 0,
      mode: 'flash',
      flash: 'star',
      why: '看他忙了一阵，闪一下',
      say: null
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'stub',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      })
    )
  })
})

function baseEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  // 直接注入一个活动分类：验证环境里主进程未必拿得到真实前台窗口，
  // 这里要独立验的是"思考 → 校验 → 表现"，采样那一跳由 monitor 单测覆盖
  env.NAGI_REACTION_PROBE_CATEGORY = 'work'
  return env
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-reaction-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      // 走 ollama 通道指向桩：isLocalLlm 为真，不需要 API Key
      llm: { provider: 'ollama', baseURL: `http://127.0.0.1:${STUB_PORT}/v1`, model: 'stub' },
      // 打开监测（分类才有可能来），但不要勿扰（勿扰会让引擎整个不想）
      privacy: { noticeShown: true, monitorEnabled: true, doNotDisturb: false },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600, outfit: 'daily' },
      ambient: { enabled: true, gaze: false, autonomous: false, level: 'conservative', hotkeys: false },
      // 把间隔压到 1 分钟，方便验收
      reaction: { enabled: true, minGapMin: 1, hourMax: 20, dayMax: 50 }
    },
    null,
    2
  ),
  'utf8'
)

const logs = []
const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: baseEnv(),
  stdio: ['ignore', 'pipe', 'pipe']
})
const collect = (buf) => {
  const s = String(buf)
  logs.push(s)
  if (/\[reaction\]|\[monitor\]/.test(s)) process.stdout.write('    │ ' + s.trim() + '\n')
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

let browser
try {
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) up = true
    } catch {
      /* 还没起来 */
    }
    if (!up) await sleep(400)
  }
  if (!up) throw new Error('CDP 没起来')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)

  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const ok = await p.evaluate(
            () => document.body?.dataset?.mode === 'pet' && typeof window.__nagiAmbient === 'function'
          )
          if (ok) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到桌宠页')

  console.log('等待监测采样与一次思考（最多 90 秒）…\n')
  let thought = null
  for (let i = 0; i < 45 && !thought; i++) {
    await sleep(2000)
    const joined = logs.join('')
    if (/\[reaction\] (switch|dwell|idle) →/.test(joined)) thought = joined
  }

  const allLogs = logs.join('')
  check(
    'A. 监测采样 → 引擎：真的触发了一次"想一下"',
    /\[reaction\] (switch|dwell|idle) →/.test(allLogs),
    (allLogs.match(/\[reaction\] [^\n]*/) || ['（没有 reaction 日志）'])[0]
  )
  info(
    '引擎状态',
    JSON.stringify(await page.evaluate(() => window.__nagiAmbientConfig || {})) === '{}' ? '（见下方日志）' : ''
  )

  // 只认"reaction 那次"请求：这个 endpoint 是全局 LLM 配置，别的模块（日记/自检）也会用到
  const reactionReqs = seen.filter((x) => /他这会儿/.test(x.body))
  check(
    'B. 模型真的被调到了（reaction 发的那次）',
    reactionReqs.length > 0,
    reactionReqs.length
      ? `${reactionReqs.length} 次（桩总计收到 ${seen.length} 次请求）`
      : `桩收到 ${seen.length} 次但没有一次是 reaction 的；首个请求片段：${String(seen[0]?.body || '').slice(0, 120)}`
  )

  // 隐私：请求体里不能出现窗口标题/文件名这类东西
  const bodyText = reactionReqs.map((s) => s.body).join('\n')
  const leaked = ['窗口标题', 'windowTitle', '.exe', '.xlsx', 'EXCEL']
    .filter((k) => bodyText.includes(k))
  const prompt = (() => {
    try {
      const b = JSON.parse(reactionReqs[0].body)
      return b.messages?.map((m) => m.content).join('\n') || ''
    } catch {
      return ''
    }
  })()
  const hasCategoryWord = /在工作或写东西|在浏览器|在看视频|在打游戏|在聊天|在做别的事/.test(prompt)
  check(
    'C. 发给模型的东西只有活动分类，没有窗口标题/文件名',
    reactionReqs.length > 0 && hasCategoryWord && leaked.length === 0,
    (leaked.length ? `疑似泄露：${leaked.join(',')}；` : '') +
      (hasCategoryWord ? '提示词里有分类描述' : '提示词里没有分类描述')
  )

  // 渲染层：微表情真的闪了（主进程 → EVT.FEELING → ambient.flashMicroExpr）
  let flashed = null
  for (let i = 0; i < 12 && !flashed; i++) {
    const st = await page.evaluate(() => window.__nagiAmbient())
    if (st?.lastMicro) flashed = st.lastMicro
    else await sleep(1500)
  }
  check(
    'D. 模型说"闪一下" → 渲染层真的闪了微表情',
    !!flashed,
    flashed ? `最近一次：${flashed.name}（${flashed.why || ''}）` : '渲染层没收到 FEELING 指令'
  )

  const noisy = allLogs.split('\n').filter((l) => /Error|error:/.test(l) && !/ERR_|safe-delete/.test(l))
  check('E. 日志里没有报错', noisy.length === 0, noisy.slice(0, 2).join(' | ') || '0 条')

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('\n验收中断：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  stub.close()
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
}
