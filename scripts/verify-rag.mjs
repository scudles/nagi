// scripts/verify-rag.mjs
// 记忆档案（RAG）真机验证：自己拉起一个 Electron 实例（独立 userData），
// 用 Playwright 通过 CDP 接管**真实运行的渲染层**，验证 IPC 面与设置页接线。
//
//   npm run verify:rag
//   RAG_DOWNLOAD=1 npm run verify:rag   # 额外真下载本机模型（约 25MB）再跑召回命中
//
// 覆盖：
//   1) preload 暴露 nagi.rag 六个方法；
//   2) rag:status 结构完整；
//   3) 没装模型时的**默认行为**：不崩、不报错、召回静默降级（行为与以前一致）；
//   4) 入库接线：聊一轮 → 待嵌队列 +1（连本地占位大脑也走同一条路径）；
//   5) 设置页「记忆档案」区块控件齐全、保存能落盘；
//   6) 重建 / 清空在无引擎时给出可读原因而不是抛异常；
//   7) （可选）真下载模型 → 自动补齐待嵌 → 召回命中预期条目。
//
// 注意：connectOverCDP 下**不要**调 browser.close()，那会把 Electron 真关掉。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.CDP_PORT || 9337)
const DO_DOWNLOAD = process.env.RAG_DOWNLOAD === '1'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 起实例 / 收实例 ---------------- */

function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则 electron 会当 node 跑
  return Object.assign(env, extra)
}

function newUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-'))
  // 无 key → 本地占位大脑（mockRun）：事件序列确定、不依赖网络
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        llm: { provider: 'custom', model: 'x' },
        privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
        live2d: { frame: 'bust', petWidth: 400, petHeight: 600 },
        rag: { enabled: true, provider: 'local' }
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

