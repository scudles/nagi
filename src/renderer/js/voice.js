// src/renderer/js/voice.js
// 渲染层语音客户端（M5）：让她真的开口说话、也真的听得见你说话。
//
// 分工：
//   - 主进程 main/voice 负责「把文字变成音频」「把音频变成文字」（引擎、降级、熔断都在那边）
//   - 这里负责「怎么放、怎么录、什么时候说」——播放、口型、打断、按住说话
//
// 三个关键决定：
//   ① **按句流水播放**：主进程按句给音频，这里播第 1 句的同时预取第 2 句，
//      于是首响 = 首句合成时间，而不是整段合成时间。
//   ② **口型用真实时间轴**：拿到音频时长后用 core/voice/lip.js 按音节算包络，
//      驱动 Live2D 的嘴部参数（比「随机张嘴」更贴合她实际说的话）。
//   ③ **不碰 agent.js / chat.js**：直接订阅 EVT.AGENT 的 DONE 拿整段回复文本。
//      「什么时候该说话」是表现层的事，就该由表现层决定，主进程不必知道。

import { EVT, AGENT_EVENT } from '../../shared/protocol.js'
import { VOICE_EVT, mergeVoiceSettings } from '../../shared/voice-protocol.js'
import { createLipTrack, encodeWav, resample, trimSilence, peak, ASR_SAMPLE_RATE } from '../../core/voice/index.js'
import * as l2d from './live2d.js'
import * as ui from './ui.js'
import { sendText } from './chat.js'

/** 录音短于这么久当作误触（手指刚碰到就抬起来了） */
const MIN_RECORD_MS = 450
/** 超过这个峰值认为「真的说了话」，否则提示没听到 */
const VOICE_PEAK = 0.012

let getSettings = () => null
let mood = 'calm'
let mode = 'pet'

/* ---------------- 朗读（TTS 播放） ---------------- */

/** 当前朗读会话：{ sessionId, total, index, sentences, audio, urls, cancelled, preloaded } */
let speech = null

function cfg() {
  return mergeVoiceSettings(getSettings()?.voice)
}

function notice(text, ms = 2600) {
  if (mode === 'pet') ui.showBubble(text, { autoHide: ms })
  else ui.addToolLog(text)
}

/** 取一句音频 → Blob（done 时返回 null） */
async function pullBlob(sessionId, index) {
  try {
    const u = await window.nagi.voice.pull(sessionId, index)
    if (!u || !u.ok) return null
    if (u.done || !u.bytes || !u.bytes.length) return null
    return { blob: new Blob([u.bytes], { type: u.format || 'audio/mpeg' }), text: u.text, engine: u.engine }
  } catch {
    return null
  }
}

/** 文本 → 口型撒子（同一句话每次嘴型一致，不抽搐） */
function seedOf(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function releaseUrls(st) {
  if (!st || !st.urls) return
  for (const u of st.urls) {
    try {
      URL.revokeObjectURL(u)
    } catch {
      /* ignore */
    }
  }
  st.urls.clear()
}

/** 播下一句；句间不等待，边播边预取 */
async function playNext() {
  const st = speech
  if (!st || st.cancelled) return
  if (st.index >= st.total) {
    finishSpeech(st)
    return
  }
  const i = st.index
  st.index++
  const sentenceText = st.sentences?.[i] || ''

  const got = st.preloaded || (await pullBlob(st.sessionId, i))
  st.preloaded = null
  if (speech !== st || st.cancelled) return
  if (!got) {
    // 这一句合成失败（引擎抽风）——跳过它，别把整段卡死
    return playNext()
  }

  // 预取下一句，压掉句与句之间的空档
  if (st.index < st.total && !st.preloaded) {
    pullBlob(st.sessionId, st.index).then((b) => {
      if (speech === st && !st.cancelled) st.preloaded = b
    })
  }

  const url = URL.createObjectURL(got.blob)
  st.urls.add(url)
  const audio = new Audio(url)
  st.audio = audio
  let lipSet = false

  const onSettled = () => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
    st.urls.delete(url)
    if (speech === st && !st.cancelled) playNext()
  }

  audio.onplay = () => {
    if (!cfg().lipSync || !st.playing || lipSet) return
    lipSet = true
    // 时长兜底：audio.duration 在部分容器/时机上会给出 0 或离谱值，
    // 拿不到就给一个「按字数估」的合理值（中文 TTS 约 4~5 字/秒），
    // 反正时钟用的是 currentTime，估短了包络会自己循环，不会僵住。
    const raw = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0
    const durationMs = raw >= 200 ? raw : Math.max(600, sentenceText.length * 220)
    l2d.setLipTrack(createLipTrack({ text: sentenceText, durationMs, seed: seedOf(sentenceText) }), () => audio.currentTime * 1000)
  }
  audio.onloadedmetadata = audio.onplay
  audio.onended = () => {
    l2d.clearLipTrack()
    onSettled()
  }
  audio.onerror = () => {
    l2d.clearLipTrack()
    onSettled()
  }

  st.playing = true
  try {
    await audio.play()
  } catch (err) {
    // 浏览器要求用户手势才能播；静默失败比抛出去炸掉整段好
    console.warn('[voice] 播放失败：', err && err.message)
    l2d.clearLipTrack()
    onSettled()
  }
}

