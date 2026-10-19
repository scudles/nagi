import { reportRendererCatch, recoverRendererCatch, CATCH_CLASS } from './catch-report.js'
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
//   ③ **流式首句**：订阅 Agent 的正文增量，句子成形后立刻送去合成；
//      后续句顺序排队，按下麦克风时同时停止当前会话和未朗读队列。

import { EVT, AGENT_EVENT } from '../../shared/protocol.js'
import { VOICE_EVT, mergeVoiceSettings } from '../../shared/voice-protocol.js'
import { createLipTrack, createSegmenter, toSpeechText, encodeWav, resample, trimSilence, peak, ASR_SAMPLE_RATE, decideBackchannel, emptyBackchannelState } from '../../core/voice/index.js'
import * as l2d from './live2d.js'
import * as ui from './ui.js'
import { sendText } from './chat.js'
import { getRhythm } from './presence.js'

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
let speechGeneration = 0
let reply = null
let voiceTrace = null
let muteReplyUntilDone = false
let agentActive = false

function markTrace(key) {
  if (voiceTrace && voiceTrace[key] == null) voiceTrace[key] = performance.now()
}

function cancelReply() {
  if (reply) {
    reply.cancelled = true
    reply.queue.length = 0
    reply = null
  }
}

/* ---------------- 非语言语气音（回合首尾；默认关闭） ---------------- */

/**
 * 语气音状态。**只存内存**：关掉开关不重放积压，重启归零（语气音是点缀，
 * 不值得为它落盘，落盘反而会让它"跨天还记得"，那不是我们想要的）。
 */
let backchannelState = emptyBackchannelState()

/**
 * 取一句语气音；不该出声时返回 null。
 * 决策全在 core/voice/backchannel.js（纯函数，有单测）；这里只负责喂上下文。
 * 开关默认关闭 → 本函数在默认配置下恒返回 null，且不产生任何额外开销。
 */
function takeBackchannel(phase) {
  try {
    const bc = cfg().backchannel
    if (!bc || bc.enabled !== true) return null
    const privacy = getSettings?.()?.privacy || {}
    const quiet = privacy.doNotDisturb === true || privacy.onlyPresence === true
    const r = decideBackchannel({
      phase,
      mood,
      period: getRhythm?.()?.period || null,
      quiet,
      config: bc,
      state: backchannelState,
      now: Date.now()
    })
    backchannelState = r.state
    return r.text || null
  } catch (err) {
    console.warn('[voice] 语气音决策失败，已忽略：', err?.message)
    return null
  }
}

function beginReply() {
  cancelReply()
  stopSpeechOnly()
  reply = { segmenter: createSegmenter(), queue: [], running: false, cancelled: false,
    sawDelta: false, done: false, rawText: '', emittedText: '', deferred: false }
  // 回合开头：先出一声再说话（默认关闭时这里是 null，队列不受影响）
  const bcStart = takeBackchannel('start')
  if (bcStart) reply.queue.push(bcStart)
}

async function pumpReply() {
  const state = reply
  if (!state || state.running || !state.queue.length) return
  state.running = true
  try {
    while (reply === state && !state.cancelled && state.queue.length) {
      const sentence = state.queue.shift()
      const result = await startSpeak(sentence, { mood })
      if (result.ok) await result.finished
    }
  } catch (err) {
    console.warn('[voice] 流式朗读失败：', err?.message)
  } finally {
    state.running = false
    if (reply === state && state.done && !state.queue.length) reply = null
  }
}

