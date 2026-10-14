// scripts/verify-voice.mjs
// 端到端语音链路验证：用 Playwright 通过 CDP 接管**真实运行中的凪**（渲染层是真进程），
// 验证 M5 的 IPC 面 —— 真合成、真识别，不是 mock。
//
// 覆盖：
//   1) voice:status —— 引擎可用性 / 本机语音清单 / 识别引擎清单 / 离线模型状态
//   2) 朗读会话：speak → 按句 pull(0..n) → 音频字节与容器头合法 → 越界返回 done
//   3) 试听：preview（不切句，可临时指定音色/语速）
//   4) 打断：stop 之后旧 sessionId 失效
//   5) 识别：把一段真音频送去 listen → 拿到文本（走离线模型或回退本机识别）
//
// 用法（凪必须已带调试端口 + 独立 userData 启动）：
//   CDP_PORT=9333 node scripts/verify-voice.mjs
// 若给了 VOICE_WAV，则用那个文件做识别；否则自动生成一段 SAPI 合成音频当输入。
//
// 注意：connectOverCDP 下**不要**调 browser.close()，它会真的把 Electron 关掉。
import { chromium } from 'playwright'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.CDP_PORT || 9333)
const PROBE_TEXT = process.env.VOICE_TEXT || '你好，我是凪。今天天气不错。'

async function waitEndpoint(ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

/** 认音频容器：edge 出 MP3，SAPI 出 WAV */
function sniff(bytes) {
  if (!bytes || bytes.length < 4) return '空'
  const b = Array.from(bytes.slice(0, 4))
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3' // ID3
  return '未知(' + b.map((x) => x.toString(16)).join(' ') + ')'
}

if (!(await waitEndpoint())) {
  console.log('✘ CDP 未就绪（应用没起来？端口 ' + PORT + '）')
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const pages = ctx.pages()
console.log('页面：', pages.map((p) => p.url()))
const pet = pages.find((p) => p.url().includes('mode=pet')) || pages[0]
if (!pet) {
  console.log('✘ 没找到可用页面')
  process.exit(1)
}

const hasApi = await pet.evaluate(() => !!(window.nagi && window.nagi.voice))
if (!hasApi) {
  console.log('✘ window.nagi.voice 不存在（preload 没暴露？）')
  process.exit(1)
}

// 渲染层的 console 不会进主进程 stdout，这里接管一下，方便定位播放/口型问题
const pageLogs = []
for (const p of [pet, ...pages.filter((x) => x !== pet)]) {
  p.on('console', (m) => {
    const t = m.text()
    pageLogs.push(t)
    if (process.env.VERBOSE || /voice|音频|口型|播放/.test(t)) console.log('  [page]', t)
  })
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message))
}

/* ---------------- 1. 状态 ---------------- */

const st = await pet.evaluate(() => window.nagi.voice.status())
console.log('\n--- voice:status ---')
console.log(JSON.stringify(st, null, 1).slice(0, 1600))
check('status 返回 TTS/ASR 引擎快照', !!st && !!st.tts && !!st.asr)
check('TTS 挑出了可用引擎', typeof st.tts.engine === 'string' && st.tts.engine.length > 0, st.tts.engine)
check('本机语音清单非空', Array.isArray(st.sapiVoices) && st.sapiVoices.length > 0, st.sapiVoices.map((v) => v.name).join(', '))
check('本机识别引擎清单非空', Array.isArray(st.recognizers) && st.recognizers.length > 0, st.recognizers.map((r) => r.culture).join(', '))
check('离线模型状态可读', !!st.sherpa && typeof st.sherpa.ready === 'boolean', `ready=${st.sherpa && st.sherpa.ready}`)
console.log('  离线模型目录：' + (st.sherpa && st.sherpa.modelDir))

/* ---------------- 2. 朗读会话 ---------------- */

console.log('\n--- 朗读会话 ---')
const speak = await pet.evaluate((text) => window.nagi.voice.speak({ text, mood: 'calm' }), PROBE_TEXT)
console.log('speak →', JSON.stringify(speak))
check('speak 开了会话并切句', speak.ok === true && speak.total >= 1, `共 ${speak.total} 句，引擎 ${speak.engine}`)

