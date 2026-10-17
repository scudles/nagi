// scripts/record-demo.mjs
// 录一段"实机效果"短片：在真实 Electron 桌宠里按剧本演一遍，用 MediaRecorder 录 canvas。
//
// 为什么要录而不是拼截图：她绝大部分的表现是**连续的**（呼吸、五官微动、情绪强度渐变、
// 缓动换脸），静态图看不出这些——而"连续"正是这次改动的重点。
//
// 输出：优先 video/mp4（手机都能播），不支持则退 webm。
// 用法：node scripts/record-demo.mjs --out=<文件路径>
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9401'
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1] || join(ROOT, '..', 'nagi-demo.mp4')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function baseEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NAGI_RENDERER_SANDBOX = '0'
  return env
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-demo-'))
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
      /* 等 */
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
            () => document.body?.dataset?.mode === 'pet' && window.__nagiFaceState?.()?.hasConfig === true
          )
          if (ok) page = p
        } catch {
          /* 导航中 */
        }
      }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('没找到桌宠页（或模型没就绪）')

  // 桌宠窗口是透明的，录出来会是黑底/透明底。加一层深色背景，看起来像真的桌面截图。
  await page.evaluate(() => {
    const s = document.createElement('style')
    s.id = 'demo-bg'
    s.textContent = `
      body, #pet-root, #pet-stage { background: radial-gradient(ellipse at 50% 30%, #2a3048 0%, #171a26 70%) !important; }
      .pet-toolbar, #pet-resizer, #pet-menu { display: none !important; }
    `
    document.head.appendChild(s)
    // 录制备用：把"她自己动"的开关打开（要看到呼吸/微动）
    window.__nagiFreezeIdle?.(false)
    window.__nagiSetTremor?.(1)
    // 锁住情绪广播，免得录到一半被心跳改回平静
    window.__nagiFreezeMood?.(true)
    window.__nagiEmotionIntensity?.('calm', 1)
  })
  await sleep(900)

  const started = await page.evaluate(async () => {
    const canvas = document.getElementById('live2d-canvas')
    if (!canvas) return { ok: false, error: '找不到画布' }
    const mimetypes = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    const mime = mimetypes.find((m) => {
      try {
        return MediaRecorder.isTypeSupported(m)
      } catch {
        return false
      }
    })
    if (!mime) return { ok: false, error: '没有可用的录制编码' }
    const stream = canvas.captureStream(30)
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
    const chunks = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }
    const stopped = new Promise((r) => (rec.onstop = r))
    rec.start(250)
    // 分块取回：一段 base64 几 MB，一次 evaluate 传回来又慢又容易超限
    window.__demoRec = {
      mime,
      size: 0,
      async finish() {
        rec.stop()
        await stopped
        const blob = new Blob(chunks, { type: mime.split(';')[0] })
        const buf = new Uint8Array(await blob.arrayBuffer())
        this._buf = buf
        this.size = buf.length
        return { mime, size: buf.length }
      },
      chunk(offset, len) {
        const slice = this._buf.subarray(offset, offset + len)
        let s = ''
        const CH = 0x8000
        for (let i = 0; i < slice.length; i += CH) {
          s += String.fromCharCode.apply(null, slice.subarray(i, i + CH))
        }
        return btoa(s)
      }
    }
    return { ok: true, mime }
  })

  if (!started.ok) throw new Error('录制启动失败：' + started.error)
  console.log(`录制中（${started.mime}）…`)

  /* ---------------- 剧本 ----------------
   * 每段都要能看出"它是连续演出来的"：
   *   ① 静止待机  —— 呼吸 + 眨眼 + 五官微动（这一层最能说明"不像截图"）
   *   ② 情绪强度  —— 同一个"开心"从 0.25 → 0.6 → 0.95，脸是一点点长开的
   *   ③ 松回去    —— 情绪衰减时脸跟着塌下来（以前是突变成另一张脸）
   *   ④ 换装束    —— 眨个眼就换好了
   *   ⑤ 微表情    —— 星星眼闪一下又收回去
   *   ⑥ 动作      —— 挥手
   */
  const beat = async (label, waitMs, fn) => {
    console.log('  · ' + label)
    if (fn) await page.evaluate(fn)
    await sleep(waitMs)
  }

  // 这一段专门做"对比"：同样的静止待机，关掉头部摆动/眨眼 vs 打开
  await beat('先把头部摆动与眨眼关掉 —— 改动前的样子（除了呼吸几乎不动）', 3000, () => {
    window.__nagiSetIdleHead(0)
    window.__nagiSetBlink(0)
  })
  await beat('打开之后：同一段待机，头部在缓慢转动、眼睛在眨', 5800, () => {
    window.__nagiSetIdleHead(1)
    window.__nagiSetBlink(1)
  })
  await beat('戳她一下 → 转头看你，眼珠也跟着转过来', 3200, () => window.__nagiPoke())
  await beat('你回来了 → 转身迎接（头 26°、身 10°，接近模型上限）', 3400, () =>
    window.__nagiTurn('return', { force: true })
  )
  await beat('安静很久之后的第一个动作（幅度自动加大）', 3400, () => window.__nagiAmbientCommand({ action: 'act' }))
  await beat('连戳到不耐烦 → 装作不理，别过头去', 4400, () => {
    let i = 0
    const tick = () => {
      window.__nagiPoke()
      if (++i < 7) setTimeout(tick, 320)
    }
    tick()
  })

  const meta = await page.evaluate(() => window.__demoRec.finish())
  console.log(`录完：${(meta.size / 1024 / 1024).toFixed(2)} MB`)

  // 分块取回
  const CHUNK = 192 * 1024
  const parts = []
  for (let off = 0; off < meta.size; off += CHUNK) {
    const b64 = await page.evaluate(([o, l]) => window.__demoRec.chunk(o, l), [off, CHUNK])
    parts.push(Buffer.from(b64, 'base64'))
  }
  const buf = Buffer.concat(parts)
  const ext = meta.mime.includes('mp4') ? '.mp4' : '.webm'
  const outPath = OUT.replace(/\.[a-z0-9]+$/i, ext)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, buf)
  console.log(`\n已保存：${outPath}（${(buf.length / 1024 / 1024).toFixed(2)} MB, ${meta.mime}）`)
} catch (e) {
  console.error('录制失败：', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
}