function finishSpeech(st) {
  st.playing = false
  l2d.clearLipTrack()
  if (speech === st) speech = null
  try {
    window.nagi.voice.stop(st.sessionId)
  } catch {
    /* ignore */
  }
}

/**
 * 念一段文本。会打断上一段。
 * @param {string} text
 * @param {{mood?:string, engine?:string, reason?:string}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, error?:string}>}
 */
export async function speak(text, opts = {}) {
  const c = cfg()
  if (!text || !String(text).trim()) return { ok: false, reason: '空文本' }
  // 她正在说的时候说了新的话：打断旧的（用户重发/新回复优先）
  stopSpeaking()

  if (!c.ttsEnabled) return { ok: false, reason: '语音已关闭' }
  let started
  try {
    started = await window.nagi.voice.speak({
      text,
      mood: opts.mood || mood,
      engine: opts.engine || c.ttsEngine
    })
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
  if (!started || !started.ok) {
    // 非归属窗口（形态切换后/双窗场景）：主进程仲裁未放行，正常静默，不当报错
    if (started && started.reason === 'not-owner') return { ok: false, reason: 'not-owner' }
    console.warn('[voice] 合成未开始：', started && started.error)
    return { ok: false, error: started?.error || '语音合成失败' }
  }

  const st = {
    sessionId: started.sessionId,
    total: started.total,
    sentences: started.sentences || [],
    index: 0,
    audio: null,
    urls: new Set(),
    preloaded: null,
    cancelled: false,
    playing: false
  }
  speech = st
  playNext()
  return { ok: true, total: st.total, engine: started.engine }
}

/** 打断朗读（松手打断 / 用户又开口 / 切换窗口都会用到） */
export function stopSpeaking() {
  const st = speech
  speech = null
  if (!st) return false
  st.cancelled = true
  st.playing = false
  try {
    st.audio && st.audio.pause()
  } catch {
    /* ignore */
  }
  releaseUrls(st)
  l2d.clearLipTrack()
  try {
    window.nagi.voice.stop(st.sessionId)
  } catch {
    /* ignore */
  }
  return true
}

export function isSpeaking() {
  return !!speech
}

/* ---------------- 聆听（ASR 录音） ---------------- */

/** 当前录音：{ stream, recorder, chunks, startedAt, peak, timer } */
let rec = null

function hint(text, cls = '') {
  // 桌宠窗与工作台窗各有一份提示节点（两个形态都可能有语音交互）
  for (const el of document.querySelectorAll('.voice-hint')) {
    el.textContent = text || ''
    el.className = 'voice-hint' + (text ? '' : ' hidden') + (cls ? ' ' + cls : '')
  }
}

function setMicState(on) {
  for (const id of ['btn-pet-mic', 'btn-wb-mic']) {
    const b = document.getElementById(id)
    if (b) b.classList.toggle('recording', !!on)
  }
}

/** 开始录音（按住说话按下时调用） */
export async function startRecording() {
  if (rec) return { ok: false, reason: '已在录音' }
  stopSpeaking() // 别让她一边说一边听自己
  const c = cfg()

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    const msg = err && err.name === 'NotAllowedError' ? '麦克风被拒绝了（系统设置里允许一下）' : '拿不到麦克风：' + (err?.message || err)
    notice(msg)
    return { ok: false, error: msg }
  }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)
  )
  let recorder
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    notice('这台机器的浏览器不支持录音')
    return { ok: false, error: String(err) }
  }

  rec = {
    stream,
    recorder,
    chunks: [],
    startedAt: Date.now(),
    peak: 0,
    timer: null,
    analyser: null,
    raf: null
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) rec && rec.chunks.push(e.data)
  }
  recorder.start(200)

  // 峰值监测：录完判断「是真说了话」还是「只是碰到了」
  try {
    const actx = new AudioContext()
    const src = actx.createMediaStreamSource(stream)
    const an = actx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    rec.analyser = { actx, an, buf: new Float32Array(an.fftSize) }
    const tickPeak = () => {
      if (!rec || !rec.analyser) return
      an.getFloatTimeDomainData(rec.analyser.buf)
      const p = peak(rec.analyser.buf)
      if (p > rec.peak) rec.peak = p
      rec.raf = requestAnimationFrame(tickPeak)
    }
    tickPeak()
  } catch {
    /* 拿不到分析器也能录，只是少了「没说话」的判断 */
  }

  const maxMs = Number(c.maxRecordMs) || 60000
  rec.timer = setInterval(() => {
    if (!rec) return
    const sec = ((Date.now() - rec.startedAt) / 1000).toFixed(1)
    hint(`听着呢… ${sec}s（松手发送）`, 'rec')
  }, 200)
  const hardStop = setTimeout(() => stopRecording(), maxMs)
  rec.hardStop = hardStop

  setMicState(true)
  hint('听着呢… 0.0s（松手发送）', 'rec')
  return { ok: true }
}