function addReplyDelta(text) {
  if (!text || muteReplyUntilDone) return
  agentActive = true
  if (!reply) beginReply()
  reply.sawDelta = true
  reply.rawText += text
  // 围栏代码、行内代码和链接可能横跨多段 token；一旦出现，余下文本等完整回复
  // 到手后再清洗，避免把代码或 URL 的半截念出来。
  if (/[`\[]|https?:\/\//i.test(reply.rawText)) reply.deferred = true
  if (reply.deferred) return
  for (const sentence of reply.segmenter.push(text)) {
    reply.emittedText += sentence
    const clean = toSpeechText(sentence)
    if (clean) reply.queue.push(clean)
  }
  pumpReply()
}

function finishReply(text) {
  agentActive = false
  if (muteReplyUntilDone) { muteReplyUntilDone = false; return }
  if (!reply) beginReply()
  if (reply.deferred) {
    const clean = toSpeechText(text || reply.rawText)
    const prefix = toSpeechText(reply.emittedText)
    const remaining = prefix && clean.startsWith(prefix) ? clean.slice(prefix.length).trim() : clean
    if (remaining) reply.queue.push(remaining)
  } else {
    if (!reply.sawDelta && text) reply.queue.push(...reply.segmenter.push(text).map(toSpeechText).filter(Boolean))
    const tail = reply.segmenter.flush()
    if (tail) {
      const clean = toSpeechText(tail)
      if (clean) reply.queue.push(clean)
    }
  }
  // 回合收尾：说完再留一声（默认关闭时这里是 null）
  const bcEnd = takeBackchannel('end')
  if (bcEnd) reply.queue.push(bcEnd)
  reply.done = true
  pumpReply()
}

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
    } catch (__err) { reportRendererCatch('voice.revokeUrl', CATCH_CLASS.DEGRADE, __err) }
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
    } catch (__err) { reportRendererCatch('voice.revokePlayedUrl', CATCH_CLASS.DEGRADE, __err) }
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
  audio.onplaying = () => markTrace('firstAudioAt')
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

function stopSessionReported(sessionId, site) {
  try {
    Promise.resolve(window.nagi.voice.stop(sessionId))
      .then((result) => {
        if (!result?.ok) throw new Error('语音会话停止失败')
        recoverRendererCatch(site)
      })
      .catch((err) => reportRendererCatch(site, CATCH_CLASS.PROMISE, err))
  } catch (err) { reportRendererCatch(site, CATCH_CLASS.PROMISE, err) }
}

function finishSpeech(st) {
  st.playing = false
  l2d.clearLipTrack()
  if (speech === st) speech = null
  st.resolveFinished?.()
  stopSessionReported(st.sessionId, 'voice.stopSession')
}

/**
 * 念一段文本。会打断上一段。
 * @param {string} text
 * @param {{mood?:string, engine?:string, reason?:string}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, error?:string}>}
 */
async function startSpeak(text, opts = {}) {
  const c = cfg()
  if (!text || !String(text).trim()) return { ok: false, reason: '空文本' }
  stopSpeechOnly()
  const ticket = speechGeneration

  if (!c.ttsEnabled) return { ok: false, reason: '语音已关闭' }
  markTrace('ttsRequestedAt')
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
  if (ticket !== speechGeneration) {
    Promise.resolve(window.nagi.voice.stop(started.sessionId))
      .catch((err) => reportRendererCatch('voice.stopInterruptedSession', CATCH_CLASS.PROMISE, err))
    return { ok: false, reason: '已打断' }
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
  st.finished = new Promise((resolve) => { st.resolveFinished = resolve })
  speech = st
  playNext()
  return { ok: true, total: st.total, engine: started.engine, finished: st.finished }
}

/** 对外朗读：会覆盖尚未念完的流式回复。 */
export async function speak(text, opts = {}) {
  cancelReply()
  if (agentActive) muteReplyUntilDone = true
  const result = await startSpeak(text, opts)
  const { finished: _finished, ...publicResult } = result
  return publicResult
}

function stopSpeechOnly() {
  speechGeneration++
  const st = speech
  speech = null
  if (!st) return false
  st.cancelled = true
  st.playing = false
  try {
    st.audio && st.audio.pause()
    if (st.audio) recoverRendererCatch('voice.pauseAudio')
  } catch (__err) { reportRendererCatch('voice.pauseAudio', CATCH_CLASS.PROMISE, __err) }
  releaseUrls(st)
  l2d.clearLipTrack()
  st.resolveFinished?.()
  stopSessionReported(st.sessionId, 'voice.stopSessionOnCancel')
  return true
}

/** 打断朗读（含还在创建中的会话和后续待念的句子）。 */
export function stopSpeaking() {
  cancelReply()
  if (agentActive) muteReplyUntilDone = true
  const stopped = stopSpeechOnly()
  markTrace('interruptedAt')
  return stopped
}

export function isSpeaking() {
  return !!speech
}

/* ---------------- 聆听（ASR 录音） ---------------- */

/** 当前录音：{ stream, recorder, chunks, startedAt, peak, timer } */
let rec = null
let recordingPending = null

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
  const pressedAt = performance.now()
  if (rec || recordingPending) return { ok: false, reason: '已在录音' }
  const request = { cancelled: false }
  recordingPending = request
  stopSpeaking() // 别让她一边说一边听自己
  const c = cfg()

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    if (recordingPending === request) recordingPending = null
    const msg = err && err.name === 'NotAllowedError' ? '麦克风被拒绝了（系统设置里允许一下）' : '拿不到麦克风：' + (err?.message || err)
    if (!request.cancelled) notice(msg)
    return { ok: false, error: msg }
  }
  if (request.cancelled) {
    stream.getTracks().forEach((track) => track.stop())
    if (recordingPending === request) recordingPending = null
    return { ok: false, reason: '已松开麦克风' }
  }
  try { await window.nagi.chat.abort(); recoverRendererCatch('voice.abortBeforeRecord') } catch (__err) {
    reportRendererCatch('voice.abortBeforeRecord', CATCH_CLASS.PROMISE, __err)
    if (!request.cancelled) notice('上一轮回复未停止，录音仍可继续')
  }
  if (request.cancelled) {
    stream.getTracks().forEach((track) => track.stop())
    if (recordingPending === request) recordingPending = null
    return { ok: false, reason: '已松开麦克风' }
  }
  voiceTrace = { pressedAt }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)
  )
  let recorder
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    if (recordingPending === request) recordingPending = null
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
  if (recordingPending === request) recordingPending = null

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
  } catch (__err) { reportRendererCatch('voice.analyser', CATCH_CLASS.DEGRADE, __err) }

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
  if (!cur) {
    if (recordingPending) {
      recordingPending.cancelled = true
      return { ok: false, reason: '麦克风尚未就绪，已取消' }
    }
    return { ok: false, reason: '没在录音' }
  }
  markTrace('releasedAt')
  rec = null
  setMicState(false)
  hint('')
  clearInterval(cur.timer)
  clearTimeout(cur.hardStop)
  if (cur.raf) cancelAnimationFrame(cur.raf)
  try {
    Promise.resolve(cur.analyser?.actx.close())
      .catch((err) => reportRendererCatch('voice.contextClose', CATCH_CLASS.DEGRADE, err))
  } catch (__err) { reportRendererCatch('voice.contextClose', CATCH_CLASS.DEGRADE, __err) }

  // 停录 → 等最后一片数据
  let stopError = false
  const done = new Promise((resolve) => {
    cur.recorder.onstop = resolve
    try {
      cur.recorder.stop()
    } catch (err) {
      reportRendererCatch('voice.recorderStop', CATCH_CLASS.SEMANTIC, err)
      stopError = true
      resolve()
    }
  })
  const heldMs = Date.now() - cur.startedAt
  try {
    await done
    recoverRendererCatch('voice.recorderWait')
  } catch (__err) {
    reportRendererCatch('voice.recorderWait', CATCH_CLASS.SEMANTIC, __err)
    stopError = true
  }
  cur.stream.getTracks().forEach((t) => t.stop())
  if (stopError) {
    notice('录音停止失败，请重试')
    return { ok: false, error: '录音停止失败' }
  }

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
  markTrace('wavReadyAt')

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
  markTrace('asrReadyAt')

  if (!r || !r.ok || !String(r.text || '').trim()) {
    notice('没听清，再说一次？')
    return { ok: false, error: r?.error || '没识别出内容' }
  }

  const text = String(r.text).trim()
  if (opts.send === false) return { ok: true, text, engine: r.engine }
  // 认到的话直接送进对话——这就是「按住说话」的意义
  if (!sendText(text)) {
    notice('上一句话还没处理完，请再说一次')
    return { ok: false, error: '上一轮对话尚未结束', text }
  }
  markTrace('chatSubmittedAt')
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
  if (rec || recordingPending) return stopRecording()
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
    } catch (__err) { reportRendererCatch('voice.pointerCapture', CATCH_CLASS.DEGRADE, __err) }
    startRecording()
  })
  const release = (e) => {
    if (!rec && !recordingPending) return
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

  // 首句一成形就合成，后续句按序播放；敏感场景由 Agent 先审后显，流式层不会提前收到违规文本。
  window.nagi.on(EVT.AGENT, (evt) => {
    if (!evt) return
    if (evt.type === AGENT_EVENT.STATUS && evt.state === 'thinking' && !agentActive) {
      if (!voiceTrace || voiceTrace.modelDoneAt != null || voiceTrace.interruptedAt != null) {
        voiceTrace = { chatSubmittedAt: performance.now() }
      }
      agentActive = true
      muteReplyUntilDone = false
      if (cfg().ttsEnabled && cfg().speakOnReply) beginReply()
      return
    }
    if (evt.type === AGENT_EVENT.ERROR) {
      agentActive = false
      muteReplyUntilDone = false
      cancelReply()
      stopSpeechOnly()
      return
    }
    const c = cfg()
    if (evt.type === AGENT_EVENT.TEXT_DELTA) {
      markTrace('firstModelTokenAt')
      if (c.ttsEnabled && c.speakOnReply) addReplyDelta(evt.text)
      return
    }
    if (evt.type === AGENT_EVENT.DONE) {
      markTrace('modelDoneAt')
      if (c.ttsEnabled && c.speakOnReply && evt.text) finishReply(evt.text)
      else { agentActive = false; muteReplyUntilDone = false; cancelReply() }
    }
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
    if (recordingPending) recordingPending.cancelled = true
    if (rec) {
      try { rec.recorder.stop(); recoverRendererCatch('voice.recordingCleanup') } catch (__err) { reportRendererCatch('voice.recordingCleanup', CATCH_CLASS.PROMISE, __err) }
      try { rec.stream.getTracks().forEach((t) => t.stop()) } catch (__err) {
        reportRendererCatch('voice.recordingTracks', CATCH_CLASS.PROMISE, __err)
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
    latencyTrace: () => voiceTrace ? { ...voiceTrace } : null,
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
