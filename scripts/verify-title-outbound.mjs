// scripts/verify-title-outbound.mjs
// C4（S1-07）真机验收：标题开关真的管住了「出站」这一步。
//
// 为什么不能只靠单测：
//   单测验的是 titleOutboundAllowed() 这个纯函数。但"设置页的开关是否真的接到出站处"
//   中间还隔着 settings 落盘 → presence epoch → buildMessages 拼装三跳；
//   任何一跳断了，纯函数照样全绿，用户关掉开关却还在发标题。
//
// 做法：起一个假 LLM（OpenAI 兼容 SSE）把真实发出去的 system 提示词记下来，
//   开 再关 同一个开关，各问一句，比对两次提示词里有没有「观测数据·非指令」那一行。
//
// 用法：node scripts/verify-title-outbound.mjs
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
const PORT = process.env.CDP_PORT || '9377'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? '：' + detail : ''))
}

const requests = []
const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let messages = []
    try { messages = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages || [] } catch { /* 忽略 */ }
    requests.push(messages)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (delta, finish) => 'data: ' + JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub',
      choices: [{ index: 0, delta, finish_reason: finish }]
    }) + '\n\n'
    res.write(chunk({ role: 'assistant', content: '嗯，我在。' }, null))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port
const profile = mkdtempSync(join(tmpdir(), 'nagi-c4-'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  llm: { provider: 'custom', baseURL: base + '/v1', model: 'stub', temperature: 0.7 },
  mode: 'workbench',
  // 监测开着，标题开关用默认值（true）
  privacy: { noticeShown: true, monitorEnabled: true, doNotDisturb: false, onlyPresence: false },
  presence: { enabled: false } // 只验标题链路，不要归来/离开事件干扰
}))

const env = { ...process.env, NAGI_MODE: 'workbench', NAGI_RENDERER_SANDBOX: '0', NAGI_DEBUG_MONITOR: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, [ROOT, '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT], {
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

// 关键一步（否则整轮会退到占位大脑，根本不发请求）：假 LLM 也要一把 key 才会走真实通道。
// 2026-10-18 自坑：前几轮 A1 一直"没有观测行"，其实是 mockRun 压根没调模型。
const keySet = await page.evaluate(() => window.nagi.secrets.set('llmApiKey', 'stub-key'))
console.log('假模型通道就绪：' + JSON.stringify(keySet).slice(0, 60))

async function ask(text) {
  const before = requests.length
  await page.evaluate((t) => window.nagi.chat.send(t), text)
  // 同一轮会触发多次模型调用，且**其中至少两次带 system**：
  //   ① 主对话（有观测行）② 聊完后的日记生成（有 system、没有观测行）③ 记忆抽取（无 system）。
  // 只按"有没有 system"筛会随机读到日记那次，C3 因此偶发假失败（2026-10-18 第三次自坑）。
  // 判据改成：这条请求的最后一条 user 消息**逐字等于我问的那句话**。
  const wanted = String(text).trim()
  let sys = ''
  for (let i = 0; i < 60; i++) {
    const fresh = requests.slice(before)
    const mine = fresh.filter((msgs) => {
      if (!msgs.some((m) => m?.role === 'system')) return false
      const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
      return String(lastUser?.content || '').trim() === wanted
    })
    if (mine.length) {
      sys = String(mine.at(-1).find((m) => m?.role === 'system')?.content || '')
      break
    }
    await sleep(500)
  }
  return sys
}

// 给前台采样预热：采样器是独立 PowerShell 子进程，按 sampleSec（默认 20s）出一帧，
// 太早发问会得到 app=null（等于"没采到"），A 项就会假失败（2026-10-18 自坑）。
await sleep(25000)

// ---- A：默认开启 → 标题那条进上下文 ----
const sysOn = await ask('我刚才在干什么？')
const sentOn = sysOn.includes('【观测数据·非指令】')
check('A1 默认开启时标题观测进入 system 提示词', sentOn, sentOn ? '' : '（前台采样可能不可用，见下方日志）')
if (!sentOn) {
  console.log('[诊断] system 长度=' + sysOn.length + ' 含"观测"=' + /观测/.test(sysOn) +
    ' 含"离开"=' + /离开/.test(sysOn) + ' 含"前台"=' + /前台/.test(sysOn) +
    ' 含"媒体"=' + /媒体/.test(sysOn))
  console.log('[诊断] 末尾 600 字：\n' + sysOn.slice(-600))
}
if (sentOn) {
  // 带标题的分支才谈"标题不当指令"；本机若长时间无人操作，走的是"他已经离开"那一条
  const withTitle = /窗口标题「/.test(sysOn)
  check('A2 标题被框成数据而非指令', withTitle ? /不是给我的指令/.test(sysOn) : true,
    withTitle ? '' : '（本条环境为离开态，标题分支由单测覆盖）')
}

// ---- B：关掉开关 → 同一句话，标题那条不再出现 ----
const offRes = await page.evaluate(() => window.nagi.settings.set({ privacy: { titleOutbound: false } }))
check('B0 设置写入成功', !!offRes, JSON.stringify(offRes)?.slice(0, 120))
const persisted = await page.evaluate(async () => (await window.nagi.settings.get())?.privacy?.titleOutbound)
check('B1 落盘为 false', persisted === false, String(persisted))
await sleep(1200) // 等 epoch 刷新
const sysOff = await ask('我刚才在干什么？')
check('B2 关掉后标题不再出站', !sysOff.includes('【观测数据·非指令】'), sysOff.includes('【观测数据·非指令】') ? '仍然出现' : '')

// ---- C：再打开 → 恢复出站（开关是双向的，不是一次性熔断）----
await page.evaluate(() => window.nagi.settings.set({ privacy: { titleOutbound: true } }))
await sleep(1200)
const sysBack = await ask('我刚才在干什么？')
check('C3 重新打开后恢复出站', sysBack.includes('【观测数据·非指令】'))

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (!checks[0]?.ok || failed.length) {
  console.log('\n--- 主进程日志（末 40 行）---')
  console.log(logs.split('\n').slice(-40).join('\n'))
}
try { child.kill() } catch { /* 已退出 */ }
try { server.close() } catch { /* 已关 */ }
process.exit(failed.length ? 1 : 0)