/**
 * 结束录音并识别 → 送进对话。
 * @param {{send?:boolean}} [opts] send=false 时只返回文本（调试用）
 */
export async function stopRecording(opts = {}) {
  const cur = rec
  if (!cur) return { ok: false, reason: '没在录音' }
  rec = null
  setMicState(false)
  hint('')
  clearInterval(cur.timer)
  clearTimeout(cur.hardStop)
  if (cur.raf) cancelAnimationFrame(cur.raf)
  try {
    cur.analyser?.actx.close()
  } catch {
    /* ignore */
  }

  // 停录 → 等最后一片数据
  const done = new Promise((resolve) => {
    cur.recorder.onstop = resolve
    try {
      cur.recorder.stop()
    } catch {
      resolve()
    }
  })
  const heldMs = Date.now() - cur.startedAt
  try {
    await done
  } catch {
    /* ignore */
  }
  cur.stream.getTracks().forEach((t) => t.stop())

  if (heldMs < MIN_RECORD_MS) {
    return { ok: false, reason: '按太短了（要按住说话）' }
  }

  const blob = new Blob(cur.chunks, { type: cur.recorder.mimeType || 'audio/webm' })
  if (!blob.size) {
    notice('没录到声音')
    return { ok: false, reason: '空录音' }
  }

  // webm/ogg → Float32 → 16k 单声道 WAV（主进程与系统识别引擎只吃这个）
  let wav
  try {
    wav = await blobToWav(blob)
  } catch (err) {
    notice('音频解码失败')
    return { ok: false, error: String(err) }
  }
  if (!wav) {
    notice('没听到你说话')
    return { ok: false, reason: '没听到声音' }
  }

  if (mode === 'pet') ui.showBubble('…（在听）', { autoHide: 0 })
  else ui.setStatus('thinking')
  let r
  try {
    r = await window.nagi.voice.listen({ wav, culture: cfg().asrCulture })
  } catch (err) {
    r = { ok: false, error: err && err.message ? err.message : String(err) }
  } finally {
    if (mode === 'pet') ui.hideBubble()
    else ui.setStatus('idle')
  }

  if (!r || !r.ok || !String(r.text || '').trim()) {
    notice('没听清，再说一次？')
    return { ok: false, error: r?.error || '没识别出内容' }
  }

  const text = String(r.text).trim()
  if (opts.send === false) return { ok: true, text, engine: r.engine }
  // 认到的话直接送进对话——这就是「按住说话」的意义
  sendText(text)
  return { ok: true, text, engine: r.engine }
}

