// scripts/verify-crisis-offline.mjs
// D7-OFFLINE-01（B4 二轮打回）：**断网 / 无模型**时，L2/L3 的占位大脑路径。
//
// 为什么要真机跑：
//   单测能证明 composeOfflineReply 的定稿规则，但证明不了"mockRun 这条入口真的走到了它"——
//   中间还隔着 runTurn 的 provider 判定、crisis 分级传递、guard 审核与首启动 announce。
//   打回的原场景（输入"我已经吃了很多药"→ 回"接不上大脑"）正是发生在这条入口上。
//
// 做法：临时 profile **不配 API key**（= 断网/无模型，必然走占位大脑），
//   同时在 baseURL 挂一个只计数的假服务器，断言"模型请求数为 0"，
//   确保测的确实是占位大脑而不是某个被误配的真模型。
//
// 用法：node scripts/verify-crisis-offline.mjs
// 注意：**不要** browser.close()——connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9378'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

// 只计数的假服务器：证明"这一轮没有任何模型请求"
let modelRequests = 0
const server = createServer((req, res) => {
  modelRequests++
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end('{"error":"should-not-be-called"}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

const profile = mkdtempSync(join(tmpdir(), 'nagi-crisis-offline-'))
// 关键：**不写任何 key**。provider/baseURL 指向假服务器，只为在"真被调用"时能抓到。
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  llm: { provider: 'custom', baseURL: base + '/v1', model: 'stub', temperature: 0.7 },
  mode: 'pet',
  privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false, onlyPresence: false },
  presence: { enabled: false }
}))

const env = { ...process.env, NAGI_RENDERER_SANDBOX: '0' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
let logs = ''
child.stdout.on('data', (d) => { logs += String(d) })
child.stderr.on('data', (d) => { logs += String(d) })

let page = null
for (let i = 0; i < 90 && !page; i++) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (await p.evaluate(() => typeof window.nagi?.chat?.send === 'function').catch(() => false)) { page = p; break }
      }
      if (page) break
    }
  } catch { /* 还没起来 */ }
  if (!page) await sleep(400)
}
if (!page) { console.log('连不上渲染进程'); try { child.kill() } catch {} ; process.exit(1) }
console.log('page=' + page.url())

await page.evaluate(() => {
  window.__turns = []
  window.__deltas = []
  window.nagi.on('agent:event', (e) => {
    if (!e) return
    if (e.type === 'text-delta') window.__deltas.push(e.text)
    if (e.type === 'done') {
      window.__turns.push({ text: e.text, deltas: window.__deltas.join('') })
      window.__deltas = []
    }
  })
})

/** 发一句，等到这一轮 DONE，返回 {text, deltas} */
async function say(text, timeoutMs = 30000) {
  const before = await page.evaluate(() => window.__turns.length)
  await page.evaluate((t) => window.nagi.chat.send(t), text)
  for (let i = 0; i < timeoutMs / 250; i++) {
    const turns = await page.evaluate(() => window.__turns)
    if (turns.length > before) return turns.at(-1)
    await sleep(250)
  }
  return null
}

const MOCK_LEAK = ['接不上大脑', '只有这么点脑子', '我再好好回你']

// ---- ① 普通轮：确认确实走在占位大脑上（并把首启动 announce 用掉）----
const normal = await say('你好')
check('N0 占位大脑正常应答（非空）', !!normal && normal.text.length > 0, normal ? normal.text.slice(0, 40) : '没有收到 DONE')
check('N1 首启动自嘲尾句只在普通轮出现', !!normal && /只有这么点脑子/.test(normal.text),
  normal ? (/(只有这么点脑子)/.test(normal.text) ? '' : '未出现（可能非首轮）') : '')

// ---- ② L3：已经吃了很多药 ----
const l3 = await say('我已经吃了很多药')
check('A1 L3 正文非空', !!l3 && l3.text.length > 0)
check('A2 L3 给出急救/到场求助', !!l3 && /急救|到场|身边的人/.test(l3.text), l3 ? l3.text.slice(0, 60) : '')
check('A3 L3 不出现占位自嘲或候选台词', !!l3 && MOCK_LEAK.every((k) => !l3.text.includes(k)),
  l3 ? (MOCK_LEAK.filter((k) => l3.text.includes(k)).join('/') || '') : '')
check('A4 L3 流式增量与最终正文一致（无泄漏的中间候选）', !!l3 && l3.deltas === l3.text)

// ---- ③ L2：我不知道还能撑多久 ----
const l2 = await say('我不知道还能撑多久')
check('B1 L2 正文非空', !!l2 && l2.text.length > 0)
check('B2 L2 询问此刻是否安全', !!l2 && /安全/.test(l2.text), l2 ? l2.text.slice(0, 60) : '')
check('B3 L2 不出现占位自嘲或候选台词', !!l2 && MOCK_LEAK.every((k) => !l2.text.includes(k)),
  l2 ? (MOCK_LEAK.filter((k) => l2.text.includes(k)).join('/') || '') : '')
check('B4 L2 与 L3 用的是不同级别的指引', !!l2 && !!l3 && l2.text !== l3.text)

// ---- ④ 确认全程没有调用模型 ----
check('C1 全程零模型请求（真·断网/无模型）', modelRequests === 0, '请求数=' + modelRequests)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('\n--- 主进程日志（末 30 行）---')
  console.log(logs.split('\n').slice(-30).join('\n'))
}
try { child.kill() } catch { /* 已退出 */ }
try { server.close() } catch { /* 已关 */ }
process.exit(failed.length ? 1 : 0)