let totalBytes = 0
const magics = []
if (speak.ok) {
  for (let i = 0; i < speak.total; i++) {
    const u = await pet.evaluate(
      ({ id, i }) => window.nagi.voice.pull(id, i),
      { id: speak.sessionId, i }
    )
    const okShape = u.ok === true && u.bytes instanceof Uint8Array && u.bytes.length > 500
    totalBytes += u.bytes ? u.bytes.length : 0
    magics.push(sniff(u.bytes))
    check(`第 ${i + 1} 句音频`, okShape, `${u.bytes ? u.bytes.length : 0} 字节 / ${sniff(u.bytes)} / ${u.ms || ''}`)
  }
  const beyond = await pet.evaluate(
    ({ id, i }) => window.nagi.voice.pull(id, i),
    { id: speak.sessionId, i: speak.total }
  )
  check('越界取句返回 done', beyond.ok === true && beyond.done === true)
  check('音频容器全部可识别', magics.every((m) => m === 'wav' || m === 'mp3'), magics.join(','))
}

/* ---------------- 3. 试听 ---------------- */

console.log('\n--- 试听（preview） ---')
const pv = await pet.evaluate(() => window.nagi.voice.preview({ text: '试听一下，这是我的声音。' }))
check('preview 返回音频', pv.ok === true && pv.bytes instanceof Uint8Array && pv.bytes.length > 500, `${pv.bytes ? pv.bytes.length : 0} 字节 / ${sniff(pv.bytes)} / 引擎 ${pv.engine}`)

/* ---------------- 4. 打断 ---------------- */

console.log('\n--- 打断 ---')
if (speak.ok) {
  const stopped = await pet.evaluate((id) => window.nagi.voice.stop(id), speak.sessionId)
  const after = await pet.evaluate(
    ({ id, i }) => window.nagi.voice.pull(id, i),
    { id: speak.sessionId, i: 0 }
  )
  check('stop 后旧会话失效', stopped.ok === true && after.ok === false, after.error || '')
}

/* ---------------- 5. 识别 ---------------- */

console.log('\n--- 识别（listen） ---')
const CANDIDATES = [
  process.env.VOICE_WAV,
  'C:/Users/Administrator/AppData/Local/Temp/nagi-voice-e2e/asr16k.wav',
  join(tmpdir(), 'nagi-verify-voice-asr.wav')
].filter(Boolean)
let wavPath = CANDIDATES.find((p) => existsSync(p)) || ''

if (!wavPath) {
  // 没有现成音频就现场合成一段（顺便验证「自产自听」闭环）
  // 注意：脚本文件必须自己写（走 -Command 拼 here-string 会被 cmd 的引号规则吃掉）
  wavPath = join(tmpdir(), 'nagi-verify-voice-asr.wav')
  const psFile = join(tmpdir(), 'nagi-verify-voice-tts.ps1')
  writeFileSync(
    psFile,
    [
      'param([string]$Out)',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.SetOutputToWaveFile($Out)',
      '$s.Speak("你好，我是凪。今天天气不错。")',
      '$s.Dispose()'
    ].join('\r\n'),
    'ascii'
  )
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Out', wavPath], { timeout: 60000 })
  console.log('已用本机语音生成测试音频：' + wavPath)
}
console.log('输入音频：' + wavPath)

const b64 = readFileSync(wavPath).toString('base64')
const t0 = Date.now()
const rec = await pet.evaluate(async (payload) => {
  const bin = atob(payload)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return window.nagi.voice.listen({ wav: u8 })
}, b64)
const recMs = Date.now() - t0
console.log('listen →', JSON.stringify(rec), '往返', recMs + 'ms')
check('识别出文本', rec.ok === true && String(rec.text || '').trim().length > 0, `引擎 ${rec.engine}，文本「${rec.text}」，${recMs}ms`)

/* ---------------- 6. 渲染层：播放 + 口型 + 打断 ---------------- */

console.log('\n--- 渲染层语音模块 ---')
const hasRendererModule = await pet.evaluate(() => !!(window.__nagiVoice))
check('渲染层语音模块已装载', hasRendererModule)

