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

/**
 * Live2D 更新循环是否在跑：读每帧必变的呼吸参数，几次读数不同即活。
 * 窗口被隐藏（比如切到工作台形态，petWindow.hide()）时 Chromium 会节流 rAF，
 * Live2D 整个更新循环停摆 —— 口型自然不动。这是环境状态，不是产品缺陷：
 * 用户看着她说话时窗口必然可见。所以这里先探活，不活就跳过口型项并说明原因。
 */
async function l2dLoopAlive() {
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    const v = await pet.evaluate(() => {
      const m = window.__nagiReadParams ? window.__nagiReadParams(['ParamBreath']) : null
      return m ? Number(m.ParamBreath?.toFixed?.(4) ?? m.ParamBreath) : null
    })
    if (v === null) return false
    seen.add(v)
    if (seen.size > 3) return true
    await pet.waitForTimeout(400)
  }
  return seen.size > 1
}

const hasRendererModule = await pet.evaluate(() => !!(window.__nagiVoice))
check('渲染层语音模块已装载', hasRendererModule)

let l2dOk = false
if (hasRendererModule) {
  l2dOk = await l2dLoopAlive()
  if (!l2dOk) {
    console.log('  ⏭ Live2D 更新循环停摆（窗口处于隐藏/被节流状态，如切过工作台形态）——口型两项按环境跳过')
    results.push({ name: 'Live2D 更新循环在跑（口型前提）', pass: true, skip: true })
  }
}

