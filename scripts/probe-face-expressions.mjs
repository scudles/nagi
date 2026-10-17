// scripts/probe-face-expressions.mjs
// 把人眼要看的那几张脸抓下来：平静 / 撅嘴 / 几个微表情。
//
// 用途：验证脚本只能给出"画面差了几个百分点"，具体好不好看得人看。
// 抓帧时冻结待机摆动，所以每张都是同一姿态，可以直接拼在一起比。
//
// 用法：node scripts/probe-face-expressions.mjs --shots=<dir>
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9371'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function baseEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return env
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-face-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600, outfit: 'daily' },
      ambient: { enabled: true, gaze: false, autonomous: false, level: 'conservative', hotkeys: false }
    },
    null,
    2
  ),
  'utf8'
)

const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: baseEnv(),
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

let browser
try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) up = true
    } catch {
      /* 还没起来 */
    }
    if (!up) await sleep(400)
  }
  if (!up) throw new Error('CDP 没起来')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)

  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          const ok = await p.evaluate(
            () => document.body?.dataset?.mode === 'pet' && typeof window.__nagiSnapshot === 'function'
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

  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async (tag) => {
    if (!SHOT_DIR) return
    const url = await page.evaluate(() => window.__nagiSnapshot())
    if (url) writeFileSync(join(SHOT_DIR, `${tag}.png`), Buffer.from(url.split(',')[1], 'base64'))
  }

  await page.evaluate(() => window.__nagiFreezeIdle(true))
  await page.evaluate(() => window.__nagiSuppressAutoAct?.(true))
  await sleep(800)

  // 1) 平静（清空所有表情）
  await page.evaluate(() => window.__nagiTestExpression(null))
  await sleep(800)
  await shot('00_calm')
  console.log('✔ 平静脸')

  // 2) 撅嘴（情绪 pout / 被冷落 25 分钟后她就是这个表情）
  await page.evaluate(() => window.__nagiTestExpression('nagi_pout'))
  await sleep(900)
  await shot('01_pout')
  console.log('✔ 撅嘴（nagi_pout：Param29 撅嘴 + 嘴角下压 + 皱眉）')

  // 3) 其他情绪脸，作为对照
  for (const [tag, name] of [
    ['02_joy', 'nagi_joy'],
    ['03_puzzled', 'nagi_puzzled'],
    ['04_worried', '紧张汗'],
    ['05_smile', '脸红']
  ]) {
    await page.evaluate(() => window.__nagiTestExpression(null))
    await sleep(400)
    await page.evaluate((n) => window.__nagiTestExpression(n), name)
    await sleep(850)
    await shot(tag)
    console.log(`✔ ${name}`)
  }

  // 4) 几个微表情
  await page.evaluate(() => window.__nagiTestExpression(null))
  await sleep(500)
  for (const [tag, id] of [
    ['10_micro_star', 'star'],
    ['11_micro_flower', 'flower'],
    ['12_micro_tongue', 'tongue'],
    ['13_micro_puff', 'puff'],
    ['14_micro_sweat', 'sweat'],
    ['15_micro_angry', 'angry']
  ]) {
    await page.evaluate((i) => window.__nagiFlashMicro(i), id)
    await sleep(700) // 停在满强度那一刻
    await shot(tag)
    console.log(`✔ 微表情 ${id}`)
    await sleep(1800)
  }

  await page.evaluate(() => window.__nagiFreezeIdle(false))
  console.log('\n截图目录：', SHOT_DIR)
} catch (e) {
  console.error('抓图失败：', e.message)
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  process.exit(0)
}