function startApp(port) {
  return spawn(ELECTRON, ['.', `--user-data-dir=${newUserData()}`, `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function stopApp(child) {
  if (!child || child.killed) return
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  await sleep(600)
}

async function waitForCdp(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return false
}

async function findPage(browser, wantMode = 'pet', timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const ok = await page.evaluate((m) => document.body?.dataset?.mode === m, wantMode)
          if (ok) return page
        } catch {
          /* 页面还在导航 */
        }
      }
    }
    await sleep(400)
  }
  return null
}

/* ---------------- 主流程 ---------------- */

console.log('起实例…')
const app = startApp(PORT)
let browser = null
let page = null

try {
  if (!(await waitForCdp(PORT))) {
    console.log('✘ CDP 未就绪（实例没起来？端口 ' + PORT + '）')
    process.exit(1)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  page = await findPage(browser, 'pet')
  if (!page) {
    console.log('✘ 没找到桌宠页')
    process.exit(1)
  }
  // 等 initRag（app ready）+ 8 秒后的 _boot（预热 / 补齐）跑完
  await sleep(10000)

  /* ---- 1. preload 面 ---- */
  const api = await page.evaluate(() =>
    window.nagi && window.nagi.rag
      ? Object.keys(window.nagi.rag).sort()
      : null
  )
  check(
    'preload 暴露 nagi.rag（status/recallTest/rebuild/clear/modelStatus/downloadModel）',
    !!api && ['clear', 'downloadModel', 'modelStatus', 'recallTest', 'rebuild', 'status'].every((k) => api.includes(k)),
    api ? api.join(', ') : 'window.nagi.rag 不存在'
  )

  /* ---- 2. 状态结构 ---- */
  const st0 = await page.evaluate(() => window.nagi.rag.status())
  const needKeys = ['enabled', 'provider', 'engine', 'ready', 'dim', 'chunks', 'pending', 'disk', 'model']
  check(
    'rag:status 结构完整',
    needKeys.every((k) => k in st0),
    needKeys.filter((k) => !(k in st0)).join(',') || '键齐全'
  )
  info('初始状态', `enabled=${st0.enabled} provider=${st0.provider} engine=${st0.engine} ready=${st0.ready} dim=${st0.dim} chunks=${st0.chunks} pending=${st0.pending}`)

  const ms0 = await page.evaluate(() => window.nagi.rag.modelStatus())
  check('rag:model-status 报告本机模型', typeof ms0?.ready === 'boolean' && Array.isArray(ms0.files), `ready=${ms0.ready} model=${ms0.model}`)

  /* ---- 3. 没装模型时的默认行为：不崩、静默降级 ---- */
  const rt0 = await page.evaluate(() => window.nagi.rag.recallTest('我最近睡得怎么样'))
  check(
    '没装模型时召回静默降级（返回 ok:false + 可读原因，不抛异常）',
    rt0 && rt0.ok === false && typeof rt0.reason === 'string' && rt0.reason.length > 0,
    rt0?.reason || JSON.stringify(rt0)
  )
  const rb0 = await page.evaluate(() => window.nagi.rag.rebuild())
  check(
    '没装模型时重建给出可读原因',
    rb0 && rb0.ok === false && !!rb0.error,
    rb0?.error || JSON.stringify(rb0)
  )

  /* ---- 4. 入库接线：聊一轮 → 待嵌队列 +1 ---- */
  const before = (await page.evaluate(() => window.nagi.rag.status())).pending
  await page.evaluate(() => window.nagi.chat.send('我最近总是睡不着，脑子停不下来'))
  await sleep(4000) // 占位大脑也要走完一轮；ingestTurn 在 finally 里
  const st1 = await page.evaluate(() => window.nagi.rag.status())
  check(
    '聊一轮后对话进档案（待嵌队列 +1）',
    st1.pending === before + 1,
    `${before} → ${st1.pending}`
  )
  await page.evaluate(() => window.nagi.chat.send('昨天又点了外卖，说好这周不吃夜宵的'))
  await sleep(3500)
  const st2 = await page.evaluate(() => window.nagi.rag.status())
  check('再聊一轮继续累加', st2.pending === before + 2, `${st1.pending} → ${st2.pending}`)

  /* ---- 5. 设置页 ---- */
  await page.evaluate(() => document.getElementById('btn-pet-settings')?.click())
  await sleep(1200)
  const ui = await page.evaluate(() => {
    const ids = [
      'set-rag-enabled',
      'set-rag-provider',
      'set-rag-threshold',
      'set-rag-halflife',
      'set-rag-autosummary',
      'set-rag-summary-every',
      'btn-save-rag',
      'btn-rag-rebuild',
      'btn-rag-clear',
      'btn-rag-download',
      'rag-query',
      'btn-rag-test'
    ]
    return ids.filter((id) => !document.getElementById(id))
  })
  check('设置页「记忆档案」区块控件齐全', ui.length === 0, ui.length ? '缺失：' + ui.join(', ') : '12 个控件都在')

  const filled = await page.evaluate(() => ({
    provider: document.getElementById('set-rag-provider')?.value,
    enabled: document.getElementById('set-rag-enabled')?.checked,
    threshold: document.getElementById('set-rag-threshold')?.value,
    statusText: document.getElementById('rag-status')?.textContent || ''
  }))
  check('区块已按当前设置填好', filled.provider === 'local' && filled.enabled === true, JSON.stringify(filled))
  check('状态卡有内容', filled.statusText.length > 0, filled.statusText)

  // 改两个数 → 点保存 → 设置真的落盘
  await page.evaluate(() => {
    const th = document.getElementById('set-rag-threshold')
    th.value = '0.45'
    th.dispatchEvent(new Event('input', { bubbles: true }))
    const hl = document.getElementById('set-rag-halflife')
    hl.value = '90'
    hl.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.evaluate(() => document.getElementById('btn-save-rag').click())
  await sleep(1200)
  const saved = await page.evaluate(async () => (await window.nagi.settings.get()).rag)
  check(
    '点保存后设置落盘（门限 0.45 / 半衰期 90 天）',
    Math.abs(saved.threshold - 0.45) < 1e-6 && saved.halfLifeDays === 90,
    JSON.stringify(saved)
  )

  // 召回自测按钮（无引擎时也应给出可读提示，不白屏）
  await page.evaluate(() => {
    document.getElementById('rag-query').value = '我睡眠怎么样'
    document.getElementById('btn-rag-test').click()
  })
  await sleep(1500)
  const testOut = await page.evaluate(() => document.getElementById('rag-test-result')?.textContent || '')
  check('「试一下」按钮有输出（无引擎时给原因，不空白）', testOut.length > 0, testOut.slice(0, 60))

  await page.evaluate(() => document.getElementById('btn-close-settings')?.click())
  await sleep(400)

  /* ---- 6. 可选：真下载模型 ---- */
  if (DO_DOWNLOAD && !ms0.ready) {
    console.log('\n下载本机嵌入模型（约 25MB）…')
    const dl = await page.evaluate(() => window.nagi.rag.downloadModel())
    check('模型下载成功', dl?.ok === true, dl?.error || '')
    if (dl?.ok) {
      // 下载完成 → 服务会自动把待嵌队列补齐（每批 8 条）
      await sleep(12000)
      const st3 = await page.evaluate(() => window.nagi.rag.status())
      check('待嵌队列已自动补齐', st3.pending === 0 && st3.chunks > 0, `chunks=${st3.chunks} pending=${st3.pending}`)
      const rt = await page.evaluate(() => window.nagi.rag.recallTest('我最近睡得怎么样'))
      check('召回命中预期条目', rt.ok === true && rt.count > 0, `${rt.count} 条 · ${(rt.text || '').split('\n')[1] || ''}`)
      info('召回明细', (rt.results || []).map((x) => `${x.sim} ${x.label} ${String(x.text).slice(0, 20)}`).join(' | '))
      check('召回结果带时间标签', /今天|昨天|天前|周前|个月前/.test(rt.text || ''), (rt.text || '').split('\n')[1] || '')
    }
  } else if (!ms0.ready) {
    check('（可选）真下载模型', true, '跳过：未设 RAG_DOWNLOAD=1')
  }

  /* ---- 7. 清空 ---- */
  const cl = await page.evaluate(() => window.nagi.rag.clear())
  const st4 = await page.evaluate(() => window.nagi.rag.status())
  check('清空档案', cl?.ok === true && st4.chunks === 0 && st4.pending === 0, `chunks=${st4.chunks} pending=${st4.pending}`)
} catch (err) {
  check('脚本执行未抛异常', false, err && err.message ? err.message : String(err))
} finally {
  await stopApp(app)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) console.log('失败项：\n - ' + failed.map((f) => f.name + (f.detail ? '：' + f.detail : '')).join('\n - '))
process.exit(failed.length ? 2 : 0)