/** webm/ogg 音频 → 16k 单声道 WAV 字节 */
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer()
  const actx = new AudioContext()
  let audio
  try {
    audio = await actx.decodeAudioData(buf)
  } finally {
    actx.close()
  }
  const raw = audio.getChannelData(0)
  const samples = trimSilence(raw, audio.sampleRate)
  if (!samples.length || peak(samples) < VOICE_PEAK) return null
  const resampled = resample(samples, audio.sampleRate, ASR_SAMPLE_RATE)
  return encodeWav(resampled, ASR_SAMPLE_RATE)
}

/** 点一下切换（键盘/无鼠标时也能用）：按一下开始，再按一下结束 */
export async function toggleRecording() {
  if (rec) return stopRecording()
  return startRecording()
}

/* ---------------- 接线 ---------------- */

function bindMicButton(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      el.setPointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    startRecording()
  })
  const release = (e) => {
    if (!rec) return
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    stopRecording()
  }
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
  // 键盘可达：Enter/空格按下开始，抬起结束
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault()
      startRecording()
    }
  })
  el.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      stopRecording()
    }
  })
}

/**
 * 初始化语音链路。
 * @param {{mode?:string, getSettings?:()=>object}} [opts]
 */
export function initVoice(opts = {}) {
  mode = opts.mode || mode
  if (typeof opts.getSettings === 'function') getSettings = opts.getSettings

  bindMicButton('btn-pet-mic')
  bindMicButton('btn-wb-mic')

  // 情绪 → 语音微调（只记着，下次开口时用）
  window.nagi.on(EVT.MOOD, (snap) => {
    if (snap && snap.mood) mood = snap.mood
  })

  // 她回复完 → 自动念出来（直接从 AGENT DONE 拿整段文本，不必改 chat.js）
  window.nagi.on(EVT.AGENT, (evt) => {
    if (!evt || evt.type !== AGENT_EVENT.DONE) return
    const c = cfg()
    if (!c.ttsEnabled || !c.speakOnReply) return
    if (!evt.text || !String(evt.text).trim()) return
    speak(evt.text, { mood })
  })

  // 主动搭话 / 日程提醒 → 也念出来
  window.nagi.on(EVT.PET, (p) => {
    if (!p || !p.text) return
    if (p.kind !== 'proactive' && p.kind !== 'reminder') return
    const c = cfg()
    if (!c.ttsEnabled || !c.speakOnProactive) return
    speak(p.text, { mood })
  })

  // 离线模型下载进度 → 交给设置页展示（设置页自己也会订阅，这里只兜底打日志）
  window.nagi.on(VOICE_EVT.PROGRESS, (p) => {
    if (p && p.done) console.log('[voice] 离线模型下载结束：', p.ok ? '成功' : p.error)
  })

  // 失去语音归属（形态切换）：立刻闭嘴，避免隐藏的窗继续发声、和新归属者重叠（V01 修复）
  window.nagi.on(VOICE_EVT.OWNER_LOST, () => {
    stopSpeaking()
  })

  // 切窗口/关窗时闭嘴并停录，免得她对着空房间说话
  window.addEventListener('beforeunload', () => {
    stopSpeaking()
    if (rec) {
      try {
        rec.recorder.stop()
        rec.stream.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
      rec = null
    }
  })

  // 暴露给无头验证用（和项目里 __nagiXxx 调试钩子一个路数）
  window.__nagiVoice = {
    speak,
    stopSpeaking,
    startRecording,
    stopRecording,
    toggleRecording,
    isSpeaking,
    isRecording: () => !!rec,
    /** 口型是否已被真实语音接管（live2d.setLipTrack 生效中） */
    lipActive: () => l2d.isTalking(),
    state: () => {
      if (!speech) return null
      // 附带播放进度（调试口型问题必需：lipTrack 的时钟就是 audio.currentTime），
      // dur 为 NaN/-1 说明元数据没就绪；paused 为 true 说明根本没在放
      const a = speech.audio
      return {
        sessionId: speech.sessionId,
        index: speech.index,
        total: speech.total,
        playing: speech.playing,
        at: a ? Math.round(a.currentTime * 1000) : -1,
        dur: a ? (Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : -1) : -1,
        paused: a ? a.paused : null,
        readyState: a ? a.readyState : -1
      }
    }
  }
}
