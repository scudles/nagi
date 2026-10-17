// scripts/probe-outfit-params.mjs
// 探针：把「装束类」表情逐个渲染出来存图，用来确认每个配件的开关方向。
//
// 为什么必须看图：exp3.json 只写了"把 Param11 设成 1"，不告诉你 1 是"系上"
// 还是"取下"。而 pixi 的表达式切换**不会重置上一个表情**，所以每个状态前必须
// 先 resetExpression，否则测出来的是"上一堆表情的叠加"，会得出反的结论。
//
// 方向依据（原包作者的按键说明 models/Maine/_source/缅因妹妹按键说明.txt）：
//   21.眼镜 ctrl+W   26.尾巴上 ctrl+U   27.尾巴关闭 ctrl+I
//   28.披肩关闭 ctrl+O   29.耳朵关闭 ctrl+P   30.蝴蝶结关闭 ctrl+A
//   1~4. 丸子头 / 侧编发 / 短发 / 高马尾 —— 名字即语义
// 存图后拼成对照图，最终由人眼确认。
//
// 用法：node scripts/probe-outfit-params.mjs --shots=<dir>
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9351'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shots=')) || '').split('=')[1] || ''
/** --mode=params（默认，逐个配件）/ looks（逐套装束，用来出对照图） */
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '').split('=')[1] || 'params'
const MODEL_DIR = join(ROOT, 'models', 'Maine')

/** 要逐个渲染确认的装束资源 */
const CASES = [
  { slot: 'hair', expr: '短发', file: 'short_hair' },
  { slot: 'hair', expr: '丸子头', file: 'bun' },
  { slot: 'hair', expr: '高马尾', file: 'ponytail' },
  { slot: 'hair', expr: '侧编发', file: 'side_braid' },
  { slot: 'glasses', expr: '眼镜', file: 'glasses' },
  { slot: 'ears', expr: '耳朵', file: 'ears' },
  { slot: 'ribbon', expr: '蝴蝶结关闭', file: 'ribbon_off' },
  { slot: 'cape', expr: '披肩关闭', file: 'cape_off' },
  { slot: 'tail', expr: '尾巴上', file: 'tail_up' },
  { slot: 'tail', expr: '尾巴关闭', file: 'tail_hide' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 model3.json 查出表情文件里实际写的参数（不靠 readParams：它读不到部件绑定类参数） */
function expressionParams(exprName) {
  try {
    const cfg = JSON.parse(readFileSync(join(MODEL_DIR, 'Maine.model3.json'), 'utf8'))
    const def = (cfg.FileReferences.Expressions || []).find((e) => e.Name === exprName)
    if (!def) return null
    const e = JSON.parse(readFileSync(join(MODEL_DIR, def.File), 'utf8'))
    return (e.Parameters || []).map((p) => `${p.Id}=${p.Value}`).join(' ')
  } catch {
    return null
  }
}

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return Object.assign(env, extra)
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-outfit-probe-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
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
            () => document.body?.dataset?.mode === 'pet' && (window.__nagiExpressionList?.() || []).length > 0
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

  await page.evaluate(() => window.__nagiTestExpression(null))
  await sleep(1000)
  await shot('00_baseline')
  console.log('槽位        表情名        表情文件里写的参数')
  console.log('-'.repeat(80))
  for (const c of CASES) {
    console.log(`${c.slot.padEnd(10)}  ${c.expr.padEnd(12)}  ${expressionParams(c.expr) || '（查不到）'}`)
  }

  if (MODE === 'looks') {
    const cfg = await page.evaluate(() => window.__nagiOutfitConfig())
    console.log('\n逐套装束渲染：')
    await page.evaluate(() => window.__nagiFreezeIdle(true))
    await sleep(600)
    let i = 1
    for (const l of cfg?.looks || []) {
      await page.evaluate((id) => window.__nagiSetOutfit(id), l.id)
      await sleep(1300)
      await shot(`${String(i).padStart(2, '0')}_look_${l.id}`)
      console.log(`  ✔ ${l.name}（${l.id}）：${l.desc || ''}`)
      i++
    }
    await page.evaluate(() => window.__nagiFreezeIdle(false))
    console.log(`\n截图目录：${SHOT_DIR}`)
    await new Promise((r) => {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', r)
    })
    process.exit(0)
  }

  console.log('\n逐个渲染（每个状态前先 reset，避免上一个表情残留）：')
  let idx = 1
  for (const c of CASES) {
    await page.evaluate(() => window.__nagiTestExpression(null))
    await sleep(350)
    const ok = await page.evaluate((n) => window.__nagiTestExpression(n), c.expr)
    await sleep(950)
    await shot(`${String(idx).padStart(2, '0')}_${c.slot}_${c.file}`)
    console.log(`  ${ok ? '✔' : '✘'} ${String(idx).padStart(2, '0')} ${c.slot}/${c.expr}`)
    idx++
  }

  console.log(`\n截图目录：${SHOT_DIR || '（未指定 --shots）'}`)
} catch (e) {
  console.error('探针失败：', e.message)
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  process.exit(0)
}