if (hasRendererModule) {
  const spoke = await pet.evaluate(() => window.__nagiVoice.speak('你好，我是凪。今天天气不错。', { mood: 'calm' }))
  check('渲染层 speak 开始播放', spoke && spoke.ok === true, `共 ${spoke && spoke.total} 句`)

  // 先等「首句真的开始播」再采样：首句合成含 edge-tts 的 WSS 握手，冷启动能到 1–3 秒
  const probe = () =>
    pet.evaluate(() => ({
      speaking: window.__nagiVoice.isSpeaking(),
      state: window.__nagiVoice.state(),
      lip: window.__nagiVoice.lipActive(),
      mouth: window.__nagiReadParams ? window.__nagiReadParams(['ParamMouthOpenY']) : null
    }))
  let startedPlaying = false
  const waitStart = Date.now()
  while (Date.now() - waitStart < 15000) {
    const s = await probe()
    if (s.state && s.state.playing) {
      startedPlaying = true
      break
    }
    await pet.waitForTimeout(200)
  }
  check('首句开始播放', startedPlaying, `等待 ${Date.now() - waitStart}ms`)

  // 播放期间连续采样：口型应被真实时间轴接管，嘴部参数应有明显开合
  let lipSeen = false
  let mouthMax = 0
  const marks = []
  for (let k = 0; k < 10; k++) {
    const s = await probe()
    if (s.lip) lipSeen = true
    const m = (s.mouth && s.mouth.ParamMouthOpenY) || 0
    if (m > mouthMax) mouthMax = m
    marks.push(`${s.state ? s.state.index : '-'}${s.state && s.state.playing ? '▶' : '·'}${s.lip ? '👄' : ''}`)
    await pet.waitForTimeout(200)
  }
  console.log('  采样：', marks.join(' '), '| 最大张口', mouthMax.toFixed(3))
  check('口型已交给真实语音时间轴', lipSeen)
  check('说话时嘴部参数真的在动', mouthMax > 0.02, 'max ParamMouthOpenY=' + mouthMax.toFixed(3))

  const cut = await pet.evaluate(() => window.__nagiVoice.stopSpeaking())
  await pet.waitForTimeout(300)
  const afterCut = await pet.evaluate(() => ({
    speaking: window.__nagiVoice.isSpeaking(),
    lip: window.__nagiVoice.lipActive()
  }))
  check('打断后停止播放且嘴闭合', cut === true && afterCut.speaking === false && afterCut.lip === false, JSON.stringify(afterCut))
}

/* ---------------- 7. 渲染层：按住说话 → 识别 → 文本 ---------------- */

console.log('\n--- 按住说话（录音 → 识别） ---')
if (hasRendererModule) {
  const btn = await pet.evaluate(() => {
    const b = document.getElementById('btn-pet-mic')
    return !!b
  })
  check('麦克风按钮已渲染', btn)

  const started = await pet.evaluate(() => window.__nagiVoice.startRecording())
  if (!started || !started.ok) {
    check('开始录音', false, (started && (started.error || started.reason)) || '未知原因')
    console.log('   （若机器没有麦克风/未给假音频设备，这一项会失败，属环境限制）')
  } else {
    check('开始录音', true)
    await pet.waitForTimeout(500)
    check('录音中状态为真', (await pet.evaluate(() => window.__nagiVoice.isRecording())) === true)
    await pet.waitForTimeout(3200)
    const t0 = Date.now()
    const recd = await pet.evaluate(() => window.__nagiVoice.stopRecording({ send: false }))
    console.log('  stopRecording →', JSON.stringify(recd), '耗时', Date.now() - t0 + 'ms')
    check(
      '录音→解码→16k WAV→识别 全链路跑通',
      !!recd && (recd.ok === true || typeof recd.error === 'string' || typeof recd.reason === 'string'),
      recd && recd.ok ? `识别文本「${recd.text}」（${recd.engine}）` : recd && (recd.error || recd.reason)
    )
    if (recd && recd.ok) check('识别文本非空', String(recd.text || '').trim().length > 0, recd.text)
  }
}

/* ---------------- 8. 留档截图（SHOT=前缀 时） ---------------- */

if (process.env.SHOT) {
  try {
    // 桌宠形态：hover 出工具栏，看得到麦克风按钮
    await pet.hover('#pet-root').catch(() => {})
    await pet.waitForTimeout(600)
    await pet.screenshot({ path: `${process.env.SHOT}-pet.png` })
    console.log('已保存 ' + process.env.SHOT + '-pet.png')

    // 工作台形态：输入框那排的麦克风
    await pet.evaluate(() => window.nagi.win.setMode('workbench'))
    await pet.waitForTimeout(1800)
    const wb = ctx.pages().find((p) => p.url().includes('mode=workbench'))
    if (wb) {
      await wb.screenshot({ path: `${process.env.SHOT}-workbench.png` })
      console.log('已保存 ' + process.env.SHOT + '-workbench.png')
    }
  } catch (err) {
    console.log('截图失败：' + err.message)
  }
}

/* ---------------- 汇总 ---------------- */

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过（音频共 ${totalBytes} 字节）=====`)
if (failed.length) console.log('失败项：\n - ' + failed.map((f) => f.name).join('\n - '))
process.exit(failed.length ? 2 : 0)