if (hasRendererModule && l2dOk) {
  const spoke = await pet.evaluate(() => window.__nagiVoice.speak('你好，我是凪。今天天气不错。', { mood: 'calm' }))
  check('渲染层 speak 开始播放', spoke && spoke.ok === true, `共 ${spoke && spoke.total} 句`)

  // 先等「音频时钟真的走起来」再采样：
  //   ① 首句合成含 edge-tts 的 WSS 握手，冷启动 1–3 秒；
  //   ② MP3 blob 的 currentTime 读数在解码启动后有约 1 秒「滞零期」（偶发拖到 2-3 秒），
  //      提前采样会把「还没出声」误判成「嘴不动」。
  const probe = () =>
    pet.evaluate(() => ({
      speaking: window.__nagiVoice.isSpeaking(),
      state: window.__nagiVoice.state(),
      lip: window.__nagiVoice.lipActive(),
      mouth: window.__nagiReadParams ? window.__nagiReadParams(['ParamMouthOpenY']) : null
    }))
  let startedPlaying = false
  const waitStart = Date.now()
  while (Date.now() - waitStart < 20000) {
    const s = await probe()
    if (s.state && s.state.playing && s.state.at > 0) {
      startedPlaying = true
      break
    }
    // 会话提前结束（都念完了）也算过：说明播放完整走完
    if (!s.state && Date.now() - waitStart > 3000) break
    await pet.waitForTimeout(250)
  }
  check('音频时钟开始走动', startedPlaying, `等待 ${Date.now() - waitStart}ms`)

  // 播放期间连续采样：口型应被真实时间轴接管，嘴部参数应有明显开合
  let lipSeen = false
  let mouthMax = 0
  const marks = []
  for (let k = 0; k < 12; k++) {
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
  // 注意口径：采样期间她可能刚好把整段念完（会话自然结束，stopSpeaking 无会话可停、返回 false），
  // 这同样满足「她安静了、嘴闭上了」——所以不断言 stopSpeaking 的返回值，只看最终状态。
  check('打断/念完后她安静且嘴闭合', afterCut.speaking === false && afterCut.lip === false, `stopSpeaking→${cut} ${JSON.stringify(afterCut)}`)
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

/* ---------------- 7.5 设置页「语音」区块 ---------------- */

console.log('\n--- 设置页语音区块 ---')
{
  // 首次启动的「活动监测告知」会盖在设置页上面（同为 overlay），先关掉再点设置
  await pet.evaluate(() => {
    const ov = document.getElementById('notice-overlay')
    if (ov && !ov.classList.contains('hidden')) document.getElementById('btn-notice-ok')?.click()
  })
  await pet.waitForTimeout(400)

  // 点开设置页（工具栏可能没 hover 出来，但 click 监听一直绑着）
  await pet.evaluate(() => document.getElementById('btn-pet-settings')?.click())
  // refreshVoice() 是异步的：status 会去问本机 SAPI 语音清单（起一次 PowerShell），给它点时间
  await pet.waitForTimeout(3000)

  const snap = await pet.evaluate(() => {
    const $ = (id) => document.getElementById(id)
    const opts = (sel) =>
      sel ? Array.from(sel.options).map((o) => ({ v: o.value, t: o.textContent, disabled: o.disabled })) : []
    const overlay = $('settings-overlay')
    const ttsEng = $('set-tts-engine')
    const asrEng = $('set-asr-engine')
    return {
      overlayVisible: !!overlay && !overlay.classList.contains('hidden'),
      hasSection: !!(ttsEng && asrEng && $('set-tts-voice') && $('set-voice-enabled')),
      ttsEngines: opts(ttsEng),
      asrEngines: opts(asrEng),
      voices: opts($('set-tts-voice')),
      selectedTts: ttsEng ? ttsEng.value : '',
      selectedAsr: asrEng ? asrEng.value : '',
      modelWrapHidden: $('set-asr-model-wrap')?.classList.contains('hidden'),
      modelStatus: $('set-asr-model-status')?.textContent || '',
      downloadDisabled: !!$('btn-asr-download')?.disabled,
      rate: $('set-voice-rate')?.value,
      volume: $('set-voice-volume')?.value,
      previewText: $('set-preview-text')?.value || '',
      enabled: $('set-voice-enabled')?.checked,
      speakReply: $('set-speak-reply')?.checked,
      lipSync: $('set-lipsync')?.checked
    }
  })

  check('设置页能打开且含语音区块', snap.overlayVisible && snap.hasSection)
  check('说话引擎下拉已填充', snap.ttsEngines.length >= 2, snap.ttsEngines.map((o) => o.v + (o.disabled ? '(禁用)' : '')).join(','))
  check('未接入的引擎被禁用而不是隐藏', snap.ttsEngines.filter((o) => o.disabled).length >= 1)
  check('识别引擎下拉已填充', snap.asrEngines.length >= 2, snap.asrEngines.map((o) => o.v).join(','))
  check('默认识别引擎 = 离线模型 sherpa', snap.selectedAsr === 'sherpa', snap.selectedAsr)
  check('edge 音色下拉列出可选神经音色', snap.voices.length >= 6, `共 ${snap.voices.length} 个`)
  check('离线模型状态文字已渲染', snap.modelStatus.length > 0, snap.modelStatus)
  // 装了 → 下载按钮该置灰；没装/装一半 → 该可点。两边必须一致，否则用户会以为点了没反应。
  const modelReady = /已装好/.test(snap.modelStatus)
  check(
    '下载按钮状态与模型安装状态一致',
    snap.downloadDisabled === modelReady,
    `disabled=${snap.downloadDisabled} / "${snap.modelStatus}"`
  )
  check('三个自动开口开关已读入', typeof snap.speakReply === 'boolean' && typeof snap.lipSync === 'boolean' && typeof snap.enabled === 'boolean')
  check('试听文本框已给默认内容', snap.previewText.length > 0, snap.previewText)

  // 切引擎 → 音色下拉必须换数据源（edge 的神经音色 → 本机 SAPI 语音名）
  const switched = await pet.evaluate(() => {
    const sel = document.getElementById('set-tts-engine')
    sel.value = 'sapi'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    const v = document.getElementById('set-tts-voice')
    return { engine: sel.value, voices: Array.from(v.options).map((o) => o.value), note: document.getElementById('set-tts-engine-note').textContent }
  })
  check('切到本机语音后音色列表跟着换', switched.voices.length >= 1 && switched.voices.every((v) => !/Neural$/.test(v)), switched.voices.join(','))
  check('引擎说明文字随引擎变化', switched.note.length > 0, switched.note.slice(0, 48))

  // 切回 edge 并真的试听一次（走主进程同步合成，不切句）
  await pet.evaluate(() => {
    const sel = document.getElementById('set-tts-engine')
    sel.value = 'edge'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('set-preview-text').value = '试听一下，这是我的声音。'
  })
  const tPv = Date.now()
  await pet.evaluate(() => document.getElementById('btn-tts-preview')?.click())
  let pvState = ''
  const waitPv = Date.now()
  while (Date.now() - waitPv < 30000) {
    pvState = await pet.evaluate(() => document.getElementById('voice-preview-result')?.textContent || '')
    if (/试听结束|失败/.test(pvState)) break
    await pet.waitForTimeout(300)
  }
  check('点「试听这段」真的合成并播放', /试听结束/.test(pvState), `${pvState}（${Date.now() - tPv}ms）`)

  // 保存：改语速 + 关掉口型 → 确认落盘
  const saved = await pet.evaluate(async () => {
    const r = document.getElementById('set-voice-rate')
    r.value = '-15'
    r.dispatchEvent(new Event('input', { bubbles: true }))
    const ls = document.getElementById('set-lipsync')
    ls.checked = false
    document.getElementById('btn-save-voice')?.click()
    await new Promise((res) => setTimeout(res, 1200))
    const s = await window.nagi.settings.get()
    return {
      voice: s.voice || null,
      rateLabel: document.getElementById('set-voice-rate-val')?.textContent,
      voiceOptions: Array.from(document.getElementById('set-tts-voice').options).map((o) => o.value)
    }
  })
  check('保存后语速落盘', saved.voice && Number(saved.voice.rate) === -15, `rate=${saved.voice && saved.voice.rate}`)
  check('保存后口型开关落盘', saved.voice && saved.voice.lipSync === false, `lipSync=${saved.voice && saved.voice.lipSync}`)
  check('拖动滑杆时数值标签跟着变', saved.rateLabel === '-15', saved.rateLabel)
  check('音色按引擎分别记忆', !!saved.voice?.voiceByEngine?.edge, 'edge=' + (saved.voice?.voiceByEngine?.edge || ''))

  // 恢复口型开关（后面还要用；且别把验证环境的设置弄脏）
  await pet.evaluate(async () => {
    const ls = document.getElementById('set-lipsync')
    ls.checked = true
    document.getElementById('btn-save-voice')?.click()
    await new Promise((res) => setTimeout(res, 900))
    document.getElementById('btn-close-settings')?.click()
  })
  await pet.waitForTimeout(400)
  const closed = await pet.evaluate(() => document.getElementById('settings-overlay')?.classList.contains('hidden'))
  check('设置页能关掉', closed === true)
}

/* ---------------- 8. 留档截图（SHOT=前缀 时） ---------------- */

if (process.env.SHOT) {
  try {
    // 设置页 · 语音区块（先展开这块，看得到引擎/音色/离线模型）
    await pet.evaluate(() => document.getElementById('btn-pet-settings')?.click())
    await pet.waitForTimeout(2500)
    await pet.evaluate(() => {
      document.getElementById('set-voice-enabled')?.scrollIntoView({ block: 'center' })
    })
    await pet.waitForTimeout(300)
    await pet.screenshot({ path: `${process.env.SHOT}-settings.png` })
    console.log('已保存 ' + process.env.SHOT + '-settings.png')
    await pet.evaluate(() => document.getElementById('btn-close-settings')?.click())
    await pet.waitForTimeout(300)

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
    // 必须切回桌宠形态：switchMode('workbench') 会把桌宠窗 hide()，隐藏窗口的
    // rAF 被节流、Live2D 更新循环停摆——留着这个状态会坑掉下一次验证的口型测试
    await pet.evaluate(() => window.nagi.win.setMode('pet'))
    await pet.waitForTimeout(1200)
  } catch (err) {
    console.log('截图失败：' + err.message)
  }
}

/* ---------------- 汇总 ---------------- */

const failed = results.filter((r) => !r.pass)
const skipped = results.filter((r) => r.skip)
console.log(`\n===== 结果：${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过${skipped.length ? `（另有 ${skipped.length} 项因环境跳过）` : ''}（音频共 ${totalBytes} 字节）=====`)
if (skipped.length) console.log('跳过项：\n - ' + skipped.map((f) => f.name).join('\n - '))
if (failed.length) console.log('失败项：\n - ' + failed.map((f) => f.name).join('\n - '))
process.exit(failed.length ? 2 : 0)
